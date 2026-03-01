from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class MockMatch:
    methods: list[str] = field(default_factory=list)
    url: str | None = None
    url_regex: str | None = None
    host: str | None = None
    path: str | None = None
    path_regex: str | None = None


@dataclass
class MockResponse:
    type: str = "json"  # json | text | python
    status: int = 200
    headers: dict[str, str] = field(default_factory=dict)
    json_body: Any = None
    text_body: str = ""
    python_code: str = ""


@dataclass
class MockRule:
    name: str = ""
    match: MockMatch = field(default_factory=MockMatch)
    response: MockResponse = field(default_factory=MockResponse)


@dataclass
class MockConfig:
    passthrough: bool = True
    rules: list[MockRule] = field(default_factory=list)


@dataclass
class RunCaseInput:
    run_case_id: int
    data_item_id: int
    attempt_no: int
    session_jsonl: str
    user_input: str
    trace_id: str | None
    reference_trajectory: Any
    reference_output: Any
    mock_config: MockConfig | None = None


@dataclass
class AgentRef:
    id: int
    name: str
    agent_key: str
    version: str
    runtime_spec_json: dict[str, Any]


@dataclass
class ExperimentRef:
    id: int
    triggered_by: str


@dataclass
class DatasetRef:
    id: int
    name: str


@dataclass
class ExperimentRunRequested:
    message_type: str
    schema_version: str
    message_id: str
    produced_at: str
    source: dict[str, Any]
    experiment: ExperimentRef
    dataset: DatasetRef
    agent: AgentRef
    scorers: list[dict[str, Any]]
    run_cases: list[RunCaseInput]
    consumer_hints: dict[str, Any]


@dataclass
class CaseExecutionResult:
    run_case_id: int
    status: str
    trajectory: Any = None
    output: Any = None
    scorer_results: list[dict[str, Any]] = field(default_factory=list)
    logs: str = ""
    error_message: str = ""
    exit_code: int = 0
    latency_ms: int = 0
    container_id: str = ""
    container_image: str = ""
    execution_policy: str = "ephemeral_container_per_case"
    mock_sidecar_endpoint: str = ""
    inspect_eval_id: str = ""
    inspect_sample_id: str = ""
    usage: dict[str, Any] = field(default_factory=dict)
