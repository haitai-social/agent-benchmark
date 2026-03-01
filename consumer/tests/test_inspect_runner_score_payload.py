from __future__ import annotations

from typing import Any

from domain.contracts import CaseExecutionResult, RunCaseInput
from infrastructure.config import Settings
from infrastructure.docker_runner import DockerRunner
from runtime.inspect_runner import InspectRunner


def _settings() -> Settings:
    return Settings(
        rabbitmq_host="127.0.0.1",
        rabbitmq_port=5672,
        rabbitmq_user="guest",
        rabbitmq_password="guest",
        rabbitmq_vhost="/",
        rabbitmq_experiment_queue="q",
        concurrent_cases=1,
        scorer_concurrent_cases=1,
        max_message_retries=1,
        case_timeout_seconds=120,
        docker_network=None,
        agent_exec_command=None,
        docker_pull_policy="never",
        docker_pull_timeout_seconds=30,
        docker_run_timeout_seconds=30,
        docker_inspect_timeout_seconds=10,
        redis_host="127.0.0.1",
        redis_port=6379,
        redis_username=None,
        redis_password=None,
        redis_db=0,
        redis_processing_lock_ttl_seconds=300,
        redis_processed_ttl_seconds=86400,
        database_engine="postgres",
        postgres_server=None,
        postgres_port=5432,
        postgres_user=None,
        postgres_password=None,
        postgres_db=None,
        mysql_server=None,
        mysql_port=3306,
        mysql_user=None,
        mysql_password=None,
        mysql_db=None,
        evaluator_timeout_seconds=30,
        evaluator_connect_timeout_seconds=5,
        evaluator_read_timeout_seconds=30,
        evaluator_max_retries=0,
        evaluator_retry_backoff_seconds=0.0,
        scorer_hard_timeout_seconds=60,
    )


def test_score_case_passes_data_item_and_run_context(monkeypatch) -> None:
    docker_runner = DockerRunner(
        timeout_seconds=120,
        docker_network=None,
        agent_exec_command=None,
        pull_policy="never",
        pull_timeout_seconds=30,
        run_timeout_seconds=30,
        inspect_timeout_seconds=10,
    )
    runner = InspectRunner(docker_runner=docker_runner, settings=_settings())

    captured: dict[str, Any] = {}

    def _fake_call_evaluator(**kwargs: Any) -> tuple[float, str, dict[str, Any]]:
        captured["payload"] = kwargs["payload"]
        return 1.0, "ok", {"ok": True}

    monkeypatch.setattr("runtime.inspect_runner.call_evaluator", _fake_call_evaluator)

    run_case = RunCaseInput(
        run_case_id=1,
        data_item_id=100,
        attempt_no=1,
        session_jsonl='[{"type":"message"}]',
        user_input="hello",
        trace_id="trace-1",
        reference_trajectory=[{"step": 1, "name": "reference"}],
        reference_output={"target": "done"},
        mock_config=None,
    )
    result = CaseExecutionResult(
        run_case_id=1,
        status="success",
        trajectory=[{"step": 1, "name": "actual"}],
        output={"answer": "done"},
        logs="case logs",
        latency_ms=88,
    )
    scorer_spec = {
        "scorer_config": {
            "base_url": "https://example.com/v1/chat/completions",
            "api_key": "k",
            "model_name": "m",
            "prompt_template": "{{run.trajectory}}",
            "api_style": "openai",
        }
    }

    score, reason, raw = runner._score_case("task_success", run_case, result, scorer_spec)
    assert score == 1.0
    assert reason == "ok"
    assert raw["source"] == "llm"

    payload = captured["payload"]
    assert payload.data_item.id == 100
    assert payload.data_item.input == "hello"
    assert payload.data_item.session == '[{"type":"message"}]'
    assert payload.data_item.trajectory == [{"step": 1, "name": "reference"}]
    assert payload.data_item.output == {"target": "done"}
    assert payload.data_item.trace_id == "trace-1"
    assert payload.run.output == {"answer": "done"}
    assert payload.run.trajectory == [{"step": 1, "name": "actual"}]
    assert payload.run.status == "success"
    assert payload.run.logs == "case logs"
    assert payload.run.latency_ms == 88
