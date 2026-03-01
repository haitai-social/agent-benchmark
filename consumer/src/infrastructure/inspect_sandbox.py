from __future__ import annotations

import asyncio
import json
import logging
import platform
import shlex
import time
from pathlib import PurePosixPath
from typing import Any

from inspect_ai.util import ExecResult, SandboxConnection, SandboxEnvironment, sandboxenv

logger = logging.getLogger(__name__)


async def _run_cmd(
    cmd: list[str],
    *,
    input_data: str | bytes | None = None,
    timeout: int | None = None,
) -> ExecResult[str]:
    stdin = asyncio.subprocess.PIPE if input_data is not None else None
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=stdin,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    input_bytes: bytes | None
    if isinstance(input_data, str):
        input_bytes = input_data.encode("utf-8")
    else:
        input_bytes = input_data
    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(input=input_bytes), timeout=timeout)
    except asyncio.TimeoutError as exc:
        proc.kill()
        await proc.wait()
        raise TimeoutError(f"command timed out after {timeout}s: {' '.join(cmd)}") from exc
    return ExecResult(
        success=proc.returncode == 0,
        returncode=proc.returncode or 0,
        stdout=stdout_b.decode("utf-8", errors="replace"),
        stderr=stderr_b.decode("utf-8", errors="replace"),
    )


