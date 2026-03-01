from __future__ import annotations

from infrastructure.docker_runner import DockerRunner
from runtime.inspect_runner import InspectRunner


def test_docker_runner_proxy_env_bypasses_host_docker_internal() -> None:
    runner = DockerRunner(
        timeout_seconds=30,
        docker_network=None,
        agent_exec_command=None,
        pull_policy="if-not-present",
        pull_timeout_seconds=30,
        run_timeout_seconds=30,
        inspect_timeout_seconds=10,
    )
    env = runner._build_mock_proxy_env("http://host.docker.internal:14318")
    assert env["NO_PROXY"] == "127.0.0.1,localhost,host.docker.internal"
    assert env["no_proxy"] == "127.0.0.1,localhost,host.docker.internal"


def test_inspect_runner_proxy_env_bypasses_host_docker_internal() -> None:
    runner = object.__new__(InspectRunner)
    env = runner._build_mock_proxy_env("http://host.docker.internal:14318")
    assert env["NO_PROXY"] == "127.0.0.1,localhost,host.docker.internal"
    assert env["no_proxy"] == "127.0.0.1,localhost,host.docker.internal"

