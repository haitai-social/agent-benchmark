from __future__ import annotations

import pytest

from domain.contracts import AgentRef, DatasetRef, ExperimentRef, ExperimentRunRequested, RunCaseInput
from domain.contracts import MockConfig
from runtime.runtime_command_template import render_runtime_command_template


def _message() -> ExperimentRunRequested:
    return ExperimentRunRequested(
        message_type="experiment.run.requested",
        schema_version="1",
        message_id="msg-1",
        produced_at="2026-03-01T00:00:00Z",
        source={},
        experiment=ExperimentRef(id=75, triggered_by="user"),
        dataset=DatasetRef(id=12, name="OpenClaw OTEL Demo"),
        agent=AgentRef(
            id=33,
            name="MockOutput and OTEL",
            agent_key="mock-output-otel",
            version="v1",
            runtime_spec_json={},
        ),
        scorers=[],
        run_cases=[],
        consumer_hints={},
    )


def _run_case() -> RunCaseInput:
    return RunCaseInput(
        run_case_id=196,
        data_item_id=458,
        attempt_no=1,
        session_jsonl='[{"role":"user","content":"hello"}]',
        user_input="Open the browser",
        trace_id="trace-123",
        reference_trajectory=[],
        reference_output={},
        mock_config=MockConfig(),
    )


def test_render_runtime_command_template_renders_known_variables() -> None:
    rendered = render_runtime_command_template(
        template="echo {{experiment.id}} {{run_case.run_case_id}} {{mock.base_url}}",
        message=_message(),
        run_case=_run_case(),
        mock_base_url="http://127.0.0.1:18080",
    )
    assert rendered == "echo 75 196 http://127.0.0.1:18080"


def test_render_runtime_command_template_raises_on_unknown_variable() -> None:
    with pytest.raises(ValueError):
        render_runtime_command_template(
            template="echo {{run_case.missing}}",
            message=_message(),
            run_case=_run_case(),
            mock_base_url=None,
        )
