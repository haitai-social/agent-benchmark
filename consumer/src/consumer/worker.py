from __future__ import annotations

import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from .config import Settings
from .docker_runner import DockerRunner
from .parser import parse_message

logger = logging.getLogger(__name__)


class ConsumerWorker:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.runner = DockerRunner(
            timeout_seconds=settings.case_timeout_seconds,
            docker_network=settings.docker_network,
            agent_exec_command=settings.agent_exec_command,
        )

    def start(self) -> None:
        try:
            import pika
        except Exception as e:
            raise RuntimeError("pika is required to run consumer") from e

        params = pika.URLParameters(self.settings.rabbitmq_url)
        connection = pika.BlockingConnection(params)
        channel = connection.channel()
        channel.queue_declare(queue=self.settings.rabbitmq_experiment_queue, durable=True)
        channel.basic_qos(prefetch_count=1)

        def _on_message(ch, method, properties, body: bytes) -> None:
            try:
                payload = json.loads(body.decode("utf-8"))
                message = parse_message(payload)
                if message.message_type != "experiment.run.requested":
                    raise ValueError(f"E_UNSUPPORTED_MESSAGE_TYPE: {message.message_type}")
                self._process_message(message)
                ch.basic_ack(delivery_tag=method.delivery_tag)
            except Exception as exc:
                logger.error("code=E_MESSAGE_PROCESS err=%s", exc)
                ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)

        channel.basic_consume(queue=self.settings.rabbitmq_experiment_queue, on_message_callback=_on_message)
        logger.info("consumer started queue=%s concurrency=%s", self.settings.rabbitmq_experiment_queue, self.settings.concurrent_cases)
        channel.start_consuming()

    def _process_message(self, message) -> None:
        last_error: Exception | None = None
        for i in range(1, self.settings.max_message_retries + 1):
            try:
                self._execute_cases(message)
                return
            except Exception as exc:
                last_error = exc
                logger.warning("code=E_RUN_ATTEMPT_FAILED attempt=%d/%d err=%s", i, self.settings.max_message_retries, exc)
                time.sleep(i * 0.5)
        raise RuntimeError(f"E_RUN_RETRIES_EXCEEDED: {last_error}")

    def _execute_cases(self, message) -> None:
        failures = 0
        with ThreadPoolExecutor(max_workers=self.settings.concurrent_cases) as pool:
            futures = [pool.submit(self.runner.run_case, message, rc) for rc in message.run_cases]
            for future in as_completed(futures):
                res = future.result()
                if res.status != "success":
                    failures += 1
                    logger.error(
                        "code=E_CASE_FAILED run_case_id=%s error=%s logs=%s",
                        res.run_case_id,
                        res.error_message,
                        res.logs[:512],
                    )
                else:
                    logger.info("code=CASE_COMPLETED run_case_id=%s latency_ms=%s", res.run_case_id, res.latency_ms)

        if failures > 0:
            raise RuntimeError(f"{failures}/{len(message.run_cases)} run cases failed")
