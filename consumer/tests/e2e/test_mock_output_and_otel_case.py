from __future__ import annotations

import importlib
import json
import os
import random
import time
import uuid
from datetime import datetime, timezone
from typing import Any, cast

import pytest

from app.message_processor import MessageProcessor
from domain.parser import parse_message
from infrastructure.config import load_settings
from infrastructure.db_repository import DbRepository
from infrastructure.docker_runner import DockerRunner
from infrastructure.otel_collector import OTelCollectorServer, OTelSpanStore
from infrastructure.trace_repository import TraceIngestRepository, TraceRepository
from runtime.inspect_runner import InspectRunner


class _NoopLock:
    def build_suffix(self, message_id: str, body: bytes) -> str:
        del body
        return message_id

    def already_processed(self, key_suffix: str) -> bool:
        del key_suffix
        return False

    def acquire_processing(self, key_suffix: str) -> bool:
        del key_suffix
        return True

    def release_processing(self, key_suffix: str) -> None:
        del key_suffix

    def mark_processed(self, key_suffix: str) -> None:
        del key_suffix


MOCK_AGENT_KEY = "mock-output-and-otel"
MOCK_AGENT_VERSION = "v1"


@pytest.mark.e2e
def test_mock_output_and_otel_trajectory_has_events() -> None:
    if not os.environ.get("MYSQL_SERVER"):
        pytest.skip("requires mysql envs from .env")

    os.environ.setdefault("CONSUMER_OTEL_ENABLED", "true")
    os.environ.setdefault("CONSUMER_OTEL_COLLECTOR_ENABLED", "true")
    os.environ.setdefault("CONSUMER_OTEL_PROTOCOL", "http/json")

    message, experiment_id = _create_dispatch_with_mock_agent()
    _run_direct(message)

    run_case = _poll_run_case(experiment_id, timeout_seconds=int(os.environ.get("ACCEPTANCE_TIMEOUT_SECONDS", "300")))
    assert str(run_case.get("status") or "") == "success"

    trajectory_raw = run_case.get("agent_trajectory")
    assert trajectory_raw, "agent_trajectory is empty"
    trajectory = trajectory_raw if isinstance(trajectory_raw, list) else json.loads(str(trajectory_raw))
    assert isinstance(trajectory, list) and trajectory, "agent_trajectory is not a non-empty list"

    event_steps = [step for step in trajectory if isinstance(step, dict) and isinstance(step.get("events"), list) and step.get("events")]
    assert event_steps, f"no trajectory step contains non-empty events, got={trajectory}"
    assert _trajectory_has_io_fields(trajectory), f"trajectory missing realistic step input/output fields, got={trajectory}"


def _mysql_password() -> str:
    return (os.environ.get("MYSQL_PASSWORD") or "").strip('"')


def _must_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing required env: {name}")
    return value


def _dict_cursor_class() -> Any:
    cursors_module = importlib.import_module("pymysql.cursors")
    return getattr(cursors_module, "DictCursor")


def _require_row(name: str, row: Any) -> dict[str, Any]:
    if not isinstance(row, dict) or not row:
        raise RuntimeError(f"missing row: {name}")
    return cast(dict[str, Any], row)


