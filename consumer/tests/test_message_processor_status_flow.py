from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from app.message_processor import MessageProcessor
from domain.contracts import (
    AgentRef,
    CaseExecutionResult,
    DatasetRef,
    ExperimentRef,
    ExperimentRunRequested,
    RunCaseInput,
)


class _NoopLock:
    def build_suffix(self, message_id: str, body: bytes) -> str:
        return f"{message_id}:{len(body)}"

    def already_processed(self, suffix: str) -> bool:
        return False

    def acquire_processing(self, suffix: str) -> bool:
        return True

    def mark_processed(self, suffix: str) -> None:
        return None

    def release_processing(self, suffix: str) -> None:
        return None


class _DbStub:
    def __init__(self) -> None:
        self.events: list[tuple[Any, ...]] = []

    def mark_cases_queued(self, *, experiment_id: int, run_case_ids: list[int]) -> None:
        self.events.append(("queued", experiment_id, tuple(run_case_ids)))

    def mark_case_status(self, *, experiment_id: int, run_case_id: int, status: str) -> None:
        self.events.append(("status", experiment_id, run_case_id, status))

    def persist_case_result(self, *, experiment_id: int, run_case_id: int, result: CaseExecutionResult, runtime_snapshot: dict[str, Any]) -> None:
        self.events.append(("persist", experiment_id, run_case_id, result.status, bool(runtime_snapshot)))


class _RunnerStub:
    def runtime_snapshot(self, message: ExperimentRunRequested, run_case: RunCaseInput) -> dict[str, Any]:
        return {"run_case_id": run_case.run_case_id}

    def run_cases(
        self,
        message: ExperimentRunRequested,
        run_cases: list[RunCaseInput],
        progress_callback=None,
    ) -> dict[int, CaseExecutionResult]:
        results: dict[int, CaseExecutionResult] = {}
        for rc in run_cases:
            if progress_callback is not None:
                progress_callback(rc.run_case_id, "sandbox_connect")
                progress_callback(rc.run_case_id, "otel_query")
                progress_callback(rc.run_case_id, "score_exec")
                progress_callback(rc.run_case_id, "score_done")
            results[rc.run_case_id] = CaseExecutionResult(
                run_case_id=rc.run_case_id,
                status="success",
                trajectory=[{"step": 1}],
                output={"ok": True},
                scorer_results=[{"scorer_key": "task_success", "score": 1.0, "reason": "ok", "raw_result": {}}],
            )
        return results


def _build_message() -> ExperimentRunRequested:
    return ExperimentRunRequested(
        message_type="experiment.run.requested",
        schema_version="v1",
        message_id="msg-1",
        produced_at="2026-02-28T00:00:00Z",
        source={"service": "test"},
        experiment=ExperimentRef(id=101, triggered_by="tester"),
        dataset=DatasetRef(id=11, name="dataset"),
        agent=AgentRef(
            id=21,
            name="agent",
            agent_key="agent-key",
            version="v1",
            runtime_spec_json={},
        ),
        scorers=[],
        run_cases=[
            RunCaseInput(
                run_case_id=1,
                data_item_id=1001,
                attempt_no=1,
                session_jsonl="[]",
                user_input="u1",
                trace_id=None,
                reference_trajectory=None,
                reference_output=None,
            ),
            RunCaseInput(
                run_case_id=2,
                data_item_id=1002,
                attempt_no=1,
                session_jsonl="[]",
                user_input="u2",
                trace_id=None,
                reference_trajectory=None,
                reference_output=None,
            ),
        ],
        consumer_hints={},
    )


def test_message_processor_case_status_flows_from_queued_to_scoring() -> None:
    db = _DbStub()
    runner = _RunnerStub()
    settings = SimpleNamespace(max_message_retries=1, concurrent_cases=2)
    processor = MessageProcessor(settings=settings, runner=runner, lock=_NoopLock(), db=db)

    processor._execute_cases(_build_message())

    assert db.events[0] == ("queued", 101, (1, 2))
    assert ("status", 101, 1, "running") in db.events
    assert ("status", 101, 1, "trajectory") in db.events
    assert ("status", 101, 1, "scoring") in db.events
    assert ("status", 101, 2, "running") in db.events
    assert ("status", 101, 2, "trajectory") in db.events
    assert ("status", 101, 2, "scoring") in db.events
    assert ("persist", 101, 1, "success", True) in db.events
    assert ("persist", 101, 2, "success", True) in db.events
