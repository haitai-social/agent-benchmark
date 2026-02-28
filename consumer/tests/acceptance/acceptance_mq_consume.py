from __future__ import annotations

import importlib
import json
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
    message_id: str
    queue_status: str
    total_cases: int
    evaluator_count: int
    success_cases: int
    failed_cases: int
    score_rows: int
    evaluate_rows: int
    negative_score_rows: int
    null_final_scores: int
    negative_scores: int
    inspect_eval_count: int
    sample_output: Any
    sample_logs_head: str


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


def _create_dispatch() -> tuple[int, int, int, str]:
    try:
        import pika  # type: ignore[import-not-found]
        import pymysql  # type: ignore[import-not-found]
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
            dataset = _require_row("dataset", cur.fetchone() or {})
            if not dataset:
                raise RuntimeError("no dataset available")

            cur.execute(
                """
                SELECT id, name, agent_key, version, runtime_spec_json
                FROM agents
                WHERE deleted_at IS NULL
                ORDER BY id ASC
                LIMIT 1
                """
            )
            agent = _require_row("agent", cur.fetchone() or {})
            if not agent:
                raise RuntimeError("no agent available")

            cur.execute(
                """
                SELECT id, name, evaluator_key, prompt_template, base_url, model_name, api_style, api_key
                FROM evaluators
                WHERE deleted_at IS NULL
                  AND COALESCE(api_key, '') <> ''
                ORDER BY id ASC
                """
            )
            evaluators = [cast(dict[str, Any], row) for row in (cur.fetchall() or [])]
            if not evaluators:
                raise RuntimeError("no evaluator with non-empty api_key available")

            cur.execute(
                """
                SELECT id, session_jsonl, user_input, trace_id, reference_trajectory, reference_output
                FROM data_items
                WHERE dataset_id = %s AND deleted_at IS NULL
                ORDER BY created_at ASC
                """,
                (int(dataset["id"]),),
            )
            items = [cast(dict[str, Any], row) for row in (cur.fetchall() or [])]
            if not items:
                raise RuntimeError(f"no data_items for dataset={dataset['id']}")

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

            for evaluator in evaluators:
                cur.execute(
                    """
                    INSERT INTO experiment_evaluators (experiment_id, evaluator_id, created_at)
                    VALUES (%s, %s, CURRENT_TIMESTAMP)
                    """,
                    (experiment_id, int(evaluator["id"])),
                )

            run_cases_payload: list[dict[str, Any]] = []
            for item in items:
                cur.execute(
                    """
                    INSERT INTO run_cases
                    (experiment_id, data_item_id, agent_id, attempt_no, is_latest, status, created_at, updated_at)
                    VALUES (%s, %s, %s, 1, 1, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    """,
                    (experiment_id, int(item["id"]), int(agent["id"])),
                )
                run_case_id = int(cur.lastrowid)
                run_cases_payload.append(
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
                )
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
                    "scorer_config": {
                        "prompt_template": evaluator.get("prompt_template") or "",
                        "base_url": evaluator.get("base_url") or "",
                        "model_name": evaluator.get("model_name") or "",
                        "api_style": evaluator.get("api_style") or "openai",
                        "api_key": evaluator.get("api_key") or "",
                    },
                }
                for evaluator in evaluators
            ],
            "run_cases": run_cases_payload,
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
                properties=pika.BasicProperties(content_type="application/json", delivery_mode=2, message_id=message_id),
            )
        finally:
            rb_conn.close()

        with mysql_conn.cursor() as cur:
            cur.execute("UPDATE experiments SET queue_message_id = %s WHERE id = %s", (message_id, experiment_id))
        mysql_conn.commit()

        return experiment_id, len(run_cases_payload), len(evaluators), message_id
    finally:
        mysql_conn.close()


