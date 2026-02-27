from __future__ import annotations

from typing import Any

from .contracts import (
    AgentRef,
    DatasetRef,
    ExperimentRef,
    ExperimentRunRequested,
    MockConfig,
    MockRoute,
    RunCaseInput,
)


def parse_message(payload: dict[str, Any]) -> ExperimentRunRequested:
    schema_version = payload.get("schema_version", "v2")
    if schema_version != "v2":
        raise ValueError(f"E_UNSUPPORTED_SCHEMA_VERSION: {schema_version}")

    run_cases: list[RunCaseInput] = []
    for rc in payload.get("run_cases", []):
        mock_cfg = rc.get("mock_config")
        parsed_mock = None
        if isinstance(mock_cfg, dict):
            parsed_mock = MockConfig(
                base_url=mock_cfg.get("base_url", ""),
                headers=dict(mock_cfg.get("headers") or {}),
                routes=[
                    MockRoute(
                        path=r["path"],
                        method=r["method"],
                        status_code=int(r["status_code"]),
                        body=r.get("body", ""),
                        headers=dict(r.get("headers") or {}),
                    )
                    for r in mock_cfg.get("routes", [])
                ],
            )
        run_cases.append(
            RunCaseInput(
                run_case_id=int(rc["run_case_id"]),
                data_item_id=int(rc["data_item_id"]),
                attempt_no=int(rc["attempt_no"]),
                session_jsonl=rc["session_jsonl"],
                user_input=rc["user_input"],
                trace_id=rc.get("trace_id"),
                reference_trajectory=rc.get("reference_trajectory"),
                reference_output=rc.get("reference_output"),
                mock_config=parsed_mock,
            )
        )

    return ExperimentRunRequested(
        message_type=payload["message_type"],
        schema_version=schema_version,
        message_id=payload.get("message_id", ""),
        produced_at=payload.get("produced_at", ""),
        source=dict(payload.get("source") or {}),
        experiment=ExperimentRef(**payload["experiment"]),
        dataset=DatasetRef(**payload["dataset"]),
        agent=AgentRef(**payload["agent"]),
        scorers=list(payload.get("scorers") or []),
        run_cases=run_cases,
        consumer_hints=dict(payload.get("consumer_hints") or {}),
    )
