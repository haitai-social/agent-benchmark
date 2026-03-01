from __future__ import annotations

import json
import logging
import platform
import subprocess
import time
from typing import Any

from domain.contracts import CaseExecutionResult, ExperimentRunRequested, RunCaseInput
from .mock_gateway.runtime import start_mock_gateway

logger = logging.getLogger(__name__)


class DockerRunner:
    def __init__(
        self,
        timeout_seconds: int,
        docker_network: str | None,
        agent_exec_command: str | None,
        pull_policy: str,
        pull_timeout_seconds: int,
        run_timeout_seconds: int,
        inspect_timeout_seconds: int,
    ) -> None:
        self.timeout_seconds = timeout_seconds
        self.docker_network = docker_network
        self.agent_exec_command = agent_exec_command
        self.pull_policy = pull_policy
        self.pull_timeout_seconds = pull_timeout_seconds
        self.run_timeout_seconds = run_timeout_seconds
        self.inspect_timeout_seconds = inspect_timeout_seconds

    def run_case(self, message: ExperimentRunRequested, run_case: RunCaseInput) -> CaseExecutionResult:
        started = time.time()
        runtime_spec = dict(message.agent.runtime_spec_json or {})
        image = str(runtime_spec.get("agent_image") or "").strip()
        if not image:
            raise RuntimeError("E_RUNTIME_SPEC_IMAGE_REQUIRED: agent.runtime_spec_json.agent_image")

        result = CaseExecutionResult(
            run_case_id=run_case.run_case_id,
            status="failed",
            container_image=image,
        )

        sidecar = start_mock_gateway(run_case.mock_config)
        if sidecar:
            result.mock_sidecar_endpoint = sidecar.endpoint

        container_name = f"bench-case-{run_case.run_case_id}"
        try:
            self._docker_pull(image)
            env = self._build_env(message, run_case, sidecar.endpoint if sidecar else None)
            container_id = self._docker_run(image, container_name, env, runtime_spec)
            result.container_id = container_id
            case_exec_command = str(runtime_spec.get("case_exec_command") or "").strip()
            after_exec_command = str(runtime_spec.get("after_exec_command") or "").strip()
            if case_exec_command:
                logger.info("code=CASE_EXEC_MODE mode=sandbox_exec run_case_id=%s", run_case.run_case_id)
                self._wait_container_ready(container_name, runtime_spec)
                exit_code, exec_logs = self._docker_exec(container_name, case_exec_command)
                after_exit_code = 0
                after_logs = ""
                if exit_code == 0 and after_exec_command:
                    after_exit_code, after_logs = self._docker_exec(container_name, after_exec_command)
                _, container_logs = self._docker_logs(container_name)
                logs = f"[case-exec]\n{exec_logs}".strip()
                if after_logs:
                    logs = f"{logs}\n\n[after-exec]\n{after_logs}".strip()
                logs = f"{logs}\n\n[container]\n{container_logs}".strip()
                if exit_code == 0:
                    exit_code = after_exit_code
            else:
                logger.info("code=CASE_EXEC_MODE mode=one_shot_wait run_case_id=%s", run_case.run_case_id)
                exit_code, logs = self._docker_wait_and_logs(container_name)
            result.exit_code = exit_code
            result.logs = logs

            parsed = self._parse_agent_output(logs)
            if parsed is not None:
                result.output, result.trajectory = self._normalize_case_result_payload(parsed, logs)
                if parsed.get("logs"):
                    result.logs = parsed["logs"]

            result.status = "success" if exit_code == 0 else "failed"
            if exit_code != 0:
                result.error_message = f"E_CASE_EXEC_NON_ZERO: exit code {exit_code}"
        except Exception as exc:
            result.error_message = str(exc)
        finally:
            result.latency_ms = int((time.time() - started) * 1000)
            subprocess.run(["docker", "rm", "-f", container_name], check=False, capture_output=True, text=True)
            if sidecar:
                sidecar.close()

        return result


    def _docker_pull(self, image: str) -> None:
        if self.pull_policy == "never":
            return
        if self.pull_policy == "if-not-present" and self._has_local_image(image):
            return

        logger.info("code=DOCKER_PULL_START image=%s policy=%s", image, self.pull_policy)
        proc = self._run_docker_command(
            ["docker", "pull", image],
            timeout_seconds=self.pull_timeout_seconds,
            timeout_code="E_DOCKER_PULL_TIMEOUT",
        )
        if proc.returncode != 0:
            if self._has_local_image(image):
                logger.warning("code=E_DOCKER_PULL_FAILED_USE_LOCAL image=%s err=%s", image, proc.stderr.strip())
                return
            raise RuntimeError(f"E_DOCKER_PULL: {proc.stderr.strip()}")

    def _has_local_image(self, image: str) -> bool:
        proc = self._run_docker_command(
            ["docker", "image", "inspect", image],
            timeout_seconds=self.inspect_timeout_seconds,
            timeout_code="E_DOCKER_IMAGE_INSPECT_TIMEOUT",
        )
        return proc.returncode == 0

    def _docker_run(self, image: str, container_name: str, env: dict[str, str], runtime_spec: dict[str, Any]) -> str:
        cmd = ["docker", "run", "-d", "--name", container_name]
        # Linux engines usually need explicit host-gateway mapping.
        # Docker Desktop provides host.docker.internal natively; overriding it can break routing.
        if platform.system() == "Linux":
            cmd.extend(["--add-host", "host.docker.internal:host-gateway"])
        if self.docker_network:
            cmd.extend(["--network", self.docker_network])
        for key, value in sorted(env.items()):
            cmd.extend(["-e", f"{key}={value}"])
        command_override = self.agent_exec_command or str(runtime_spec.get("agent_command") or "").strip()
        if command_override:
            cmd.extend([image, "sh", "-lc", command_override])
        else:
            cmd.append(image)
        logger.info("code=DOCKER_RUN_START image=%s container=%s", image, container_name)
        proc = self._run_docker_command(
            cmd,
            timeout_seconds=self.run_timeout_seconds,
            timeout_code="E_DOCKER_RUN_TIMEOUT",
        )
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

    def _docker_logs(self, container_name: str) -> tuple[int, str]:
        logs = subprocess.run(["docker", "logs", container_name], check=False, capture_output=True, text=True)
        if logs.returncode != 0:
            raise RuntimeError(f"E_DOCKER_LOGS: {logs.stderr.strip()}")
        return logs.returncode, logs.stdout.strip()

    def _docker_exec(self, container_name: str, case_exec_command: str) -> tuple[int, str]:
        logger.info("code=DOCKER_EXEC_START container=%s", container_name)
        proc = self._run_docker_command(
            ["docker", "exec", container_name, "sh", "-lc", case_exec_command],
            timeout_seconds=self.timeout_seconds,
            timeout_code="E_DOCKER_EXEC_TIMEOUT",
        )
        output = f"{proc.stdout}\n{proc.stderr}".strip()
        return proc.returncode, output

    def _wait_container_ready(self, container_name: str, runtime_spec: dict[str, Any]) -> None:
        startup_timeout = int(runtime_spec.get("startup_timeout_seconds") or 30)
        startup_poll_interval = float(runtime_spec.get("startup_poll_interval_seconds") or 1)
        deadline = time.time() + startup_timeout
        while time.time() < deadline:
            inspect = self._run_docker_command(
                ["docker", "inspect", container_name, "--format", "{{.State.Running}}"],
                timeout_seconds=self.inspect_timeout_seconds,
                timeout_code="E_DOCKER_INSPECT_TIMEOUT",
            )
            if inspect.returncode == 0 and inspect.stdout.strip().lower() == "true":
                return
            time.sleep(startup_poll_interval)
        raise RuntimeError(f"E_CONTAINER_STARTUP_TIMEOUT: container={container_name} timeout={startup_timeout}s")

    def _run_docker_command(
        self,
        cmd: list[str],
        *,
        timeout_seconds: int,
        timeout_code: str,
    ) -> subprocess.CompletedProcess[str]:
        try:
            return subprocess.run(
                cmd,
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"{timeout_code}: {timeout_seconds}s cmd={' '.join(cmd)}") from exc

    def _build_env(self, message: ExperimentRunRequested, run_case: RunCaseInput, mock_base_url: str | None) -> dict[str, str]:
        runtime_spec = dict(message.agent.runtime_spec_json or {})
        env_from_spec = runtime_spec.get("agent_env_template", {})
        env: dict[str, str] = {
            "BENCHMARK_EXPERIMENT_ID": str(message.experiment.id),
            "BENCHMARK_DATASET_ID": str(message.dataset.id),
            "BENCHMARK_RUN_CASE_ID": str(run_case.run_case_id),
            "BENCHMARK_DATA_ITEM_ID": str(run_case.data_item_id),
            "BENCHMARK_ATTEMPT_NO": str(run_case.attempt_no),
            "BENCHMARK_USER_INPUT": run_case.user_input,
            "BENCHMARK_SESSION_JSONL": run_case.session_jsonl,
            "BENCHMARK_AGENT_RUNTIME_SPEC": json.dumps(message.agent.runtime_spec_json),
            "BENCHMARK_MOCK_CONFIG": json.dumps(run_case.mock_config, default=lambda o: o.__dict__),
        }
        if isinstance(env_from_spec, dict):
            for key, value in env_from_spec.items():
                if isinstance(key, str):
                    env[key] = str(value)
        if run_case.trace_id:
            env["BENCHMARK_TRACE_ID"] = run_case.trace_id
        existing_resource_attrs = str(env.get("OTEL_RESOURCE_ATTRIBUTES") or "").strip()
        injected_resource_attrs = ",".join(
            [
                f"benchmark.experiment_id={message.experiment.id}",
                f"benchmark.run_case_id={run_case.run_case_id}",
                f"benchmark.data_item_id={run_case.data_item_id}",
            ]
        )
        env["OTEL_RESOURCE_ATTRIBUTES"] = (
            f"{existing_resource_attrs},{injected_resource_attrs}"
            if existing_resource_attrs
            else injected_resource_attrs
        )
        existing_headers = str(env.get("OTEL_EXPORTER_OTLP_HEADERS") or "").strip()
        injected_headers = ",".join(
            [
                f"x-benchmark-experiment-id={message.experiment.id}",
                f"x-benchmark-run-case-id={run_case.run_case_id}",
                f"x-benchmark-data-item-id={run_case.data_item_id}",
            ]
        )
        merged_headers = f"{existing_headers},{injected_headers}" if existing_headers else injected_headers
        env["OTEL_EXPORTER_OTLP_HEADERS"] = merged_headers
        env["OTEL_EXPORTER_OTLP_TRACES_HEADERS"] = merged_headers
        if mock_base_url:
            env.update(self._build_mock_proxy_env(mock_base_url))
        return env

    def _build_mock_proxy_env(self, proxy_url: str) -> dict[str, str]:
        no_proxy_value = "127.0.0.1,localhost,host.docker.internal"
        return {
            "HTTP_PROXY": proxy_url,
            "HTTPS_PROXY": proxy_url,
            "ALL_PROXY": proxy_url,
            "http_proxy": proxy_url,
            "https_proxy": proxy_url,
            "all_proxy": proxy_url,
            "NO_PROXY": no_proxy_value,
            "no_proxy": no_proxy_value,
        }

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

    def _normalize_case_result_payload(self, parsed: dict[str, Any], raw_logs: str) -> tuple[Any, Any]:
        if "output" in parsed:
            return parsed.get("output"), parsed.get("trajectory") if "trajectory" in parsed else []
        choices = parsed.get("choices")
        if isinstance(choices, list) and choices:
            first = choices[0]
            if isinstance(first, dict):
                message = first.get("message")
                if isinstance(message, dict) and message.get("content") is not None:
                    return message.get("content"), []
        out_items = parsed.get("output")
        if isinstance(out_items, list) and out_items:
            texts: list[str] = []
            for item in out_items:
                if not isinstance(item, dict):
                    continue
                content = item.get("content")
                if isinstance(content, list):
                    for part in content:
                        if isinstance(part, dict) and isinstance(part.get("text"), str):
                            texts.append(part["text"])
                elif isinstance(content, str):
                    texts.append(content)
            if texts:
                return "\n".join(texts), []
        return {"raw_stdout": raw_logs}, []