def _poll(experiment_id: int, total_cases: int, evaluator_count: int, message_id: str) -> AcceptanceResult:
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
                queue_status = str(_require_row("experiment", cur.fetchone() or {}).get("queue_status") or "")
                cur.execute(
                    """
                    SELECT
                      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_cases,
                      SUM(CASE WHEN status IN ('failed','timeout') THEN 1 ELSE 0 END) AS failed_cases,
                      SUM(CASE WHEN status IN ('success','failed','timeout') THEN 1 ELSE 0 END) AS done_cases,
                      SUM(CASE WHEN final_score IS NULL THEN 1 ELSE 0 END) AS null_final_scores,
                      SUM(CASE WHEN final_score < 0 THEN 1 ELSE 0 END) AS negative_scores,
                      SUM(CASE WHEN inspect_eval_id IS NOT NULL AND inspect_eval_id <> '' THEN 1 ELSE 0 END) AS inspect_eval_count
                    FROM run_cases
                    WHERE experiment_id = %s
                    """,
                    (experiment_id,),
                )
                summary = _require_row("summary", cur.fetchone() or {})

                done_cases = int(summary.get("done_cases") or 0)
                if done_cases >= total_cases and queue_status == "done":
                    cur.execute(
                        "SELECT COUNT(*) AS c FROM run_case_scores WHERE run_case_id IN (SELECT id FROM run_cases WHERE experiment_id = %s)",
                        (experiment_id,),
                    )
                    score_rows = int(_require_row("score_rows", cur.fetchone() or {}).get("c") or 0)
                    cur.execute(
                        "SELECT COUNT(*) AS c FROM run_case_scores WHERE score < 0 AND run_case_id IN (SELECT id FROM run_cases WHERE experiment_id = %s)",
                        (experiment_id,),
                    )
                    negative_score_rows = int(_require_row("negative_score_rows", cur.fetchone() or {}).get("c") or 0)
                    cur.execute(
                        "SELECT COUNT(*) AS c FROM evaluate_results WHERE run_case_id IN (SELECT id FROM run_cases WHERE experiment_id = %s)",
                        (experiment_id,),
                    )
                    evaluate_rows = int(_require_row("evaluate_rows", cur.fetchone() or {}).get("c") or 0)
                    cur.execute(
                        "SELECT agent_output, logs FROM run_cases WHERE experiment_id = %s ORDER BY id ASC LIMIT 1",
                        (experiment_id,),
                    )
                    sample = _require_row("sample", cur.fetchone() or {})

                    return AcceptanceResult(
                        ok=queue_status == "done" and int(summary.get("failed_cases") or 0) == 0,
                        experiment_id=experiment_id,
                        message_id=message_id,
                        queue_status=queue_status,
                        total_cases=total_cases,
                        evaluator_count=evaluator_count,
                        success_cases=int(summary.get("success_cases") or 0),
                        failed_cases=int(summary.get("failed_cases") or 0),
                        score_rows=score_rows,
                        evaluate_rows=evaluate_rows,
                        negative_score_rows=negative_score_rows,
                        null_final_scores=int(summary.get("null_final_scores") or 0),
                        negative_scores=int(summary.get("negative_scores") or 0),
                        inspect_eval_count=int(summary.get("inspect_eval_count") or 0),
                        sample_output=sample.get("agent_output"),
                        sample_logs_head=str(sample.get("logs") or "")[:1200],
                    )
            time.sleep(poll_interval_seconds)
    finally:
        conn.close()

    return AcceptanceResult(
        ok=False,
        experiment_id=experiment_id,
        message_id=message_id,
        queue_status="timeout",
        total_cases=total_cases,
        evaluator_count=evaluator_count,
        success_cases=0,
        failed_cases=total_cases,
        score_rows=0,
        evaluate_rows=0,
        negative_score_rows=total_cases * evaluator_count,
        null_final_scores=total_cases,
        negative_scores=total_cases,
        inspect_eval_count=0,
        sample_output=None,
        sample_logs_head="",
    )


def main() -> int:
    exp_id, total_cases, evaluator_count, message_id = _create_dispatch()
    print(
        json.dumps(
            {
                "phase": "dispatched",
                "experiment_id": exp_id,
                "total_cases": total_cases,
                "evaluator_count": evaluator_count,
                "message_id": message_id,
            },
            ensure_ascii=False,
        )
    )

    result = _poll(exp_id, total_cases, evaluator_count, message_id)
    print(
        json.dumps(
            {
                "phase": "completed",
                "ok": result.ok,
                "experiment_id": result.experiment_id,
                "message_id": result.message_id,
                "queue_status": result.queue_status,
                "total_cases": result.total_cases,
                "evaluator_count": result.evaluator_count,
                "success_cases": result.success_cases,
                "failed_cases": result.failed_cases,
                "score_rows": result.score_rows,
                "evaluate_rows": result.evaluate_rows,
                "negative_score_rows": result.negative_score_rows,
                "null_final_scores": result.null_final_scores,
                "negative_scores": result.negative_scores,
                "inspect_eval_count": result.inspect_eval_count,
                "sample_output": result.sample_output,
                "sample_logs_head": result.sample_logs_head,
            },
            ensure_ascii=False,
        )
    )

    if not result.ok:
        return 1
    if result.success_cases != result.total_cases:
        print("not all run_cases succeeded")
        return 1
    expected_rows = result.total_cases * result.evaluator_count
    if result.score_rows < expected_rows:
        print(f"missing run_case_scores rows: got={result.score_rows} expected>={expected_rows}")
        return 1
    if result.evaluate_rows < expected_rows:
        print(f"missing evaluate_results rows: got={result.evaluate_rows} expected>={expected_rows}")
        return 1
    if result.negative_score_rows != 0:
        print("some scorer rows are negative (default/fallback)")
        return 1
    if result.null_final_scores != 0:
        print("some run_cases have null final_score")
        return 1
    if result.negative_scores != 0:
        print("some run_cases have negative final_score (default/fallback)")
        return 1
    if result.inspect_eval_count != result.total_cases:
        print("some run_cases missing inspect_eval_id")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