def _mock_runtime_spec() -> dict[str, Any]:
    case_exec_command = """
NOW_NS=$(($(date +%s)*1000000000));
MID1_NS=$((NOW_NS+150000000));
MID2_NS=$((NOW_NS+320000000));
END_NS=$((NOW_NS+520000000));
USER_QUERY="${BENCHMARK_USER_INPUT}";
if [ -z "${USER_QUERY}" ]; then
  USER_QUERY="今天有哪些 AI 新闻";
fi;
PAYLOAD=$(cat <<EOF
{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"${OTEL_SERVICE_NAME}"}},{"key":"benchmark.run_case_id","value":{"stringValue":"${BENCHMARK_RUN_CASE_ID}"}},{"key":"benchmark.data_item_id","value":{"stringValue":"${BENCHMARK_DATA_ITEM_ID}"}}]},"scopeSpans":[{"scope":{"name":"mock.agent"},"spans":[{"traceId":"71699f4302d7e3f3b2b67c8ef2ad64f1","spanId":"8f5b9a0d31d6a5ff","name":"web_search","startTimeUnixNano":"${NOW_NS}","endTimeUnixNano":"${MID1_NS}","status":{"code":"STATUS_CODE_OK"},"events":[{"name":"query.start","timeUnixNano":"${NOW_NS}","attributes":[{"key":"query","value":{"stringValue":"${USER_QUERY}"}},{"key":"top_k","value":{"intValue":"3"}}]},{"name":"query.result","timeUnixNano":"${MID1_NS}","attributes":[{"key":"results","value":{"stringValue":"[{\\\"title\\\":\\\"OpenAI release update\\\"},{\\\"title\\\":\\\"Anthropic enterprise agents\\\"},{\\\"title\\\":\\\"Cloud vendors launch eval suites\\\"}]"}}]}],"attributes":[{"key":"tool.name","value":{"stringValue":"web_search"}},{"key":"search.query","value":{"stringValue":"${USER_QUERY}"}}]},{"traceId":"71699f4302d7e3f3b2b67c8ef2ad64f1","spanId":"7a4b3c2d1e0f9a88","parentSpanId":"8f5b9a0d31d6a5ff","name":"file_read","startTimeUnixNano":"${MID1_NS}","endTimeUnixNano":"${MID2_NS}","status":{"code":"STATUS_CODE_OK"},"events":[{"name":"file.open","timeUnixNano":"${MID1_NS}","attributes":[{"key":"path","value":{"stringValue":"/workspace/news/ai_news_digest.json"}}]},{"name":"file.parsed","timeUnixNano":"${MID2_NS}","attributes":[{"key":"content_preview","value":{"stringValue":"Top stories: model upgrades, enterprise adoption, tooling maturity"}}]}],"attributes":[{"key":"tool.name","value":{"stringValue":"file_read"}},{"key":"file.path","value":{"stringValue":"/workspace/news/ai_news_digest.json"}}]},{"traceId":"71699f4302d7e3f3b2b67c8ef2ad64f1","spanId":"55aa33bb77cc11dd","parentSpanId":"7a4b3c2d1e0f9a88","name":"answer.compose","startTimeUnixNano":"${MID2_NS}","endTimeUnixNano":"${END_NS}","status":{"code":"STATUS_CODE_OK"},"events":[{"name":"draft.start","timeUnixNano":"${MID2_NS}","attributes":[{"key":"model","value":{"stringValue":"mock-kimi-k2.5"}}]},{"name":"draft.finish","timeUnixNano":"${END_NS}","attributes":[{"key":"final_answer","value":{"stringValue":"今天 AI 新闻聚焦在模型升级、企业级 Agent 能力增强以及评测工具链完善。"}}]}],"attributes":[{"key":"tool.name","value":{"stringValue":"llm.compose"}},{"key":"model.name","value":{"stringValue":"mock-kimi-k2.5"}}]}]}]}]}
EOF
);
curl -sS -X POST "${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT}" -H "Content-Type: application/json" --data "${PAYLOAD}" >/dev/null;
printf "{\\"output\\":{\\"question\\":\\"%s\\",\\"headlines\\":[\\"OpenAI 发布新推理模型更新\\",\\"Anthropic 发布企业级代理能力增强\\",\\"多家云厂商上线 AI Agent 评测套件\\"],\\"summary\\":\\"今日 AI 新闻主要集中在模型能力升级与 Agent 工具链完善。\\"}}\\n" "${USER_QUERY}"
""".strip()
    return {
        "runtime_type": "mock_output_otel",
        "agent_image": "curlimages/curl:8.7.1",
        "pull_policy": "if-not-present",
        "sandbox_start_command": "sleep 300",
        "case_exec_command": case_exec_command,
        "startup_timeout_seconds": 30,
        "startup_poll_interval_seconds": 1,
        "agent_env_template": {},
    }


