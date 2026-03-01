from __future__ import annotations

import importlib
import json
import os
import random
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, cast
import pymysql

import pytest

from app.message_processor import MessageProcessor
from infrastructure.config import Settings, load_settings
from infrastructure.db_repository import DbRepository
from infrastructure.docker_runner import DockerRunner
from runtime.inspect_runner import InspectRunner


class _NoopLock:
    def build_suffix(self, message_id: str, payload_bytes: bytes) -> str:
        del payload_bytes
        return message_id

    def already_processed(self, suffix: str) -> bool:
        del suffix
        return False

    def acquire_processing(self, suffix: str) -> bool:
        del suffix
        return True

    def release_processing(self, suffix: str) -> None:
        del suffix

    def mark_processed(self, suffix: str) -> None:
        del suffix


# Mapping note for OpenClaw E2E:
# `openclaw-otel-cli` should use image `ghcr.io/haitai-social/agent-benchmark:openclaw-otel-demo`,
# which is built from `tests/openclaw-otel-demo/Dockerfile`.
MOCK_AGENT_KEY = os.getenv("ACCEPTANCE_AGENT_KEY", "mock-output-and-otel")
MOCK_AGENT_VERSION = os.getenv("ACCEPTANCE_AGENT_VERSION", "v1")
MOCK_AGENT_NAME = os.getenv("ACCEPTANCE_AGENT_NAME", "")

@dataclass(frozen=True)
class E2EOptions:
    timeout_seconds: int
    max_evaluators: int
    max_data_items: int
    random_seed: int
    created_by: str


def _load_test_options() -> E2EOptions:
    return E2EOptions(
        timeout_seconds=max(1, int(os.getenv("ACCEPTANCE_TIMEOUT_SECONDS", "300"))),
        max_evaluators=max(1, int(os.getenv("ACCEPTANCE_MAX_EVALUATORS", "1"))),
        max_data_items=max(1, int(os.getenv("ACCEPTANCE_MAX_DATA_ITEMS", "1"))),
        random_seed=int(os.getenv("ACCEPTANCE_RANDOM_SEED", "20260228")),
        created_by=os.getenv("ACCEPTANCE_CREATED_BY", "e2e-test"),
    )


@pytest.mark.e2e
def test_consume_a_mock_message_trajectory_has_events() -> None:
    try:
        settings = load_settings()
    except ValueError as exc:
        pytest.skip(f"requires runtime settings: {exc}")
    options = _load_test_options()
    if settings.database_engine != "mysql" or not settings.mysql_server or not settings.mysql_user or not settings.mysql_db:
        pytest.skip("requires mysql settings")

    message, experiment_id = _create_dispatch_with_mock_agent(settings=settings, options=options)
    _run_direct(message)

    run_case = _poll_run_case(settings=settings, experiment_id=experiment_id, timeout_seconds=options.timeout_seconds)
    assert str(run_case.get("status") or "") == "success"
    assert str(run_case.get("agent_output") or "").strip(), "agent_output is empty"

    trajectory_raw = run_case.get("agent_trajectory")
    assert trajectory_raw, "agent_trajectory is empty"
    trajectory = trajectory_raw if isinstance(trajectory_raw, list) else json.loads(str(trajectory_raw))
    assert isinstance(trajectory, list) and trajectory, "agent_trajectory is not a non-empty list"

    event_steps = [step for step in trajectory if isinstance(step, dict) and isinstance(step.get("events"), list) and step.get("events")]
    assert event_steps, f"no trajectory step contains non-empty events, got={trajectory}"
    assert _trajectory_has_io_fields(trajectory), f"trajectory missing realistic step input/output fields, got={trajectory}"
    assert _run_case_has_non_empty_trace_service(settings=settings, run_case_id=int(run_case["id"])), (
        f"trace service is empty for run_case_id={run_case['id']}"
    )
    assert _run_case_has_otel_logs(settings=settings, run_case_id=int(run_case["id"])), (
        f"otel_logs missing for run_case_id={run_case['id']}"
    )
    assert _experiment_has_duration(settings=settings, experiment_id=experiment_id), (
        f"experiment duration is missing for experiment_id={experiment_id}"
    )


def _dict_cursor_class() -> Any:
    cursors_module = importlib.import_module("pymysql.cursors")
    return getattr(cursors_module, "DictCursor")


def _require_row(name: str, row: Any) -> dict[str, Any]:
    if not isinstance(row, dict) or not row:
        raise RuntimeError(f"missing row: {name}")
    return cast(dict[str, Any], row)


