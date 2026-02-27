from __future__ import annotations

import json
import importlib
import os
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, cast


@dataclass
class AcceptanceResult:
    ok: bool
    experiment_id: int
    run_case_id: int
    message_id: str
    queue_status: str
    run_case_status: str
    error_message: str
    agent_output: Any
    inspect_eval_id: str
    logs_head: str


def _mysql_password() -> str:
    return (os.environ.get("MYSQL_PASSWORD") or "").strip('"')


def _must_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing required env: {name}")
    return value


def _require_row(name: str, row: Any) -> dict[str, Any]:
    if not isinstance(row, dict):
        raise RuntimeError(f"{name} query did not return dict row")
    return cast(dict[str, Any], row)


def _dict_cursor_class() -> Any:
    cursors_module = importlib.import_module("pymysql.cursors")
    return getattr(cursors_module, "DictCursor")


def _create_dispatch() -> tuple[int, int, str]:
    try:
        import pymysql  # type: ignore[import-not-found]
        import pika  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("pymysql and pika are required") from exc

    mysql_conn = pymysql.connect(
        host=_must_env("MYSQL_SERVER"),
        port=int(os.environ.get("MYSQL_PORT", "3306")),
        user=_must_env("MYSQL_USER"),
        password=_mysql_password(),
        database=_must_env("MYSQL_DB"),
        autocommit=False,
        cursorclass=_dict_cursor_class(),
    )

    try:
        with mysql_conn.cursor() as cur:
            cur.execute("SELECT id, name FROM datasets WHERE deleted_at IS NULL ORDER BY id ASC LIMIT 1")
            raw_dataset = cur.fetchone()
            if raw_dataset is None:
                raise RuntimeError("no dataset available")
            dataset = _require_row("dataset", raw_dataset)

            cur.execute(
                """
                SELECT id, name, agent_key, version, runtime_spec_json
                FROM agents
                WHERE deleted_at IS NULL
                ORDER BY id ASC
                LIMIT 1
                """
            )
            raw_agent = cur.fetchone()
            if raw_agent is None:
                raise RuntimeError("no agent available")
            agent = _require_row("agent", raw_agent)

            cur.execute(
                """
                SELECT id, name, evaluator_key
                FROM evaluators
                WHERE deleted_at IS NULL
                ORDER BY id ASC
                LIMIT 1
                """
            )
            raw_evaluator = cur.fetchone()
            if raw_evaluator is None:
                raise RuntimeError("no evaluator available")
            evaluator = _require_row("evaluator", raw_evaluator)

            cur.execute(
                """
                SELECT id, session_jsonl, user_input, trace_id, reference_trajectory, reference_output
                FROM data_items
                WHERE dataset_id = %s AND deleted_at IS NULL
                ORDER BY created_at ASC
                LIMIT 1
                """,
                (int(dataset["id"]),),
            )
            raw_item = cur.fetchone()
            if raw_item is None:
                raise RuntimeError(f"no data_items for dataset={dataset['id']}")
            item = _require_row("data_item", raw_item)

            created_by = os.environ.get("ACCEPTANCE_CREATED_BY", "acceptance-script")
            exp_name = f"验收-mq-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
            cur.execute(
                """
                INSERT INTO experiments
                (name, dataset_id, agent_id, queue_status, queued_at, created_by, updated_by, created_at, updated_at)
                VALUES (%s, %s, %s, 'queued', CURRENT_TIMESTAMP, %s, %s, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (exp_name, int(dataset["id"]), int(agent["id"]), created_by, created_by),
            )
            experiment_id = int(cur.lastrowid)
            cur.execute(
                """
                INSERT INTO experiment_evaluators (experiment_id, evaluator_id, created_at)
                VALUES (%s, %s, CURRENT_TIMESTAMP)
                """,
                (experiment_id, int(evaluator["id"])),
            )
            cur.execute(
                """
                INSERT INTO run_cases
                (experiment_id, data_item_id, agent_id, attempt_no, is_latest, status, created_at, updated_at)
                VALUES (%s, %s, %s, 1, 1, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (experiment_id, int(item["id"]), int(agent["id"])),
            )
            run_case_id = int(cur.lastrowid)
        mysql_conn.commit()

        queue_name = os.environ.get("RABBITMQ_EXPERIMENT_QUEUE", "haitai.agent.benchmark.experiment")
        message_id = str(uuid.uuid4())
        message = {
            "message_type": "experiment.run.requested",
            "schema_version": "v2",
            "message_id": message_id,
            "produced_at": datetime.now(timezone.utc).isoformat(),
            "source": {"service": "acceptance-script", "queue": queue_name},
            "experiment": {"id": experiment_id, "triggered_by": "acceptance"},
            "dataset": {"id": int(dataset["id"]), "name": dataset["name"]},
            "agent": {
                "id": int(agent["id"]),
                "name": agent["name"],
                "agent_key": agent["agent_key"],
                "version": agent["version"],
                "runtime_spec_json": agent["runtime_spec_json"]
                if isinstance(agent["runtime_spec_json"], dict)
                else json.loads(agent["runtime_spec_json"]),
            },
            "scorers": [
                {
                    "id": int(evaluator["id"]),
                    "scorer_key": evaluator["evaluator_key"],
                    "name": evaluator["name"],
                    "scorer_config": {},
                }
            ],
            "run_cases": [
                {
                    "run_case_id": run_case_id,
                    "data_item_id": int(item["id"]),
                    "attempt_no": 1,
                    "session_jsonl": item.get("session_jsonl") or "",
                    "user_input": item.get("user_input") or "",
                    "trace_id": item.get("trace_id"),
                    "reference_trajectory": item.get("reference_trajectory"),
                    "reference_output": item.get("reference_output"),
                }
            ],
            "consumer_hints": {
                "should_start_agent_container": True,
                "should_emit_case_trajectory": True,
                "should_emit_case_output": True,
                "should_persist_evaluate_results": True,
            },
        }

        rabbit_url = (
            f"amqp://{_must_env('RABBITMQ_USER')}:{_must_env('RABBITMQ_PASSWORD')}"
            f"@{_must_env('RABBITMQ_HOST')}:{os.environ.get('RABBITMQ_PORT', '5672')}/%2F"
        )
        rb_conn = pika.BlockingConnection(pika.URLParameters(rabbit_url))
        try:
            ch = rb_conn.channel()
            ch.queue_declare(queue=queue_name, durable=True)
            ch.basic_publish(
                exchange="",
                routing_key=queue_name,
                body=json.dumps(message, ensure_ascii=False).encode("utf-8"),
                properties=pika.BasicProperties(
                    content_type="application/json",
                    delivery_mode=2,
                    message_id=message_id,
                ),
            )
        finally:
            rb_conn.close()

        with mysql_conn.cursor() as cur:
            cur.execute(
                "UPDATE experiments SET queue_message_id = %s WHERE id = %s",
                (message_id, experiment_id),
            )
        mysql_conn.commit()

        return experiment_id, run_case_id, message_id
    finally:
        mysql_conn.close()


def _poll(experiment_id: int, run_case_id: int, message_id: str) -> AcceptanceResult:
    try:
        import pymysql  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("pymysql is required") from exc

    timeout_seconds = int(os.environ.get("ACCEPTANCE_TIMEOUT_SECONDS", "300"))
    poll_interval_seconds = float(os.environ.get("ACCEPTANCE_POLL_INTERVAL_SECONDS", "3"))
    deadline = time.time() + timeout_seconds

    conn = pymysql.connect(
        host=_must_env("MYSQL_SERVER"),
        port=int(os.environ.get("MYSQL_PORT", "3306")),
        user=_must_env("MYSQL_USER"),
        password=_mysql_password(),
        database=_must_env("MYSQL_DB"),
        autocommit=True,
        cursorclass=_dict_cursor_class(),
    )

    try:
        while time.time() < deadline:
            with conn.cursor() as cur:
                cur.execute("SELECT queue_status FROM experiments WHERE id = %s", (experiment_id,))
                exp = _require_row("experiment_status", cur.fetchone() or {})
                cur.execute(
                    "SELECT status, error_message, agent_output, inspect_eval_id, logs FROM run_cases WHERE id = %s",
                    (run_case_id,),
                )
                case = _require_row("run_case", cur.fetchone() or {})

            queue_status = str(exp.get("queue_status") or "")
            run_case_status = str(case.get("status") or "")
            if run_case_status in {"success", "failed", "timeout"}:
                return AcceptanceResult(
                    ok=run_case_status == "success",
                    experiment_id=experiment_id,
                    run_case_id=run_case_id,
                    message_id=message_id,
                    queue_status=queue_status,
                    run_case_status=run_case_status,
                    error_message=str(case.get("error_message") or ""),
                    agent_output=case.get("agent_output"),
                    inspect_eval_id=str(case.get("inspect_eval_id") or ""),
                    logs_head=str(case.get("logs") or "")[:1200],
                )
            time.sleep(poll_interval_seconds)
    finally:
        conn.close()

    return AcceptanceResult(
        ok=False,
        experiment_id=experiment_id,
        run_case_id=run_case_id,
        message_id=message_id,
        queue_status="timeout",
        run_case_status="timeout",
        error_message=f"timeout waiting for completion ({timeout_seconds}s)",
        agent_output=None,
        inspect_eval_id="",
        logs_head="",
    )


def main() -> int:
    exp_id, run_case_id, message_id = _create_dispatch()
    print(
        json.dumps(
            {
                "phase": "dispatched",
                "experiment_id": exp_id,
                "run_case_id": run_case_id,
                "message_id": message_id,
            },
            ensure_ascii=False,
        )
    )

    result = _poll(exp_id, run_case_id, message_id)
    print(
        json.dumps(
            {
                "phase": "completed",
                "ok": result.ok,
                "experiment_id": result.experiment_id,
                "run_case_id": result.run_case_id,
                "message_id": result.message_id,
                "queue_status": result.queue_status,
                "run_case_status": result.run_case_status,
                "error_message": result.error_message,
                "inspect_eval_id": result.inspect_eval_id,
                "agent_output": result.agent_output,
                "logs_head": result.logs_head,
            },
            ensure_ascii=False,
        )
    )
    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(main())
