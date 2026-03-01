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
    os.environ.pop("RABBITMQ_HOST", None)
    os.environ.pop("RABBITMQ_USER", None)
    os.environ.pop("RABBITMQ_PASSWORD", None)
    os.environ.pop("REDIS_HOST", None)
