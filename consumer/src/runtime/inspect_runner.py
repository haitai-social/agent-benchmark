from __future__ import annotations

import asyncio
import concurrent.futures
import hashlib
import importlib.util
import json
import logging
import os
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from domain.contracts import CaseExecutionResult, ExperimentRunRequested, RunCaseInput
from infrastructure.config import Settings
from infrastructure.docker_runner import DockerRunner
from infrastructure.mock_sidecar import start_mock_sidecar
from runtime.evaluator_client import EvaluatorCallInput, call_evaluator

logger = logging.getLogger(__name__)
DEFAULT_SCORE_SENTINEL = -1.0
DEFAULT_EVALUATOR_TIMEOUT_SECONDS = 90
DEFAULT_EVALUATOR_CONNECT_TIMEOUT_SECONDS = 15
DEFAULT_EVALUATOR_READ_TIMEOUT_SECONDS = 90
DEFAULT_EVALUATOR_MAX_RETRIES = 2
DEFAULT_EVALUATOR_RETRY_BACKOFF_SECONDS = 1.0
INSPECT_HEARTBEAT_SECONDS = 10
INSPECT_STUCK_WARN_SECONDS = 90


class InspectRunner:
    """Inspect-first case runner with shared sandbox per message.

    For a single experiment message, one sandbox container is created and reused
    for all run_cases. Each case executes in order and then issues a reset command.
    """

    def __init__(self, docker_runner: DockerRunner, settings: Settings) -> None:
        self.docker_runner = docker_runner
        self.settings = settings
        self._scorer_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=max(1, int(settings.scorer_concurrent_cases)),
            thread_name_prefix="scorer",
        )
        self._inspect_probe_error: str = ""
        self._has_inspect_ai = self._probe_inspect_ai()
        if self._has_inspect_ai:
            logger.info(
                "code=INSPECT_AI_AVAILABLE python=%s executable=%s scorer_pool_size=%s",
                sys.version.split()[0],
                sys.executable,
                max(1, int(settings.scorer_concurrent_cases)),
            )
        else:
            logger.error(
                "code=E_INSPECT_AI_UNAVAILABLE python=%s executable=%s err=%s",
                sys.version.split()[0],
                sys.executable,
                self._inspect_probe_error,
            )

    def _probe_inspect_ai(self) -> bool:
        try:
            spec = importlib.util.find_spec("inspect_ai")
            if spec is None:
                self._inspect_probe_error = "module inspect_ai not found"
                return False
            import inspect_ai  # type: ignore

            if not hasattr(inspect_ai, "Task") or not hasattr(inspect_ai, "eval"):
                self._inspect_probe_error = "inspect_ai missing Task/eval attributes"
                return False
            return True
        except Exception as exc:
            self._inspect_probe_error = f"{type(exc).__name__}: {exc}"
            return False

    def runtime_snapshot(self, message: ExperimentRunRequested, run_case: RunCaseInput) -> dict[str, Any]:
        spec = dict(message.agent.runtime_spec_json or {})
        canonical = json.dumps(spec, sort_keys=True, separators=(",", ":"))
        return {
            "runtime_spec_hash": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
            "runtime_type": spec.get("runtime_type", "agno_docker"),
            "agent_image": spec.get("agent_image"),
            "agent_command": spec.get("agent_command"),
            "services": spec.get("services", []),
            "sandbox": spec.get("sandbox", {}),
            "scorers": message.scorers,
            "run_case_id": run_case.run_case_id,
            "generated_at": int(time.time()),
        }

    def run_case(self, message: ExperimentRunRequested, run_case: RunCaseInput) -> CaseExecutionResult:
        return self.run_cases(message, [run_case])[run_case.run_case_id]

    def run_cases(self, message: ExperimentRunRequested, run_cases: list[RunCaseInput]) -> dict[int, CaseExecutionResult]:
        started = time.time()
        if not self._has_inspect_ai:
            return self._failed_without_inspect(run_cases)

        try:
            return self._run_inspect_eval_batch(message=message, run_cases=run_cases)
        except Exception as exc:
            logger.warning("code=E_INSPECT_EVAL_FAILED err=%s", exc)
            failed: dict[int, CaseExecutionResult] = {}
            for run_case in run_cases:
                result = CaseExecutionResult(
                    run_case_id=run_case.run_case_id,
                    status="failed",
                    container_image=str(dict(message.agent.runtime_spec_json or {}).get("agent_image") or ""),
                    error_message=str(exc),
                    inspect_eval_id=f"inspect-eval-fallback-{uuid.uuid4()}",
                    inspect_sample_id=f"inspect-sample-fallback-{run_case.run_case_id}-{uuid.uuid4()}",
                )
                result.scorer_results = self._fallback_scores(message, run_case, result, inspect_enabled=True)
                result.usage = {
                    "inspect_enabled": True,
                    "inspect_error": str(exc),
                    "measured_at": int(time.time()),
                }
                result.logs = f"{result.logs}\n[inspect] eval_id={result.inspect_eval_id} sample_id={result.inspect_sample_id}".strip()
                result.latency_ms = int((time.time() - started) * 1000)
                failed[run_case.run_case_id] = result
            return failed

    def _failed_without_inspect(self, run_cases: list[RunCaseInput]) -> dict[int, CaseExecutionResult]:
        detail = (
            f"{self._inspect_probe_error}; python={sys.version.split()[0]}; executable={sys.executable}"
            if self._inspect_probe_error
            else f"python={sys.version.split()[0]}; executable={sys.executable}"
        )
        results: dict[int, CaseExecutionResult] = {}
        for run_case in run_cases:
            result = CaseExecutionResult(
                run_case_id=run_case.run_case_id,
                status="failed",
                error_message=f"E_INSPECT_AI_REQUIRED: {detail}",
                inspect_eval_id=f"inspect-eval-fallback-{uuid.uuid4()}",
                inspect_sample_id=f"inspect-sample-fallback-{run_case.run_case_id}-{uuid.uuid4()}",
            )
            result.logs = f"[inspect] eval_id={result.inspect_eval_id} sample_id={result.inspect_sample_id}".strip()
            results[run_case.run_case_id] = result
        return results

    def _run_inspect_eval_batch(
        self,
        *,
        message: ExperimentRunRequested,
        run_cases: list[RunCaseInput],
    ) -> dict[int, CaseExecutionResult]:
        batch_started = time.time()
        logger.info(
            "code=INSPECT_EVAL_BATCH_START experiment_id=%s run_cases=%s",
            message.experiment.id,
            len(run_cases),
        )
        inspect_runtime_dir = Path.cwd() / ".inspect_ai"
        inspect_logs_dir = inspect_runtime_dir / "logs"
        inspect_traces_dir = inspect_runtime_dir / "traces"
        inspect_logs_dir.mkdir(parents=True, exist_ok=True)
        inspect_traces_dir.mkdir(parents=True, exist_ok=True)
        os.environ["INSPECT_LOG_DIR"] = str(inspect_logs_dir)
        os.environ["INSPECT_TRACE_FILE"] = str(inspect_traces_dir / "trace.log")
        os.environ["PYTEST_CURRENT_TEST"] = "consumer_inspect_runner"
        os.environ["PYTEST_VERSION"] = "consumer_inspect_runner"

        from inspect_ai import Task, eval as inspect_eval  # type: ignore
        from inspect_ai.dataset import Sample  # type: ignore
        from inspect_ai.model import ChatMessageAssistant, ModelOutput, ModelUsage  # type: ignore
        from inspect_ai.scorer import Score, mean, scorer  # type: ignore
        from inspect_ai.solver import solver  # type: ignore
        from inspect_ai.util import SandboxEnvironmentSpec, sandbox  # type: ignore

        import infrastructure.inspect_sandbox  # noqa: F401

        runtime_spec = dict(message.agent.runtime_spec_json or {})
        image = str(runtime_spec.get("agent_image") or "").strip()
        if not image:
            raise RuntimeError("E_RUNTIME_SPEC_IMAGE_REQUIRED: agent.runtime_spec_json.agent_image")
        case_exec_command = str(runtime_spec.get("case_exec_command") or "").strip()
        if not case_exec_command:
            raise RuntimeError("E_RUNTIME_SPEC_CASE_EXEC_REQUIRED: agent.runtime_spec_json.case_exec_command")

        case_map = {rc.run_case_id: rc for rc in run_cases}
        execution: dict[int, dict[str, Any]] = {
            rc.run_case_id: {
                "status": "failed",
                "exit_code": 1,
                "logs": "",
                "trajectory": None,
                "output": None,
                "error_message": "E_CASE_NOT_EXECUTED",
                "container_name": "",
                "mock_sidecar_endpoint": "",
                "latency_ms": 0,
                "sandbox_connect_ms": 0,
                "case_exec_ms": 0,
                "trajectory_resolve_ms": 0,
                "scorer_total_ms": 0,
                "scorer_timings_ms": {},
            }
            for rc in run_cases
        }
        progress: dict[str, Any] = {
            "phase": "prepare",
            "run_case_id": None,
            "updated_at": time.time(),
            "started_at": time.time(),
        }
        execution_lock = threading.Lock()
        hb_stop = threading.Event()

        def _update_progress(phase: str, run_case_id: int | None = None) -> None:
            progress["phase"] = phase
            progress["run_case_id"] = run_case_id
            progress["updated_at"] = time.time()

        def _heartbeat() -> None:
            while not hb_stop.wait(INSPECT_HEARTBEAT_SECONDS):
                now = time.time()
                elapsed = int(now - float(progress["started_at"]))
                idle = int(now - float(progress["updated_at"]))
                logger.info(
                    "code=INSPECT_HEARTBEAT experiment_id=%s phase=%s run_case_id=%s elapsed_s=%s idle_s=%s",
                    message.experiment.id,
                    progress["phase"],
                    progress["run_case_id"],
                    elapsed,
                    idle,
                )
                if idle >= INSPECT_STUCK_WARN_SECONDS:
                    logger.warning(
                        "code=E_INSPECT_POSSIBLY_STUCK experiment_id=%s phase=%s run_case_id=%s idle_s=%s",
                        message.experiment.id,
                        progress["phase"],
                        progress["run_case_id"],
                        idle,
                    )

        hb_thread = threading.Thread(target=_heartbeat, name="inspect-heartbeat", daemon=True)
        hb_thread.start()

        score_specs = message.scorers or [{"scorer_key": "task_success"}]

        @solver(name=f"run_cases_in_shared_sandbox_{message.experiment.id}")
        def run_cases_in_shared_sandbox():
            async def solve(state, generate):
                del generate
                raw_run_case_id = (state.metadata or {}).get("run_case_id")
                run_case_id = int(raw_run_case_id)
                run_case = case_map[run_case_id]
                sidecar = start_mock_sidecar(run_case.mock_config)
                mock_base_url = sidecar.endpoint if sidecar else None
                execution[run_case_id]["mock_sidecar_endpoint"] = mock_base_url or ""

                try:
                    case_started = time.time()
                    case_started_ms = int(case_started * 1000)
                    _update_progress("sandbox_connect", run_case_id)
                    sandbox_connect_started = time.time()
                    sb = sandbox()
                    conn = await sb.connection()
                    sandbox_connect_ms = int((time.time() - sandbox_connect_started) * 1000)
                    execution[run_case_id]["container_name"] = conn.container or ""
                    execution[run_case_id]["sandbox_connect_ms"] = sandbox_connect_ms
                    case_env = self._build_case_env(message, run_case, mock_base_url)
                    _update_progress("case_exec", run_case_id)
                    case_exec_started = time.time()
                    exec_result, raw_logs = await self._exec_case_with_startup_retry(
                        sb=sb,
                        run_case_id=run_case_id,
                        case_exec_command=case_exec_command,
                        case_env=case_env,
                        runtime_spec=runtime_spec,
                    )
                    case_exec_ms = int((time.time() - case_exec_started) * 1000)
                    execution[run_case_id]["case_exec_ms"] = case_exec_ms
                    container_logs = self._docker_container_logs(execution[run_case_id]["container_name"])
                    parsed = self._parse_agent_output(raw_logs)
                    output, trajectory = self._normalize_case_result_payload(parsed, exec_result.stdout)
                    case_finished_ms = int(time.time() * 1000)
                    execution[run_case_id]["trajectory_resolve_ms"] = 0
                    logs = str(parsed.get("logs")) if parsed and parsed.get("logs") else raw_logs
                    if container_logs:
                        logs = f"{logs}\n\n[container]\n{container_logs}".strip()

                    execution[run_case_id].update(
                        {
                            "status": "success" if exec_result.returncode == 0 else "failed",
                            "exit_code": exec_result.returncode,
                            "logs": logs,
                            "trajectory": trajectory,
                            "output": output,
                            "error_message": ""
                            if exec_result.returncode == 0
                            else f"E_AGENT_EXIT_NON_ZERO: exit code {exec_result.returncode}",
                            "latency_ms": int((time.time() - case_started) * 1000),
                        }
                    )
                    _update_progress("case_done", run_case_id)

                    completion = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
                    state.output = ModelOutput.from_message(ChatMessageAssistant(content=completion, source="generate"))
                    state.output.usage = ModelUsage(input_tokens=0, output_tokens=0, total_tokens=0)
                    state.completed = True
                    return state
                finally:
                    if sidecar:
                        sidecar.close()

            return solve

        def scorer_dispatch(
            scorer_key: str,
            run_case: RunCaseInput,
            staged: CaseExecutionResult,
            scorer_meta: dict[str, Any],
        ) -> tuple[float, str, dict[str, Any]]:
            return self._score_case(scorer_key, run_case, staged, scorer_meta)

        scorer_fns = []
        for idx, scorer_spec in enumerate(score_specs):
            scorer_key = str(scorer_spec.get("scorer_key") or scorer_spec.get("evaluator_key") or f"default_{idx}")

            @scorer(metrics=[mean()], name=f"{scorer_key}_{message.experiment.id}_{idx}")
            def runtime_scorer_factory(
                key: str = scorer_key,
                scorer_meta: dict[str, Any] = dict(scorer_spec),
                score_impl: Any = scorer_dispatch,
            ):
                async def score_fn(state, target):
                    del target
                    run_case_id = int((state.metadata or {}).get("run_case_id"))
                    staged = CaseExecutionResult(
                        run_case_id=run_case_id,
                        status=str(execution[run_case_id].get("status") or "failed"),
                        trajectory=execution[run_case_id].get("trajectory"),
                        output=execution[run_case_id].get("output"),
                    )
                    _update_progress("score_exec", run_case_id)
                    scorer_started = time.time()
                    job = self._scorer_executor.submit(
                        score_impl,
                        key,
                        case_map[run_case_id],
                        staged,
                        scorer_meta,
                    )
                    try:
                        value, reason, raw_result = await asyncio.wait_for(
                            asyncio.wrap_future(job),
                            timeout=max(1, int(self.settings.scorer_hard_timeout_seconds)),
                        )
                    except asyncio.TimeoutError:
                        job.cancel()
                        scorer_ms = int((time.time() - scorer_started) * 1000)
                        with execution_lock:
                            timings = execution[run_case_id].setdefault("scorer_timings_ms", {})
                            if isinstance(timings, dict):
                                timings[key] = scorer_ms
                            execution[run_case_id]["scorer_total_ms"] = int(
                                execution[run_case_id].get("scorer_total_ms") or 0
                            ) + scorer_ms
                        logger.warning(
                            "code=E_SCORER_TIMEOUT run_case_id=%s scorer_key=%s timeout_seconds=%s",
                            run_case_id,
                            key,
                            self.settings.scorer_hard_timeout_seconds,
                        )
                        return Score(
                            value=DEFAULT_SCORE_SENTINEL,
                            answer="",
                            explanation="E_SCORE_DEFAULT_SCORER_TIMEOUT",
                            metadata={
                                "scorer_key": key,
                                "evaluator_id": int(scorer_meta.get("id") or 0),
                                "evaluator_name": str(scorer_meta.get("name") or key),
                                "raw_result": {"source": "default", "timeout": True},
                            },
                        )
                    scorer_ms = int((time.time() - scorer_started) * 1000)
                    with execution_lock:
                        timings = execution[run_case_id].setdefault("scorer_timings_ms", {})
                        if isinstance(timings, dict):
                            timings[key] = scorer_ms
                        execution[run_case_id]["scorer_total_ms"] = int(
                            execution[run_case_id].get("scorer_total_ms") or 0
                        ) + scorer_ms
                    _update_progress("score_done", run_case_id)
                    return Score(
                        value=value,
                        answer="",
                        explanation=reason,
                        metadata={
                            "scorer_key": key,
                            "evaluator_id": int(scorer_meta.get("id") or 0),
                            "evaluator_name": str(scorer_meta.get("name") or key),
                            "raw_result": raw_result,
                        },
                    )

                return score_fn

            scorer_fns.append(runtime_scorer_factory())

        samples = [
            Sample(
                id=rc.run_case_id,
                input=rc.user_input,
                target=json.dumps(rc.reference_output, ensure_ascii=False),
                metadata={
                    "run_case_id": str(rc.run_case_id),
                    "sandbox_group_key": f"case-{rc.run_case_id}",
                    "trace_id": rc.trace_id or "",
                    "session_jsonl": rc.session_jsonl,
                    "runtime_spec_json": json.dumps(runtime_spec, ensure_ascii=False),
                    "case_env_json": json.dumps(self._build_case_env(message, rc, None), ensure_ascii=False),
                },
            )
            for rc in run_cases
        ]

        task = Task(
            dataset=samples,
            solver=[run_cases_in_shared_sandbox()],
            scorer=scorer_fns,
            sandbox=SandboxEnvironmentSpec(type="arcloop_docker"),
            metadata={"experiment_id": message.experiment.id},
            name=f"experiment_{message.experiment.id}",
        )

        try:
            logs = inspect_eval(
                task,
                model=None,
                log_samples=True,
                log_realtime=False,
                score=True,
                log_dir=str(inspect_logs_dir),
            )
        finally:
            hb_stop.set()
            hb_thread.join(timeout=1)
        if not logs:
            raise RuntimeError("inspect eval returned empty logs")
        logger.info(
            "code=INSPECT_EVAL_BATCH_DONE experiment_id=%s run_cases=%s elapsed_ms=%s",
            message.experiment.id,
            len(run_cases),
            int((time.time() - batch_started) * 1000),
        )

        eval_log = logs[0]
        eval_id = str(eval_log.eval.eval_id)
        sample_score_rows: dict[int, list[dict[str, Any]]] = {rc.run_case_id: [] for rc in run_cases}
        sample_usage: dict[int, dict[str, Any]] = {
            rc.run_case_id: {"inspect_enabled": True, "input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
            for rc in run_cases
        }

        for sample_log in eval_log.samples or []:
            run_case_id = int(sample_log.id)
            if sample_log.scores:
                for score_name, score_item in sample_log.scores.items():
                    scorer_key = str((score_item.metadata or {}).get("scorer_key") or score_name)
                    sample_score_rows[run_case_id].append(
                        {
                            "scorer_key": scorer_key,
                            "evaluator_id": int((score_item.metadata or {}).get("evaluator_id") or 0),
                            "evaluator_name": str((score_item.metadata or {}).get("evaluator_name") or scorer_key),
                            "score": float(score_item.as_float()),
                            "reason": str(score_item.explanation or ""),
                            "raw_result": {
                                "inspect_score": score_item.model_dump(),
                                "evaluator_result": (score_item.metadata or {}).get("raw_result") or {},
                            },
                        }
                    )
            if sample_log.model_usage:
                input_tokens = 0
                output_tokens = 0
                total_tokens = 0
                for model_usage in sample_log.model_usage.values():
                    input_tokens += int(getattr(model_usage, "input_tokens", 0) or 0)
                    output_tokens += int(getattr(model_usage, "output_tokens", 0) or 0)
                    total_tokens += int(getattr(model_usage, "total_tokens", 0) or 0)
                sample_usage[run_case_id].update(
                    {
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                        "total_tokens": total_tokens,
                    }
                )

        results: dict[int, CaseExecutionResult] = {}
        for run_case in run_cases:
            rec = execution[run_case.run_case_id]
            case_result = CaseExecutionResult(
                run_case_id=run_case.run_case_id,
                status=str(rec.get("status") or "failed"),
                trajectory=rec.get("trajectory"),
                output=rec.get("output"),
                logs=str(rec.get("logs") or ""),
                error_message=str(rec.get("error_message") or ""),
                exit_code=int(rec.get("exit_code") if rec.get("exit_code") is not None else 1),
                latency_ms=int(rec.get("latency_ms") or 0),
                container_id=str(rec.get("container_name") or ""),
                container_image=image,
                mock_sidecar_endpoint=str(rec.get("mock_sidecar_endpoint") or ""),
                inspect_eval_id=eval_id,
                inspect_sample_id=str(run_case.run_case_id),
                scorer_results=sample_score_rows.get(run_case.run_case_id) or self._fallback_scores(
                    message, run_case, CaseExecutionResult(run_case_id=run_case.run_case_id, status=str(rec.get("status") or "failed")), inspect_enabled=True
                ),
                usage=sample_usage.get(run_case.run_case_id, {"inspect_enabled": True}),
            )
            case_result.usage["timings_ms"] = {
                "sandbox_connect": int(rec.get("sandbox_connect_ms") or 0),
                "case_exec": int(rec.get("case_exec_ms") or 0),
                "scorer_total": int(rec.get("scorer_total_ms") or 0),
                "total": int(rec.get("latency_ms") or 0),
                "scorer_breakdown": rec.get("scorer_timings_ms") or {},
            }
            case_result.logs = (
                f"{case_result.logs}\n[inspect] eval_id={case_result.inspect_eval_id} sample_id={case_result.inspect_sample_id}"
            ).strip()
            results[run_case.run_case_id] = case_result
        return results

    async def _exec_case_with_startup_retry(
        self,
        *,
        sb: Any,
        run_case_id: int,
        case_exec_command: str,
        case_env: dict[str, str],
        runtime_spec: dict[str, Any],
    ) -> tuple[Any, str]:
        startup_retry_seconds = int(runtime_spec.get("startup_timeout_seconds") or 30)
        retry_interval_seconds = float(runtime_spec.get("startup_poll_interval_seconds") or 1)
        deadline = time.time() + max(startup_retry_seconds, 0)
        attempt = 0

        while True:
            attempt += 1
            exec_result = await sb.exec(
                ["sh", "-lc", case_exec_command],
                env=case_env,
                timeout=self.docker_runner.timeout_seconds,
            )
            raw_logs = f"{exec_result.stdout}\n{exec_result.stderr}".strip()
            if exec_result.returncode == 0:
                return exec_result, raw_logs
            if not self._is_agent_not_ready_error(exec_result.returncode, raw_logs):
                return exec_result, raw_logs
            if time.time() >= deadline:
                return exec_result, raw_logs
            logger.info(
                "code=CASE_EXEC_WAIT_AGENT_READY run_case_id=%s attempt=%s retry_in=%ss",
                run_case_id,
                attempt,
                retry_interval_seconds,
            )
            await asyncio.sleep(retry_interval_seconds)

    def _build_case_env(
        self,
        message: ExperimentRunRequested,
        run_case: RunCaseInput,
        mock_base_url: str | None,
    ) -> dict[str, str]:
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

    def _normalize_case_result_payload(
        self,
        parsed: dict[str, Any] | None,
        raw_stdout: str,
    ) -> tuple[Any, Any]:
        if not parsed:
            return {"raw_stdout": raw_stdout}, []
        if "output" in parsed:
            return parsed.get("output"), parsed.get("trajectory") if "trajectory" in parsed else []
        # OpenAI Chat Completions-compatible payload
        choices = parsed.get("choices")
        if isinstance(choices, list) and choices:
            first = choices[0]
            if isinstance(first, dict):
                message = first.get("message")
                if isinstance(message, dict) and message.get("content") is not None:
                    return message.get("content"), []
        # OpenResponses-compatible payload
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
        return parsed, []

    def _is_agent_not_ready_error(self, returncode: int, logs: str) -> bool:
        if returncode == 7:
            return True
        lowered = logs.lower()
        return (
            "curl: (7)" in lowered
            or "failed to connect" in lowered
            or "couldn't connect to server" in lowered
            or "connection refused" in lowered
        )

    def _docker_container_logs(self, container_name: str) -> str:
        if not container_name:
            return ""
        try:
            proc = subprocess.run(
                ["docker", "logs", container_name],
                check=False,
                capture_output=True,
                text=True,
                timeout=10,
            )
        except Exception as exc:
            return f"E_DOCKER_LOGS_READ: {exc}"
        merged = f"{proc.stdout}\n{proc.stderr}".strip()
        if not merged:
            return ""
        return merged[-8000:]

    def _fallback_scores(
        self,
        message: ExperimentRunRequested,
        run_case: RunCaseInput,
        result: CaseExecutionResult,
        *,
        inspect_enabled: bool,
    ) -> list[dict[str, Any]]:
        scorer_results: list[dict[str, Any]] = []
        score_specs = message.scorers or [{"scorer_key": "task_success"}]
        for scorer in score_specs:
            scorer_key = str(scorer.get("scorer_key") or scorer.get("evaluator_key") or "default")
            score, reason, raw_result = self._score_case(scorer_key, run_case, result, scorer)
            scorer_results.append(
                {
                    "scorer_key": scorer_key,
                    "evaluator_id": int(scorer.get("id") or 0),
                    "evaluator_name": str(scorer.get("name") or scorer_key),
                    "score": score,
                    "reason": reason,
                    "raw_result": raw_result
                    | {
                        "scorer": scorer,
                        "status": result.status,
                        "inspect_enabled": inspect_enabled,
                        "fallback": True,
                    },
                }
            )
        return scorer_results

    def _score_case(
        self,
        scorer_key: str,
        run_case: RunCaseInput,
        result: CaseExecutionResult,
        scorer_spec: dict[str, Any],
    ) -> tuple[float, str, dict[str, Any]]:
        if result.status != "success":
            return DEFAULT_SCORE_SENTINEL, "E_SCORE_DEFAULT_RUN_CASE_FAILED", {"source": "default"}

        scorer_config = scorer_spec.get("scorer_config") if isinstance(scorer_spec, dict) else {}
        if isinstance(scorer_config, dict):
            base_url = str(scorer_config.get("base_url") or "").strip()
            api_key = str(scorer_config.get("api_key") or "").strip()
            model_name = str(scorer_config.get("model_name") or "").strip()
            prompt_template = str(scorer_config.get("prompt_template") or "").strip()
            api_style = str(scorer_config.get("api_style") or "openai").strip().lower()
            timeout_seconds = self._as_int(
                scorer_config.get("timeout_seconds"),
                self.settings.evaluator_timeout_seconds or DEFAULT_EVALUATOR_TIMEOUT_SECONDS,
            )
            connect_timeout_seconds = self._as_int(
                scorer_config.get("connect_timeout_seconds"),
                self.settings.evaluator_connect_timeout_seconds or DEFAULT_EVALUATOR_CONNECT_TIMEOUT_SECONDS,
            )
            read_timeout_seconds = self._as_int(
                scorer_config.get("read_timeout_seconds"),
                self.settings.evaluator_read_timeout_seconds or DEFAULT_EVALUATOR_READ_TIMEOUT_SECONDS,
            )
            max_retries = self._as_int(
                scorer_config.get("max_retries"),
                self.settings.evaluator_max_retries or DEFAULT_EVALUATOR_MAX_RETRIES,
            )
            retry_backoff_seconds = self._as_float(
                scorer_config.get("retry_backoff_seconds"),
                self.settings.evaluator_retry_backoff_seconds or DEFAULT_EVALUATOR_RETRY_BACKOFF_SECONDS,
            )
            if base_url and api_key and model_name and prompt_template:
                try:
                    score_value, reason, raw = call_evaluator(
                        api_style=api_style,
                        base_url=base_url,
                        api_key=api_key,
                        model_name=model_name,
                        prompt_template=prompt_template,
                        payload=EvaluatorCallInput(
                            user_input=run_case.user_input,
                            trajectory=result.trajectory,
                            agent_output=result.output,
                            reference_output=run_case.reference_output,
                            tools={},
                        ),
                        timeout_seconds=timeout_seconds,
                        connect_timeout_seconds=connect_timeout_seconds,
                        read_timeout_seconds=read_timeout_seconds,
                        max_retries=max_retries,
                        retry_backoff_seconds=retry_backoff_seconds,
                    )
                    return score_value, reason, {"source": "llm", "response": raw}
                except Exception as exc:
                    logger.warning("code=E_EVALUATOR_CALL_FAILED scorer=%s err=%s", scorer_key, exc)
                    return DEFAULT_SCORE_SENTINEL, f"E_SCORE_DEFAULT_EVALUATOR_CALL_FAILED: {type(exc).__name__}", {"source": "default"}
        return DEFAULT_SCORE_SENTINEL, "E_SCORE_DEFAULT_EVALUATOR_CONFIG_MISSING", {"source": "default"}

    def _as_int(self, preferred: Any, default: int) -> int:
        if preferred is not None and str(preferred).strip() != "":
            try:
                return int(str(preferred))
            except Exception:
                return default
        return default

    def _as_float(self, preferred: Any, default: float) -> float:
        if preferred is not None and str(preferred).strip() != "":
            try:
                return float(str(preferred))
            except Exception:
                return default
        return default

