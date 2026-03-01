from __future__ import annotations

from dataclasses import asdict
import re
from typing import Any

from domain.contracts import ExperimentRunRequested, RunCaseInput
from runtime.template_catalog import list_template_variable_paths
from runtime.template_renderer import render_as_template

_PLACEHOLDER_PATTERN = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_\.]*)\s*\}\}")
_AGENT_RUNTIME_COMMAND_VARIABLES = set(list_template_variable_paths("agent_runtime_commands"))


def build_runtime_command_context(
    *,
    message: ExperimentRunRequested,
    run_case: RunCaseInput,
    mock_base_url: str | None,
) -> dict[str, Any]:
    experiment_data = asdict(message.experiment)
    dataset_data = asdict(message.dataset)
    agent_data = asdict(message.agent)
    run_case_data = asdict(run_case)
    run_case_data["trace_id"] = run_case.trace_id or ""
    return {
        "experiment": experiment_data,
        "dataset": dataset_data,
        "agent": agent_data,
        "run_case": run_case_data,
        "mock": {
            "base_url": mock_base_url or "",
        },
    }


def render_runtime_command_template(
    *,
    template: str,
    message: ExperimentRunRequested,
    run_case: RunCaseInput,
    mock_base_url: str | None,
) -> str:
    raw = (template or "").strip()
    if not raw:
        return ""
    _assert_template_variables_declared(raw)
    context = build_runtime_command_context(
        message=message,
        run_case=run_case,
        mock_base_url=mock_base_url,
    )
    rendered = render_as_template(raw, context).strip()
    return rendered


def _assert_template_variables_declared(template: str) -> None:
    for matched in _PLACEHOLDER_PATTERN.findall(template):
        if matched not in _AGENT_RUNTIME_COMMAND_VARIABLES:
            raise ValueError(f"E_RUNTIME_COMMAND_TEMPLATE_VARIABLE_NOT_DECLARED: {matched}")
