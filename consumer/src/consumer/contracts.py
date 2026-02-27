from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class MockRoute:
    path: str
    method: str
    status_code: int
    body: str = ""
    headers: dict[str, str] = field(default_factory=dict)


@dataclass
class MockConfig:
    base_url: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    routes: list[MockRoute] = field(default_factory=list)


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
    docker_image: str
    openapi_spec: Any
    metadata: Any


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
    evaluators: list[dict[str, Any]]
    run_cases: list[RunCaseInput]
    consumer_hints: dict[str, bool]


@dataclass
class CaseExecutionResult:
    run_case_id: int
    status: str
    trajectory: Any = None
    output: Any = None
    logs: str = ""
    error_message: str = ""
    exit_code: int = 0
    latency_ms: int = 0
    container_id: str = ""
    container_image: str = ""
    execution_policy: str = "ephemeral_container_per_case"
    mock_sidecar_endpoint: str = ""