def _create_dispatch_with_mock_agent(*, settings: Settings, options: E2EOptions) -> tuple[dict[str, Any], int]:
    mysql_server = settings.mysql_server
    mysql_user = settings.mysql_user
    mysql_db = settings.mysql_db
    if not mysql_server or not mysql_user or not mysql_db:
        raise RuntimeError("missing mysql settings")

    conn = pymysql.connect(
        host=mysql_server,
        port=settings.mysql_port,
        user=mysql_user,
        password=(settings.mysql_password or "").strip('"'),
        database=mysql_db,
        autocommit=False,
        cursorclass=_dict_cursor_class(),
    )

    try:
        with conn.cursor() as cur:
            agent: dict[str, Any] | None = None
            if MOCK_AGENT_KEY and MOCK_AGENT_VERSION:
                cur.execute(
                    """
                    SELECT id, name, agent_key, version, runtime_spec_json
                    FROM agents
                    WHERE deleted_at IS NULL
                      AND agent_key = %s
                      AND version = %s
                    ORDER BY id DESC
                    LIMIT 1
                    """,
                    (MOCK_AGENT_KEY, MOCK_AGENT_VERSION),
                )
                row = cur.fetchone()
                if isinstance(row, dict) and row:
                    agent = cast(dict[str, Any], row)
            if agent is None and MOCK_AGENT_KEY:
                cur.execute(
                    """
                    SELECT id, name, agent_key, version, runtime_spec_json
                    FROM agents
                    WHERE deleted_at IS NULL
                      AND agent_key = %s
                    ORDER BY id DESC
                    LIMIT 1
                    """,
                    (MOCK_AGENT_KEY,),
                )
                row = cur.fetchone()
                if isinstance(row, dict) and row:
                    agent = cast(dict[str, Any], row)
            if agent is None and MOCK_AGENT_NAME:
                cur.execute(
                    """
                    SELECT id, name, agent_key, version, runtime_spec_json
                    FROM agents
                    WHERE deleted_at IS NULL
                      AND name = %s
                    ORDER BY id DESC
                    LIMIT 1
                    """,
                    (MOCK_AGENT_NAME,),
                )
                row = cur.fetchone()
                if isinstance(row, dict) and row:
                    agent = cast(dict[str, Any], row)
            agent = _require_row("agent", agent)
            runtime_spec = agent.get("runtime_spec_json")
            if isinstance(runtime_spec, str):
                runtime_spec = json.loads(runtime_spec)
            if not isinstance(runtime_spec, dict):
                raise RuntimeError("selected agent runtime_spec_json is invalid")

            cur.execute("SELECT id, name FROM datasets WHERE deleted_at IS NULL ORDER BY id ASC LIMIT 1")
            dataset = _require_row("dataset", cur.fetchone())

            cur.execute(
                """
                SELECT id, name, evaluator_key, prompt_template, base_url, model_name, api_style, api_key
                FROM evaluators
                WHERE deleted_at IS NULL AND COALESCE(api_key, '') <> ''
                ORDER BY id ASC
                """
            )
            evaluators = [cast(dict[str, Any], row) for row in (cur.fetchall() or [])]
            if not evaluators:
                raise RuntimeError("no evaluator with non-empty api_key available")
            if len(evaluators) > options.max_evaluators:
                rng = random.Random(options.random_seed)
                evaluators = rng.sample(evaluators, options.max_evaluators)

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
            if len(items) > options.max_data_items:
                rng = random.Random(options.random_seed)
                items = rng.sample(items, options.max_data_items)

            exp_name = f"测试-otel-events-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
            cur.execute(
                """
                INSERT INTO experiments
                (name, dataset_id, agent_id, queue_status, queued_at, created_by, updated_by, created_at, updated_at)
                VALUES (%s, %s, %s, 'test_case', CURRENT_TIMESTAMP, %s, %s, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (exp_name, int(dataset["id"]), int(agent["id"]), options.created_by, options.created_by),
            )
            experiment_id = int(cur.lastrowid)

            for evaluator in evaluators:
                cur.execute(
                    "INSERT INTO experiment_evaluators (experiment_id, evaluator_id, created_at) VALUES (%s, %s, CURRENT_TIMESTAMP)",
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

            message_id = str(uuid.uuid4())
            message = {
                "message_type": "experiment.run.requested",
                "schema_version": "v2",
                "message_id": message_id,
                "produced_at": datetime.now(timezone.utc).isoformat(),
                "source": {"service": "e2e-direct", "queue": "direct"},
                "experiment": {"id": experiment_id, "triggered_by": "test_case"},
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
            cur.execute("UPDATE experiments SET queue_message_id = %s WHERE id = %s", (message_id, experiment_id))

        conn.commit()
        return message, experiment_id
    finally:
        conn.close()


def _run_direct(message_payload: dict[str, Any]) -> None:
    settings = load_settings()
    runner = DockerRunner(
        timeout_seconds=settings.case_timeout_seconds,
        docker_network=settings.docker_network,
        agent_exec_command=settings.agent_exec_command,
        pull_policy=settings.docker_pull_policy,
        pull_timeout_seconds=settings.docker_pull_timeout_seconds,
        run_timeout_seconds=settings.docker_run_timeout_seconds,
        inspect_timeout_seconds=settings.docker_inspect_timeout_seconds,
    )

    inspect_runner = InspectRunner(runner, settings=settings)
    db = DbRepository.from_settings(settings)
    processor = MessageProcessor(settings=settings, runner=inspect_runner, lock=_NoopLock(), db=db)

    body = json.dumps(message_payload, ensure_ascii=False).encode("utf-8")
    processor.handle_raw_message(body)


def _run_case_has_non_empty_trace_service(*, settings: Settings, run_case_id: int) -> bool:
    mysql_server = settings.mysql_server
    mysql_user = settings.mysql_user
    mysql_db = settings.mysql_db
    if not mysql_server or not mysql_user or not mysql_db:
        raise RuntimeError("missing mysql settings")

    conn = pymysql.connect(
        host=mysql_server,
        port=settings.mysql_port,
        user=mysql_user,
        password=(settings.mysql_password or "").strip('"'),
        database=mysql_db,
        autocommit=True,
        cursorclass=_dict_cursor_class(),
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                  service_name AS svc
                FROM otel_traces
                WHERE is_deleted = 0
                  AND run_case_id = %s
                ORDER BY id ASC
                """,
                (int(run_case_id),),
            )
            rows = cur.fetchall() or []
            if not rows:
                return False
            for row in rows:
                if isinstance(row, dict) and str(row.get("svc") or "").strip():
                    return True
            return False
    finally:
        conn.close()


