from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    rabbitmq_host: str
    rabbitmq_port: int
    rabbitmq_user: str
    rabbitmq_password: str
    rabbitmq_vhost: str
    rabbitmq_experiment_queue: str
    concurrent_cases: int
    max_message_retries: int
    case_timeout_seconds: int
    docker_network: str | None
    agent_exec_command: str | None

    @property
    def rabbitmq_url(self) -> str:
        from urllib.parse import quote

        user = quote(self.rabbitmq_user, safe="")
        password = quote(self.rabbitmq_password, safe="")
        vhost = "%2F" if self.rabbitmq_vhost == "/" else quote(self.rabbitmq_vhost, safe="")
        return f"amqp://{user}:{password}@{self.rabbitmq_host}:{self.rabbitmq_port}/{vhost}"


def _must_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise ValueError(f"Missing required env var: {name}")
    return v


def _as_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as e:
        raise ValueError(f"Invalid integer env {name}={raw!r}") from e


def load_settings() -> Settings:
    return Settings(
        rabbitmq_host=_must_env("RABBITMQ_HOST"),
        rabbitmq_port=_as_int("RABBITMQ_PORT", 5672),
        rabbitmq_user=_must_env("RABBITMQ_USER"),
        rabbitmq_password=_must_env("RABBITMQ_PASSWORD"),
        rabbitmq_vhost=os.getenv("RABBITMQ_VHOST", "/"),
        rabbitmq_experiment_queue=os.getenv("RABBITMQ_EXPERIMENT_QUEUE", "haitai.agent.benchmark.experiment"),
        concurrent_cases=_as_int("CONSUMER_CONCURRENT_CASES", 4),
        max_message_retries=_as_int("CONSUMER_MAX_RETRIES", 3),
        case_timeout_seconds=_as_int("CONSUMER_CASE_TIMEOUT_SECONDS", 180),
        docker_network=os.getenv("CONSUMER_DOCKER_NETWORK") or None,
        agent_exec_command=os.getenv("CONSUMER_AGENT_EXEC_COMMAND") or None,
    )
