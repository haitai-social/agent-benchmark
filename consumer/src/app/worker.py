from __future__ import annotations

import logging

from infrastructure.config import Settings
from infrastructure.db_repository import DbRepository
from infrastructure.docker_runner import DockerRunner
from infrastructure.locks import RedisMessageLock
from infrastructure.mq_consumer import RabbitMqConsumer
from runtime.inspect_runner import InspectRunner
from .message_processor import MessageProcessor

logger = logging.getLogger(__name__)


class ConsumerWorker:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        runner = DockerRunner(
            timeout_seconds=settings.case_timeout_seconds,
            docker_network=settings.docker_network,
            agent_exec_command=settings.agent_exec_command,
            pull_policy=settings.docker_pull_policy,
            pull_timeout_seconds=settings.docker_pull_timeout_seconds,
            run_timeout_seconds=settings.docker_run_timeout_seconds,
            inspect_timeout_seconds=settings.docker_inspect_timeout_seconds,
        )
        inspect_runner = InspectRunner(runner, settings=settings)
        lock = RedisMessageLock.from_settings(settings)
        db = DbRepository.from_settings(settings)
        self.processor = MessageProcessor(settings=settings, runner=inspect_runner, lock=lock, db=db)
        self.consumer = RabbitMqConsumer(settings)

    def start(self) -> None:
        logger.info(
            "consumer started queue=%s concurrency=%s",
            self.settings.rabbitmq_experiment_queue,
            self.settings.concurrent_cases,
        )
        self.consumer.start(self.processor.handle_raw_message)
