from __future__ import annotations

import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from domain.otel_mapper import map_logs_to_trajectory, map_spans_to_trajectory
from domain.contracts import CaseExecutionResult
from domain.parser import parse_message
from infrastructure.config import Settings
from infrastructure.db_repository import DbRepository
from infrastructure.locks import MessageLock
from infrastructure.trace_repository import TraceRepository
from runtime.inspect_runner import InspectRunner

logger = logging.getLogger(__name__)


class MessageProcessor:
    def __init__(self, settings: Settings, runner: InspectRunner, lock: MessageLock, db: DbRepository) -> None:
        self.settings = settings
        self.runner = runner
        self.lock = lock
        self.db = db
        self.trace_repo = TraceRepository.from_settings(settings)

    def handle_raw_message(self, body: bytes) -> None:
        payload = json.loads(body.decode("utf-8"))
        message = parse_message(payload)
        if message.message_type != "experiment.run.requested":
            raise ValueError(f"E_UNSUPPORTED_MESSAGE_TYPE: {message.message_type}")
        logger.info(
            "code=MESSAGE_RECEIVED message_id=%s experiment_id=%s run_cases=%s",
            message.message_id,
            message.experiment.id,
            len(message.run_cases),
        )

        key_suffix = self.lock.build_suffix(message.message_id, body)
        if self.lock.already_processed(key_suffix):
            return
        if not self.lock.acquire_processing(key_suffix):
            return

        try:
            self._process_message(message)
            self.lock.mark_processed(key_suffix)
        except Exception:
            self.lock.release_processing(key_suffix)
            raise
        self.lock.release_processing(key_suffix)

    def _process_message(self, message) -> None:
        experiment_started = time.time()
        logger.info(
            "code=EXPERIMENT_EXEC_START experiment_id=%s message_id=%s run_cases=%s",
            message.experiment.id,
            message.message_id,
            len(message.run_cases),
        )
        queue_status, queue_message_id = self.db.get_experiment_queue_state(message.experiment.id)
        if queue_status == "manual_terminated":
            logger.info(
                "code=MESSAGE_SKIPPED_MANUAL_TERMINATED message_id=%s experiment_id=%s",
                message.message_id,
                message.experiment.id,
            )
            return
        if queue_message_id and queue_message_id != message.message_id:
            logger.info(
                "code=MESSAGE_SKIPPED_STALE message_id=%s expected_message_id=%s experiment_id=%s",
                message.message_id,
                queue_message_id,
                message.experiment.id,
            )
            return

        last_error: Exception | None = None
        for i in range(1, self.settings.max_message_retries + 1):
            try:
                self._execute_cases(message)
                logger.info(
                    "code=EXPERIMENT_EXEC_DONE experiment_id=%s message_id=%s elapsed_ms=%s",
                    message.experiment.id,
                    message.message_id,
                    int((time.time() - experiment_started) * 1000),
                )
                return
            except Exception as exc:
                last_error = exc
                logger.warning(
                    "code=E_RUN_ATTEMPT_FAILED attempt=%d/%d experiment_id=%s elapsed_ms=%s err=%s",
                    i,
                    self.settings.max_message_retries,
                    message.experiment.id,
                    int((time.time() - experiment_started) * 1000),
                    exc,
                )
                time.sleep(i * 0.5)
        raise RuntimeError(f"E_RUN_RETRIES_EXCEEDED: {last_error}")

    def _execute_cases(self, message) -> None:
        batch_started = time.time()
        failures = 0
        status_cache: dict[int, str] = {}
        scoring_active: dict[int, int] = {}
        for rc in message.run_cases:
            logger.info("code=CASE_EXEC_START run_case_id=%s", rc.run_case_id)
        run_case_ids = [rc.run_case_id for rc in message.run_cases]
        self.db.mark_cases_queued(
            experiment_id=message.experiment.id,
            run_case_ids=run_case_ids,
        )

        case_results: dict[int, CaseExecutionResult] = {}
        run_phase_started = time.time()
        logger.info(
            "code=RUNNER_PHASE_START experiment_id=%s run_cases=%s pool_size=%s",
            message.experiment.id,
            len(message.run_cases),
            self.settings.concurrent_cases,
        )

        def progress_callback(run_case_id: int, phase: str) -> None:
            if phase == "score_exec":
                current = int(scoring_active.get(run_case_id) or 0) + 1
                scoring_active[run_case_id] = current
                if current == 1:
                    self.db.mark_case_status(
                        experiment_id=message.experiment.id,
                        run_case_id=run_case_id,
                        status="scoring",
                    )
                    status_cache[run_case_id] = "scoring"
                return
            if phase == "score_done":
                current = max(0, int(scoring_active.get(run_case_id) or 0) - 1)
                scoring_active[run_case_id] = current
                if current == 0:
                    self.db.mark_case_status(
                        experiment_id=message.experiment.id,
                        run_case_id=run_case_id,
                        status="trajectory",
                    )
                    status_cache[run_case_id] = "trajectory"
                return
            mapped_status = self._status_from_phase(phase)
            if mapped_status is None:
                return
            if status_cache.get(run_case_id) == mapped_status:
                return
            self.db.mark_case_status(
                experiment_id=message.experiment.id,
                run_case_id=run_case_id,
                status=mapped_status,
            )
            status_cache[run_case_id] = mapped_status

        if hasattr(self.runner, "run_cases"):
            try:
                case_results = self.runner.run_cases(
                    message,
                    message.run_cases,
                    progress_callback=progress_callback,
                )
            except TypeError:
                case_results = self.runner.run_cases(message, message.run_cases)
        else:
            with ThreadPoolExecutor(max_workers=self.settings.concurrent_cases) as pool:
                futures = []
                for rc in message.run_cases:
                    futures.append(pool.submit(self._run_single_case_with_status, message, rc))
                future_run_case_map = {f: rc for f, rc in zip(futures, message.run_cases)}
                for future in as_completed(futures):
                    run_case = future_run_case_map[future]
                    case_results[run_case.run_case_id] = future.result()
        logger.info(
            "code=RUNNER_PHASE_DONE experiment_id=%s run_cases=%s elapsed_ms=%s",
            message.experiment.id,
            len(message.run_cases),
            int((time.time() - run_phase_started) * 1000),
        )

        for run_case in message.run_cases:
            res = case_results[run_case.run_case_id]
            if self._is_empty_trajectory(res.trajectory):
                patched = self._trajectory_from_traces(run_case_id=run_case.run_case_id)
                if patched:
                    res.trajectory = patched
            runtime_snapshot = self.runner.runtime_snapshot(message, run_case)
            self.db.persist_case_result(
                experiment_id=message.experiment.id,
                run_case_id=res.run_case_id,
                result=res,
                runtime_snapshot=runtime_snapshot,
            )
            if res.status != "success":
                failures += 1
                logger.error(
                    "code=E_CASE_FAILED run_case_id=%s error=%s logs=%s",
                    res.run_case_id,
                    res.error_message,
                    res.logs[:512],
                )
            else:
                timings = (res.usage or {}).get("timings_ms") if isinstance(res.usage, dict) else None
                if isinstance(timings, dict):
                    logger.info(
                        "code=CASE_COMPLETED run_case_id=%s latency_ms=%s docker_start_ms=%s case_exec_ms=%s otel_query_ms=%s scorer_ms=%s",
                        res.run_case_id,
                        res.latency_ms,
                        timings.get("sandbox_connect", 0),
                        timings.get("case_exec", 0),
                        timings.get("otel_query", 0),
                        timings.get("scorer_total", 0),
                    )
                else:
                    logger.info("code=CASE_COMPLETED run_case_id=%s latency_ms=%s", res.run_case_id, res.latency_ms)

        if failures > 0:
            raise RuntimeError(f"{failures}/{len(message.run_cases)} run cases failed")
        logger.info(
            "code=CASE_BATCH_DONE experiment_id=%s run_cases=%s failures=%s elapsed_ms=%s",
            message.experiment.id,
            len(message.run_cases),
            failures,
            int((time.time() - batch_started) * 1000),
        )

    def _run_single_case_with_status(self, message, run_case) -> CaseExecutionResult:
        self.db.mark_case_status(
            experiment_id=message.experiment.id,
            run_case_id=run_case.run_case_id,
            status="running",
        )
        return self.runner.run_case(message, run_case)

    def _status_from_phase(self, phase: str) -> str | None:
        if phase in {"sandbox_connect", "case_exec"}:
            return "running"
        if phase == "otel_query":
            return "trajectory"
        return None

    def _trajectory_from_traces(self, *, run_case_id: int) -> list[dict]:
        now_ms = int(time.time() * 1000)
        try:
            logs = self.trace_repo.fetch_logs_by_run_case(
                run_case_id=run_case_id,
                start_ms=now_ms - 15 * 60 * 1000,
                end_ms=now_ms + 60 * 1000,
                limit=4000,
            )
            mapped_logs = map_logs_to_trajectory(logs)
            if isinstance(mapped_logs, list) and mapped_logs:
                return mapped_logs

            spans = self.trace_repo.fetch_spans_by_run_case(
                run_case_id=run_case_id,
                start_ms=now_ms - 15 * 60 * 1000,
                end_ms=now_ms + 60 * 1000,
                limit=2000,
            )
            mapped = map_spans_to_trajectory(spans)
            if isinstance(mapped, list):
                return mapped
        except Exception as exc:
            logger.warning("code=E_TRAJECTORY_FROM_TRACES_FAILED run_case_id=%s err=%s", run_case_id, exc)
        return []

    def _is_empty_trajectory(self, trajectory: object) -> bool:
        if trajectory is None:
            return True
        if isinstance(trajectory, list):
            return len(trajectory) == 0
        if isinstance(trajectory, str):
            return trajectory.strip() == ""
        return False
