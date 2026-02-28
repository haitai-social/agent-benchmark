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
    scorer_concurrent_cases: int
    max_message_retries: int
    case_timeout_seconds: int
    docker_network: str | None
    agent_exec_command: str | None
    docker_pull_policy: str
    docker_pull_timeout_seconds: int
    docker_run_timeout_seconds: int
    docker_inspect_timeout_seconds: int
    otel_enabled: bool
    otel_endpoint: str | None
    otel_query_timeout_seconds: int
    otel_protocol: str
    otel_collector_enabled: bool
    otel_collector_host: str
    otel_collector_port: int
    otel_collector_path: str
    otel_public_endpoint: str | None
    redis_host: str
    redis_port: int
    redis_username: str | None
    redis_password: str | None
    redis_db: int
    redis_processing_lock_ttl_seconds: int
    redis_processed_ttl_seconds: int
    database_engine: str
    postgres_server: str | None
    postgres_port: int
    postgres_user: str | None
    postgres_password: str | None
    postgres_db: str | None
    mysql_server: str | None
    mysql_port: int
    mysql_user: str | None
    mysql_password: str | None
    mysql_db: str | None
    evaluator_timeout_seconds: int
    evaluator_connect_timeout_seconds: int
    evaluator_read_timeout_seconds: int
    evaluator_max_retries: int
    evaluator_retry_backoff_seconds: float
    scorer_hard_timeout_seconds: int

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


def _as_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError as e:
        raise ValueError(f"Invalid float env {name}={raw!r}") from e


def _as_pull_policy(name: str, default: str) -> str:
    raw = (os.getenv(name) or default).strip().lower()
    allowed = {"always", "if-not-present", "never"}
    if raw not in allowed:
        raise ValueError(f"Invalid pull policy env {name}={raw!r}, expected one of {sorted(allowed)}")
    return raw


def _as_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    lowered = raw.strip().lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"Invalid boolean env {name}={raw!r}")


def load_settings() -> Settings:
    database_engine = (os.getenv("DATEBASE_ENGINE") or os.getenv("DATABASE_ENGINE") or "postgres").strip().lower()
    if database_engine not in {"postgres", "mysql"}:
        raise ValueError(f"Invalid DATABASE_ENGINE={database_engine!r}, expected postgres/mysql")

    return Settings(
        rabbitmq_host=_must_env("RABBITMQ_HOST"),
        rabbitmq_port=_as_int("RABBITMQ_PORT", 5672),
        rabbitmq_user=_must_env("RABBITMQ_USER"),
        rabbitmq_password=_must_env("RABBITMQ_PASSWORD"),
        rabbitmq_vhost=os.getenv("RABBITMQ_VHOST", "/"),
        rabbitmq_experiment_queue=os.getenv("RABBITMQ_EXPERIMENT_QUEUE", "haitai.agent.benchmark.experiment"),
        concurrent_cases=_as_int("CONSUMER_CONCURRENT_CASES", 2),
        scorer_concurrent_cases=_as_int("CONSUMER_SCORER_CONCURRENT_CASES", 2),
        max_message_retries=_as_int("CONSUMER_MAX_RETRIES", 3),
        case_timeout_seconds=_as_int("CONSUMER_CASE_TIMEOUT_SECONDS", 180),
        docker_network=os.getenv("CONSUMER_DOCKER_NETWORK") or None,
        agent_exec_command=os.getenv("CONSUMER_AGENT_EXEC_COMMAND") or None,
        docker_pull_policy=_as_pull_policy("CONSUMER_DOCKER_PULL_POLICY", "always"),
        docker_pull_timeout_seconds=_as_int("CONSUMER_DOCKER_PULL_TIMEOUT_SECONDS", 120),
        docker_run_timeout_seconds=_as_int("CONSUMER_DOCKER_RUN_TIMEOUT_SECONDS", 60),
        docker_inspect_timeout_seconds=_as_int("CONSUMER_DOCKER_INSPECT_TIMEOUT_SECONDS", 10),
        otel_enabled=_as_bool("CONSUMER_OTEL_ENABLED", False),
        otel_endpoint=os.getenv("CONSUMER_OTEL_ENDPOINT") or None,
        otel_query_timeout_seconds=_as_int("CONSUMER_OTEL_QUERY_TIMEOUT_SECONDS", 10),
        otel_protocol=os.getenv("CONSUMER_OTEL_PROTOCOL", "http/protobuf"),
        otel_collector_enabled=_as_bool("CONSUMER_OTEL_COLLECTOR_ENABLED", True),
        otel_collector_host=os.getenv("CONSUMER_OTEL_COLLECTOR_HOST", "0.0.0.0"),
        otel_collector_port=_as_int("CONSUMER_OTEL_COLLECTOR_PORT", 14318),
        otel_collector_path=os.getenv("CONSUMER_OTEL_COLLECTOR_PATH", "/v1/traces"),
        otel_public_endpoint=os.getenv("CONSUMER_OTEL_PUBLIC_ENDPOINT") or None,
        redis_host=_must_env("REDIS_HOST"),
        redis_port=_as_int("REDIS_PORT", 6379),
        redis_username=os.getenv("REDIS_USERNAME") or None,
        redis_password=os.getenv("REDIS_PASSWORD") or None,
        redis_db=_as_int("REDIS_DB", 0),
        redis_processing_lock_ttl_seconds=_as_int("CONSUMER_REDIS_PROCESSING_LOCK_TTL_SECONDS", 300),
        redis_processed_ttl_seconds=_as_int("CONSUMER_REDIS_PROCESSED_TTL_SECONDS", 86400),
        database_engine=database_engine,
        postgres_server=os.getenv("POSTGRES_SERVER"),
        postgres_port=_as_int("POSTGRES_PORT", 5432),
        postgres_user=os.getenv("POSTGRES_USER"),
        postgres_password=os.getenv("POSTGRES_PASSWORD"),
        postgres_db=os.getenv("POSTGRES_DB"),
        mysql_server=os.getenv("MYSQL_SERVER"),
        mysql_port=_as_int("MYSQL_PORT", 3306),
        mysql_user=os.getenv("MYSQL_USER"),
        mysql_password=os.getenv("MYSQL_PASSWORD"),
        mysql_db=os.getenv("MYSQL_DB"),
        evaluator_timeout_seconds=_as_int("CONSUMER_EVALUATOR_TIMEOUT_SECONDS", 90),
        evaluator_connect_timeout_seconds=_as_int("CONSUMER_EVALUATOR_CONNECT_TIMEOUT_SECONDS", 15),
        evaluator_read_timeout_seconds=_as_int("CONSUMER_EVALUATOR_READ_TIMEOUT_SECONDS", 90),
        evaluator_max_retries=_as_int("CONSUMER_EVALUATOR_MAX_RETRIES", 2),
        evaluator_retry_backoff_seconds=_as_float("CONSUMER_EVALUATOR_RETRY_BACKOFF_SECONDS", 1.0),
        scorer_hard_timeout_seconds=_as_int("CONSUMER_SCORER_HARD_TIMEOUT_SECONDS", 120),
    )
