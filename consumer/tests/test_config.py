import os

from infrastructure.config import load_settings


def test_load_settings(monkeypatch) -> None:
    monkeypatch.setenv("RABBITMQ_HOST", "127.0.0.1")
    monkeypatch.setenv("RABBITMQ_USER", "guest")
    monkeypatch.setenv("RABBITMQ_PASSWORD", "guest")
    monkeypatch.setenv("RABBITMQ_VHOST", "/")
    monkeypatch.setenv("REDIS_HOST", "127.0.0.1")
    settings = load_settings()
    assert settings.rabbitmq_url.startswith("amqp://guest:guest@127.0.0.1")
    assert "%2F" in settings.rabbitmq_url
    assert settings.concurrent_cases > 0
    assert settings.docker_pull_policy == "always"
    assert settings.redis_host == "127.0.0.1"
    assert settings.redis_processing_lock_ttl_seconds == 300
    assert settings.redis_processed_ttl_seconds == 86400
    assert settings.otel_enabled is False
    assert settings.otel_query_timeout_seconds == 10
    monkeypatch.setenv("CONSUMER_OTEL_ENABLED", "true")
    monkeypatch.setenv("CONSUMER_OTEL_PUBLIC_ENDPOINT", "http://host.docker.internal:4318/v1/traces")
    monkeypatch.setenv("CONSUMER_OTEL_COLLECTOR_ENABLED", "true")
    settings = load_settings()
    assert settings.otel_enabled is True
    assert settings.otel_public_endpoint == "http://host.docker.internal:4318/v1/traces"
    assert settings.otel_collector_enabled is True
    os.environ.pop("RABBITMQ_HOST", None)
    os.environ.pop("RABBITMQ_USER", None)
    os.environ.pop("RABBITMQ_PASSWORD", None)
    os.environ.pop("REDIS_HOST", None)