@sandboxenv(name="arcloop_docker")
class ArcloopDockerSandbox(SandboxEnvironment):
    def __init__(self, container_name: str) -> None:
        self.container_name = container_name

    async def exec(
        self,
        cmd: list[str],
        input: str | bytes | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        user: str | None = None,
        timeout: int | None = None,
        timeout_retry: bool = True,
        concurrency: bool = True,
    ) -> ExecResult[str]:
        del timeout_retry
        del concurrency
        docker_cmd = ["docker", "exec"]
        if user:
            docker_cmd.extend(["-u", user])
        if cwd:
            docker_cmd.extend(["-w", cwd])
        if env:
            for key, value in sorted(env.items()):
                docker_cmd.extend(["-e", f"{key}={value}"])
        docker_cmd.append(self.container_name)
        docker_cmd.extend(cmd)
        return await _run_cmd(docker_cmd, input_data=input, timeout=timeout)

    async def write_file(self, file: str, contents: str | bytes) -> None:
        path = PurePosixPath(file)
        parent = str(path.parent) if str(path.parent) else "."
        mkdir_result = await self.exec(["mkdir", "-p", parent], timeout=30)
        if not mkdir_result.success:
            raise RuntimeError(f"E_SANDBOX_MKDIR: {mkdir_result.stderr.strip()}")
        payload = contents if isinstance(contents, bytes) else contents.encode("utf-8")
        write_cmd = ["docker", "exec", "-i", self.container_name, "sh", "-lc", f"cat > {shlex.quote(str(path))}"]
        write_result = await _run_cmd(write_cmd, input_data=payload, timeout=30)
        if not write_result.success:
            raise RuntimeError(f"E_SANDBOX_WRITE_FILE: {write_result.stderr.strip()}")

    async def read_file(self, file: str, text: bool = True) -> str:
        del text
        read_result = await self.exec(["cat", file], timeout=30)
        if not read_result.success:
            raise FileNotFoundError(file)
        return read_result.stdout

    async def connection(self, *, user: str | None = None) -> SandboxConnection:
        del user
        return SandboxConnection(
            type="docker",
            command=f"docker exec -it {self.container_name} sh",
            container=self.container_name,
        )

    @classmethod
    async def sample_init(
        cls,
        task_name: str,
        config: Any,
        metadata: dict[str, str],
    ) -> dict[str, SandboxEnvironment]:
        del config
        runtime_spec = json.loads(metadata.get("runtime_spec_json", "{}") or "{}")
        case_env = json.loads(metadata.get("case_env_json", "{}") or "{}")
        if not isinstance(runtime_spec, dict):
            raise RuntimeError("E_SANDBOX_RUNTIME_SPEC_INVALID")
        if not isinstance(case_env, dict):
            raise RuntimeError("E_SANDBOX_CASE_ENV_INVALID")

        image = str(runtime_spec.get("agent_image") or "").strip()
        if not image:
            raise RuntimeError("E_RUNTIME_SPEC_IMAGE_REQUIRED: agent.runtime_spec_json.agent_image")

        pull_policy = str(runtime_spec.get("pull_policy") or "if-not-present").strip().lower()
        if pull_policy not in {"always", "if-not-present", "never"}:
            pull_policy = "if-not-present"
        pull_timeout = int(runtime_spec.get("pull_timeout_seconds") or 120)
        run_timeout = int(runtime_spec.get("run_timeout_seconds") or 60)
        inspect_timeout = int(runtime_spec.get("inspect_timeout_seconds") or 10)

        await cls._docker_pull(image, pull_policy=pull_policy, pull_timeout=pull_timeout, inspect_timeout=inspect_timeout)

        task_slug = "".join(ch for ch in task_name if ch.isalnum() or ch in {"-", "_"})[:24] or "task"
        group_key = str(metadata.get("sandbox_group_key") or "case")
        group_slug = "".join(ch for ch in group_key if ch.isalnum() or ch in {"-", "_"})[:24] or "case"
        container_name = f"inspect-sb-{task_slug}-{group_slug}"

        # Always rebuild per case.
        await _run_cmd(["docker", "rm", "-f", container_name], timeout=inspect_timeout)
        docker_cmd = ["docker", "run", "-d", "--name", container_name]
        # On Linux hosts, map host.docker.internal explicitly.
        # On Docker Desktop (macOS/Windows), this mapping is built-in and overriding it can break routing.
        if platform.system() == "Linux":
            docker_cmd.extend(["--add-host", "host.docker.internal:host-gateway"])
        docker_cmd.extend(["--label", f"arcloop.inspect.task={task_slug}"])
        docker_cmd.extend(["--label", f"arcloop.inspect.group={group_slug}"])

        docker_network = str(runtime_spec.get("docker_network") or "").strip()
        if docker_network:
            docker_cmd.extend(["--network", docker_network])

        merged_env: dict[str, str] = {}
        for key, value in case_env.items():
            if isinstance(key, str):
                merged_env[key] = str(value)
        for key, value in sorted(merged_env.items()):
            docker_cmd.extend(["-e", f"{key}={value}"])

        startup_command = str(runtime_spec.get("sandbox_start_command") or runtime_spec.get("agent_command") or "").strip()
        if startup_command:
            docker_cmd.extend([image, "sh", "-lc", startup_command])
        else:
            docker_cmd.append(image)

        run_result = await _run_cmd(docker_cmd, timeout=run_timeout)
        if not run_result.success:
            raise RuntimeError(f"E_DOCKER_CREATE: {run_result.stderr.strip()}")

        startup_timeout = int(runtime_spec.get("startup_timeout_seconds") or 30)
        startup_poll_interval = float(runtime_spec.get("startup_poll_interval_seconds") or 1)
        deadline = time.time() + startup_timeout
        while time.time() < deadline:
            probe = await _run_cmd(
                ["docker", "inspect", container_name, "--format", "{{.State.Running}}"],
                timeout=inspect_timeout,
            )
            if probe.success and probe.stdout.strip().lower() == "true":
                return {"default": cls(container_name)}
            await asyncio.sleep(startup_poll_interval)
        raise RuntimeError(f"E_CONTAINER_STARTUP_TIMEOUT: container={container_name} timeout={startup_timeout}s")

    @classmethod
    async def sample_cleanup(
        cls,
        task_name: str,
        config: Any,
        environments: dict[str, SandboxEnvironment],
        interrupted: bool,
    ) -> None:
        del task_name
        del config
        del interrupted
        env = environments.get("default")
        if not isinstance(env, ArcloopDockerSandbox):
            return
        await _run_cmd(["docker", "rm", "-f", env.container_name], timeout=30)

    @classmethod
    async def task_cleanup(
        cls,
        task_name: str,
        config: Any,
        cleanup: bool,
    ) -> None:
        del config
        if not cleanup:
            return
        task_slug = "".join(ch for ch in task_name if ch.isalnum() or ch in {"-", "_"})[:24] or "task"
        listed = await _run_cmd(
            ["docker", "ps", "-aq", "--filter", f"label=arcloop.inspect.task={task_slug}"],
            timeout=30,
        )
        if not listed.success:
            return
        ids = [line.strip() for line in listed.stdout.splitlines() if line.strip()]
        if ids:
            await _run_cmd(["docker", "rm", "-f", *ids], timeout=30)

    @classmethod
    async def _docker_pull(
        cls,
        image: str,
        *,
        pull_policy: str,
        pull_timeout: int,
        inspect_timeout: int,
    ) -> None:
        del cls
        if pull_policy == "never":
            return
        if pull_policy == "if-not-present":
            present = await _run_cmd(["docker", "image", "inspect", image], timeout=inspect_timeout)
            if present.success:
                return
        pull = await _run_cmd(["docker", "pull", image], timeout=pull_timeout)
        if pull.success:
            return
        present = await _run_cmd(["docker", "image", "inspect", image], timeout=inspect_timeout)
        if present.success:
            logger.warning("code=E_DOCKER_PULL_FAILED_USE_LOCAL image=%s err=%s", image, pull.stderr.strip())
            return
        raise RuntimeError(f"E_DOCKER_PULL: {pull.stderr.strip()}")
