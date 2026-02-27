from __future__ import annotations

import json
import subprocess
import time
from typing import Any

from .contracts import CaseExecutionResult, ExperimentRunRequested, RunCaseInput
from .mock_sidecar import start_mock_sidecar


class DockerRunner:
    def __init__(self, timeout_seconds: int, docker_network: str | None, agent_exec_command: str | None) -> None:
        self.timeout_seconds = timeout_seconds
        self.docker_network = docker_network
        self.agent_exec_command = agent_exec_command

    def run_case(self, message: ExperimentRunRequested, run_case: RunCaseInput) -> CaseExecutionResult:
        started = time.time()
        result = CaseExecutionResult(
            run_case_id=run_case.run_case_id,
            status="failed",
            container_image=message.agent.docker_image,
        )

        sidecar = start_mock_sidecar(run_case.mock_config)
        if sidecar:
            result.mock_sidecar_endpoint = sidecar.endpoint

        container_name = f"bench-case-{run_case.run_case_id}"
        try:
            self._docker_pull(message.agent.docker_image)
            env = self._build_env(message, run_case, sidecar.endpoint if sidecar else None)
            container_id = self._docker_run(message.agent.docker_image, container_name, env)
            result.container_id = container_id
            exit_code, logs = self._docker_wait_and_logs(container_name)
            result.exit_code = exit_code
            result.logs = logs

            parsed = self._parse_agent_output(logs)
            if parsed is not None:
                result.trajectory = parsed.get("trajectory")
                result.output = parsed.get("output")
                if parsed.get("logs"):
                    result.logs = parsed["logs"]

            result.status = "success" if exit_code == 0 else "failed"
            if exit_code != 0:
                result.error_message = f"E_AGENT_EXIT_NON_ZERO: exit code {exit_code}"
        except Exception as exc:
            result.error_message = str(exc)
        finally:
            result.latency_ms = int((time.time() - started) * 1000)
            subprocess.run(["docker", "rm", "-f", container_name], check=False, capture_output=True, text=True)
            if sidecar:
                sidecar.close()

        return result

    def _docker_pull(self, image: str) -> None:
        proc = subprocess.run(["docker", "pull", image], check=False, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(f"E_DOCKER_PULL: {proc.stderr.strip()}")

    def _docker_run(self, image: str, container_name: str, env: dict[str, str]) -> str:
        cmd = ["docker", "run", "-d", "--name", container_name]
        if self.docker_network:
            cmd.extend(["--network", self.docker_network])
        for key, value in sorted(env.items()):
            cmd.extend(["-e", f"{key}={value}"])
        if self.agent_exec_command:
            cmd.extend([image, "sh", "-lc", self.agent_exec_command])
        else:
            cmd.append(image)
        proc = subprocess.run(cmd, check=False, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(f"E_DOCKER_CREATE: {proc.stderr.strip()}")
        return proc.stdout.strip()

    def _docker_wait_and_logs(self, container_name: str) -> tuple[int, str]:
        wait = subprocess.run(
            ["docker", "wait", container_name],
            check=False,
            capture_output=True,
            text=True,
            timeout=self.timeout_seconds,
        )
        if wait.returncode != 0:
            raise RuntimeError(f"E_DOCKER_WAIT: {wait.stderr.strip()}")
        logs = subprocess.run(["docker", "logs", container_name], check=False, capture_output=True, text=True)
        if logs.returncode != 0:
            raise RuntimeError(f"E_DOCKER_LOGS: {logs.stderr.strip()}")
        return int(wait.stdout.strip() or 1), logs.stdout.strip()

    def _build_env(self, message: ExperimentRunRequested, run_case: RunCaseInput, mock_base_url: str | None) -> dict[str, str]:
        env: dict[str, str] = {
            "BENCHMARK_EXPERIMENT_ID": str(message.experiment.id),
            "BENCHMARK_DATASET_ID": str(message.dataset.id),
            "BENCHMARK_RUN_CASE_ID": str(run_case.run_case_id),
            "BENCHMARK_DATA_ITEM_ID": str(run_case.data_item_id),
            "BENCHMARK_ATTEMPT_NO": str(run_case.attempt_no),
            "BENCHMARK_USER_INPUT": run_case.user_input,
            "BENCHMARK_SESSION_JSONL": run_case.session_jsonl,
            "BENCHMARK_AGENT_METADATA": json.dumps(message.agent.metadata),
            "BENCHMARK_AGENT_OPENAPI": json.dumps(message.agent.openapi_spec),
            "BENCHMARK_MOCK_CONFIG": json.dumps(run_case.mock_config, default=lambda o: o.__dict__),
        }
        if run_case.trace_id:
            env["BENCHMARK_TRACE_ID"] = run_case.trace_id
        if mock_base_url:
            env["BENCHMARK_MOCK_BASE_URL"] = mock_base_url
        return env

    def _parse_agent_output(self, raw_logs: str) -> dict[str, Any] | None:
        lines = [line.strip() for line in raw_logs.splitlines() if line.strip()]
        for line in reversed(lines):
            if not (line.startswith("{") or line.startswith("[")):
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                return parsed
        try:
            parsed = json.loads(raw_logs)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            return None
        return None
