from __future__ import annotations

import json
import os
import sys

from domain.contracts import AgentRef, DatasetRef, ExperimentRef, ExperimentRunRequested, RunCaseInput
from infrastructure.docker_runner import DockerRunner


def main() -> int:
    command = os.getenv(
        "CONSUMER_AGENT_EXEC_COMMAND",
        "echo '{\"trajectory\":[{\"step\":1,\"action\":\"pong\"}],\"output\":\"ok\"}'",
    )

    runner = DockerRunner(
        timeout_seconds=90,
        docker_network=None,
        agent_exec_command=command,
        pull_policy="always",
        pull_timeout_seconds=120,
        run_timeout_seconds=60,
        inspect_timeout_seconds=10,
    )
    message = ExperimentRunRequested(
        message_type="experiment.run.requested",
        schema_version="v2",
        message_id="smoke-docker-run",
        produced_at="",
        source={},
        experiment=ExperimentRef(id=1, triggered_by="smoke"),
        dataset=DatasetRef(id=1, name="smoke"),
        agent=AgentRef(
            id=1,
            name="smoke-agent",
            agent_key="smoke",
            version="v1",
            runtime_spec_json={
                "runtime_type": "agno_docker",
                "agent_image": os.getenv("SMOKE_AGENT_IMAGE", "alpine:3.20"),
                "agent_command": command,
            },
        ),
        scorers=[],
        run_cases=[],
        consumer_hints={},
    )
    run_case = RunCaseInput(
        run_case_id=1,
        data_item_id=1,
        attempt_no=1,
        session_jsonl="[]",
        user_input="ping",
        trace_id=None,
        reference_trajectory=None,
        reference_output=None,
        mock_config=None,
    )

    result = runner.run_case(message, run_case)
    print(json.dumps(result.__dict__, ensure_ascii=False, indent=2))
    if result.status != "success":
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