def _create_dispatch_with_mock_agent() -> tuple[dict[str, Any], int]:
    import pymysql  # type: ignore[import-not-found]

    conn = pymysql.connect(
        host=_must_env("MYSQL_SERVER"),
        port=int(os.environ.get("MYSQL_PORT", "3306")),
        user=_must_env("MYSQL_USER"),
        password=_mysql_password(),
        database=_must_env("MYSQL_DB"),
        autocommit=False,
        cursorclass=_dict_cursor_class(),
    )

    try:
        with conn.cursor() as cur:
            runtime_spec = _mock_runtime_spec()
            cur.execute(
                """
                INSERT INTO agents
                (agent_key, version, name, description, docker_image, openapi_spec, status, metadata, runtime_spec_json,
                 created_by, updated_by, created_at, updated_at, is_deleted, deleted_at)
                VALUES (%s, %s, %s, %s, %s, %s, 'active', %s, %s, %s, %s, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, NULL)
                ON DUPLICATE KEY UPDATE
                  name = VALUES(name),
                  description = VALUES(description),
                  docker_image = VALUES(docker_image),
                  runtime_spec_json = VALUES(runtime_spec_json),
                  updated_by = VALUES(updated_by),
                  updated_at = CURRENT_TIMESTAMP,
                  is_deleted = 0,
                  deleted_at = NULL
                """,
                (
                    MOCK_AGENT_KEY,
                    MOCK_AGENT_VERSION,
                    "mock-output-and-otel",
                    "mock agent emits output and otel spans with events",
                    "curlimages/curl:8.7.1",
                    json.dumps({}, ensure_ascii=False),
                    json.dumps({}, ensure_ascii=False),
                    json.dumps(runtime_spec, ensure_ascii=False),
                    "e2e-test",
                    "e2e-test",
                ),
            )

            cur.execute(
                "SELECT id, name, agent_key, version, runtime_spec_json FROM agents WHERE agent_key = %s AND version = %s AND deleted_at IS NULL",
                (MOCK_AGENT_KEY, MOCK_AGENT_VERSION),
            )
            agent = _require_row("agent", cur.fetchone())

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
            max_evaluators = max(1, int(os.environ.get("ACCEPTANCE_MAX_EVALUATORS", "1")))
            if len(evaluators) > max_evaluators:
                rng = random.Random(int(os.environ.get("ACCEPTANCE_RANDOM_SEED", "20260228")))
                evaluators = rng.sample(evaluators, max_evaluators)

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
            max_data_items = max(1, int(os.environ.get("ACCEPTANCE_MAX_DATA_ITEMS", "1")))
            if len(items) > max_data_items:
                rng = random.Random(int(os.environ.get("ACCEPTANCE_RANDOM_SEED", "20260228")))
                items = rng.sample(items, max_data_items)

            created_by = os.environ.get("ACCEPTANCE_CREATED_BY", "e2e-test")
            exp_name = f"测试-otel-events-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
            cur.execute(
                """
                INSERT INTO experiments
                (name, dataset_id, agent_id, queue_status, queued_at, created_by, updated_by, created_at, updated_at)
                VALUES (%s, %s, %s, 'test_case', CURRENT_TIMESTAMP, %s, %s, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (exp_name, int(dataset["id"]), int(agent["id"]), created_by, created_by),
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

    collector: OTelCollectorServer | None = None
    if settings.otel_enabled and settings.otel_collector_enabled:
        trace_sink = TraceIngestRepository.from_settings(settings)
        span_store = OTelSpanStore(sink=trace_sink)
        collector = OTelCollectorServer(
            host=settings.otel_collector_host,
            port=settings.otel_collector_port,
            path=settings.otel_collector_path,
            store=span_store,
        )
        trajectory_source = span_store
    else:
        trajectory_source = TraceRepository.from_settings(settings)

    inspect_runner = InspectRunner(runner, settings=settings, trace_repository=trajectory_source)
    db = DbRepository.from_settings(settings)
    processor = MessageProcessor(settings=settings, runner=inspect_runner, lock=_NoopLock(), db=db)

    message = parse_message(message_payload)
    if collector:
        collector.start()
    try:
        processor._execute_cases(message)
    finally:
        if collector:
            collector.stop()


def _poll_run_case(experiment_id: int, timeout_seconds: int) -> dict[str, Any]:
    import pymysql  # type: ignore[import-not-found]

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
