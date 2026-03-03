from __future__ import annotations

from typing import Any

import runtime.inspect_runner as inspect_runner_module


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def time(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


class _LogsThenDataRepo:
    def __init__(self, *, ready_at: int) -> None:
        self.ready_at = ready_at
        self.log_calls = 0
        self.span_calls = 0

    def fetch_logs_by_run_case(self, **_: Any) -> list[dict[str, Any]]:
        self.log_calls += 1
        if self.log_calls >= self.ready_at:
            return [{"id": self.log_calls}]
        return []

    def fetch_spans_by_run_case(self, **_: Any) -> list[dict[str, Any]]:
        self.span_calls += 1
        return []


class _SpansThenDataRepo:
    def __init__(self, *, ready_at: int) -> None:
        self.ready_at = ready_at
        self.log_calls = 0
        self.span_calls = 0

    def fetch_logs_by_run_case(self, **_: Any) -> list[dict[str, Any]]:
        self.log_calls += 1
        return []

    def fetch_spans_by_run_case(self, **_: Any) -> list[dict[str, Any]]:
        self.span_calls += 1
        if self.span_calls >= self.ready_at:
            return [{"id": self.span_calls}]
        return []


class _NeverDataRepo:
    def __init__(self) -> None:
        self.log_calls = 0
        self.span_calls = 0

    def fetch_logs_by_run_case(self, **_: Any) -> list[dict[str, Any]]:
        self.log_calls += 1
        return []

    def fetch_spans_by_run_case(self, **_: Any) -> list[dict[str, Any]]:
        self.span_calls += 1
        return []


def test_collect_trajectory_from_otel_polls_until_logs_ready(monkeypatch) -> None:
    repo = _LogsThenDataRepo(ready_at=3)
    runner = object.__new__(inspect_runner_module.InspectRunner)
    runner.trace_repo = repo

    clock = _Clock()
    monkeypatch.setattr(inspect_runner_module.time, "time", clock.time)
    monkeypatch.setattr(inspect_runner_module.time, "sleep", clock.sleep)
    monkeypatch.setattr(
        inspect_runner_module,
        "map_logs_to_trajectory",
        lambda logs: [{"step": 1, "events": []}] if logs else [],
    )
    monkeypatch.setattr(inspect_runner_module, "map_spans_to_trajectory", lambda spans: [])

    trajectory = inspect_runner_module.InspectRunner._collect_trajectory_from_otel(runner, run_case_id=11)

    assert trajectory == [{"step": 1, "events": []}]
    assert repo.log_calls == 3
    assert repo.span_calls == 2


def test_collect_trajectory_from_otel_falls_back_to_spans(monkeypatch) -> None:
    repo = _SpansThenDataRepo(ready_at=2)
    runner = object.__new__(inspect_runner_module.InspectRunner)
    runner.trace_repo = repo

    clock = _Clock()
    monkeypatch.setattr(inspect_runner_module.time, "time", clock.time)
    monkeypatch.setattr(inspect_runner_module.time, "sleep", clock.sleep)
    monkeypatch.setattr(inspect_runner_module, "map_logs_to_trajectory", lambda logs: [])
    monkeypatch.setattr(
        inspect_runner_module,
        "map_spans_to_trajectory",
        lambda spans: [{"step": 1, "events": []}] if spans else [],
    )

    trajectory = inspect_runner_module.InspectRunner._collect_trajectory_from_otel(runner, run_case_id=22)

    assert trajectory == [{"step": 1, "events": []}]
    assert repo.log_calls == 2
    assert repo.span_calls == 2


def test_collect_trajectory_from_otel_returns_empty_after_timeout(monkeypatch) -> None:
    repo = _NeverDataRepo()
    runner = object.__new__(inspect_runner_module.InspectRunner)
    runner.trace_repo = repo

    clock = _Clock()
    monkeypatch.setattr(inspect_runner_module.time, "time", clock.time)
    monkeypatch.setattr(inspect_runner_module.time, "sleep", clock.sleep)
    monkeypatch.setattr(inspect_runner_module, "map_logs_to_trajectory", lambda logs: [])
    monkeypatch.setattr(inspect_runner_module, "map_spans_to_trajectory", lambda spans: [])
    monkeypatch.setattr(inspect_runner_module, "OTEL_COLLECT_RETRY_TIMEOUT_SECONDS", 1.0)
    monkeypatch.setattr(inspect_runner_module, "OTEL_COLLECT_RETRY_INTERVAL_SECONDS", 0.5)

    trajectory = inspect_runner_module.InspectRunner._collect_trajectory_from_otel(runner, run_case_id=33)

    assert trajectory == []
    assert repo.log_calls >= 2
    assert repo.span_calls >= 2
