from __future__ import annotations

import pytest

from runtime.evaluator_client import EvaluatorCallInput, EvaluatorDataItem, EvaluatorRun
from runtime.evaluator_client import _render_prompt
from runtime.template_renderer import TemplateRenderError, render_as_template


def test_render_as_template_replaces_dot_path_variables() -> None:
    rendered = render_as_template(
        "input={{data_item.input}} output={{run.output}}",
        {
            "data_item": {"input": "hello"},
            "run": {"output": {"ok": True}},
        },
    )
    assert "input=hello" in rendered
    assert '"ok": true' in rendered


def test_render_as_template_raises_for_unknown_variable() -> None:
    with pytest.raises(TemplateRenderError):
        render_as_template("{{run.missing}}", {"run": {"output": "ok"}})


def test_evaluator_prompt_supports_data_item_and_run_macros() -> None:
    payload = EvaluatorCallInput(
        data_item=EvaluatorDataItem(
            id=9,
            input="what time is it",
            session="[]",
            trajectory=[{"step": 1, "name": "reference"}],
            output={"expected": "time"},
            trace_id="trace-x",
        ),
        run=EvaluatorRun(
            output={"final_answer": "12:00"},
            trajectory=[{"step": 1, "name": "query"}],
            status="success",
            logs="ok",
            latency_ms=1234,
        ),
        tools={},
    )
    prompt = _render_prompt(
        "data={{data_item.input}} run={{run.output}} traj={{run.trajectory}}",
        payload,
    )
    assert "data=what time is it" in prompt
    assert '"final_answer": "12:00"' in prompt
    assert '"name": "query"' in prompt
