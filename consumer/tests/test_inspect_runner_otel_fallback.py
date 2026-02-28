from domain.contracts import AgentRef, DatasetRef, ExperimentRef, ExperimentRunRequested, RunCaseInput
from runtime.inspect_runner import InspectRunner


class _FailingTraceRepo:
    def fetch_spans_by_run_case(self, *, run_case_id: int, start_ms: int, end_ms: int, limit: int = 1000):
        raise RuntimeError("query failed")


def test_otel_query_failure_falls_back_to_stdout_trajectory() -> None:
    runner = object.__new__(InspectRunner)
    runner._otel_enabled = True
    runner._otel_query_timeout_seconds = 1
    runner.trace_repository = _FailingTraceRepo()

    message = ExperimentRunRequested(
        message_type="experiment.run.requested",
        schema_version="v2",
        message_id="m1",
        produced_at="2026-02-28T00:00:00Z",
        source={},
        experiment=ExperimentRef(id=1, triggered_by="u"),
        dataset=DatasetRef(id=2, name="ds"),
        agent=AgentRef(id=3, name="agent", agent_key="k", version="v1", runtime_spec_json={}),
        scorers=[],
        run_cases=[],
        consumer_hints={},
    )
    run_case = RunCaseInput(
        run_case_id=10,
        data_item_id=20,
        attempt_no=1,
        session_jsonl="[]",
        user_input="hello",
        trace_id=None,
        reference_trajectory=[],
        reference_output={},
        mock_config=None,
    )
    fallback = [{"step": 1, "name": "stdout"}]

    got = runner._resolve_trajectory(
        message=message,
        run_case=run_case,
        run_case_id=10,
        started_ms=1000,
        finished_ms=2000,
        fallback_trajectory=fallback,
    )
    assert got == fallback