def _run_case_has_otel_logs(*, settings: Settings, run_case_id: int) -> bool:
    mysql_server = settings.mysql_server
    mysql_user = settings.mysql_user
    mysql_db = settings.mysql_db
    if not mysql_server or not mysql_user or not mysql_db:
        raise RuntimeError("missing mysql settings")

    conn = pymysql.connect(
        host=mysql_server,
        port=settings.mysql_port,
        user=mysql_user,
        password=(settings.mysql_password or "").strip('"'),
        database=mysql_db,
        autocommit=True,
        cursorclass=_dict_cursor_class(),
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*) AS c
                FROM otel_logs
                WHERE is_deleted = 0
                  AND run_case_id = %s
                """,
                (int(run_case_id),),
            )
            row = _require_row("otel_logs", cur.fetchone())
            return int(row.get("c") or 0) > 0
    finally:
        conn.close()


def _poll_run_case(*, settings: Settings, experiment_id: int, timeout_seconds: int) -> dict[str, Any]:
    import pymysql  # type: ignore[import-not-found]

    mysql_server = settings.mysql_server
    mysql_user = settings.mysql_user
    mysql_db = settings.mysql_db
    if not mysql_server or not mysql_user or not mysql_db:
        raise RuntimeError("missing mysql settings")

    deadline = time.time() + timeout_seconds
    conn = pymysql.connect(
        host=mysql_server,
        port=settings.mysql_port,
        user=mysql_user,
        password=(settings.mysql_password or "").strip('"'),
        database=mysql_db,
        autocommit=True,
        cursorclass=_dict_cursor_class(),
    )

    try:
        while time.time() < deadline:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, status, agent_trajectory, agent_output, logs FROM run_cases WHERE experiment_id = %s ORDER BY id ASC LIMIT 1",
                    (experiment_id,),
                )
                row = _require_row("run_case", cur.fetchone())
                status = str(row.get("status") or "")
                if status in {"success", "failed", "timeout"}:
                    return row
            time.sleep(2)
    finally:
        conn.close()

    raise TimeoutError(f"run_case did not finish in {timeout_seconds}s, experiment_id={experiment_id}")


def _experiment_has_duration(*, settings: Settings, experiment_id: int) -> bool:
    mysql_server = settings.mysql_server
    mysql_user = settings.mysql_user
    mysql_db = settings.mysql_db
    if not mysql_server or not mysql_user or not mysql_db:
        raise RuntimeError("missing mysql settings")

    conn = pymysql.connect(
        host=mysql_server,
        port=settings.mysql_port,
        user=mysql_user,
        password=(settings.mysql_password or "").strip('"'),
        database=mysql_db,
        autocommit=True,
        cursorclass=_dict_cursor_class(),
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT started_at, finished_at
                FROM experiments
                WHERE id = %s
                LIMIT 1
                """,
                (int(experiment_id),),
            )
            row = _require_row("experiment", cur.fetchone())
            return row.get("started_at") is not None and row.get("finished_at") is not None
    finally:
        conn.close()


def _trajectory_has_io_fields(trajectory: list[dict[str, Any]]) -> bool:
    keys = {"query", "results", "path", "content_preview", "final_answer"}
    for step in trajectory:
        events = step.get("events")
        if not isinstance(events, list):
            continue
        for event in events:
            if not isinstance(event, dict):
                continue
            attrs = event.get("attributes")
            if isinstance(attrs, list):
                found = set()
                for item in attrs:
                    if isinstance(item, dict):
                        key = item.get("key")
                        if isinstance(key, str):
                            found.add(key)
                if keys.intersection(found):
                    return True
    return False
