from __future__ import annotations

from typing import Any

from .contracts import (
    AgentRef,
    DatasetRef,
    ExperimentRef,
    ExperimentRunRequested,
    MockConfig,
    MockMatch,
    MockResponse,
    MockRule,
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
            rules: list[MockRule] = []
            for raw_rule in (mock_cfg.get("rules") or []):
                if not isinstance(raw_rule, dict):
                    continue
                raw_match = raw_rule.get("match") or {}
                raw_response = raw_rule.get("response") or {}
                if not isinstance(raw_match, dict) or not isinstance(raw_response, dict):
                    continue
                methods = raw_match.get("methods") or []
                rules.append(
                    MockRule(
                        name=str(raw_rule.get("name") or ""),
                        match=MockMatch(
                            methods=[str(m).upper() for m in methods if str(m).strip()] if isinstance(methods, list) else [],
                            url=str(raw_match.get("url")) if raw_match.get("url") else None,
                            url_regex=str(raw_match.get("url_regex")) if raw_match.get("url_regex") else None,
                            host=str(raw_match.get("host")) if raw_match.get("host") else None,
                            path=str(raw_match.get("path")) if raw_match.get("path") else None,
                            path_regex=str(raw_match.get("path_regex")) if raw_match.get("path_regex") else None,
                        ),
                        response=MockResponse(
                            type=str(raw_response.get("type") or "json"),
                            status=int(raw_response.get("status") or 200),
                            headers={str(k): str(v) for k, v in dict(raw_response.get("headers") or {}).items()},
                            json_body=raw_response.get("json"),
                            text_body=str(raw_response.get("text") or ""),
                            python_code=str(raw_response.get("python_code") or ""),
                        ),
                    )
                )
            parsed_mock = MockConfig(
                passthrough=bool(mock_cfg.get("passthrough", True)),
                rules=rules,
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
