from infrastructure.config import Settings
from infrastructure.mq_consumer import RabbitMqConsumer


class _FakeChannel:
    def __init__(self, *, is_open: bool) -> None:
        self.is_open = is_open
        self.acks: list[int] = []
        self.nacks: list[tuple[int, bool]] = []

    def basic_ack(self, delivery_tag: int) -> None:
        self.acks.append(delivery_tag)

    def basic_nack(self, delivery_tag: int, requeue: bool) -> None:
        self.nacks.append((delivery_tag, requeue))


def _settings(case_timeout_seconds: int = 180) -> Settings:
    return Settings(
        rabbitmq_host="127.0.0.1",
        rabbitmq_port=5672,
        rabbitmq_user="guest",
        rabbitmq_password="guest",
        rabbitmq_vhost="/",
        rabbitmq_experiment_queue="q",
        concurrent_cases=2,
        scorer_concurrent_cases=2,
        max_message_retries=3,
        case_timeout_seconds=case_timeout_seconds,
        docker_network=None,
        agent_exec_command=None,
        docker_pull_policy="always",
        docker_pull_timeout_seconds=120,
        docker_run_timeout_seconds=60,
        docker_inspect_timeout_seconds=10,
        redis_host="127.0.0.1",
        redis_port=6379,
        redis_username=None,
        redis_password=None,
        redis_db=0,
        redis_processing_lock_ttl_seconds=300,
        redis_processed_ttl_seconds=86400,
        database_engine="postgres",
        postgres_server=None,
        postgres_port=5432,
        postgres_user=None,
        postgres_password=None,
        postgres_db=None,
        mysql_server=None,
        mysql_port=3306,
        mysql_user=None,
        mysql_password=None,
        mysql_db=None,
        evaluator_timeout_seconds=90,
        evaluator_connect_timeout_seconds=15,
        evaluator_read_timeout_seconds=90,
        evaluator_max_retries=2,
        evaluator_retry_backoff_seconds=1.0,
        scorer_hard_timeout_seconds=120,
    )


def test_build_connection_params_heartbeat_floor() -> None:
    consumer = RabbitMqConsumer(_settings(case_timeout_seconds=120))
    params = consumer._build_connection_params()
    assert params.heartbeat == 600
    assert params.blocked_connection_timeout == 600


def test_build_connection_params_heartbeat_scale_with_timeout() -> None:
    consumer = RabbitMqConsumer(_settings(case_timeout_seconds=400))
    params = consumer._build_connection_params()
    assert params.heartbeat == 800
    assert params.blocked_connection_timeout == 800


def test_safe_ack_returns_false_when_channel_closed() -> None:
    channel = _FakeChannel(is_open=False)
    ok = RabbitMqConsumer._safe_ack(channel, 11)
    assert ok is False
    assert channel.acks == []


def test_safe_nack_returns_false_when_channel_closed() -> None:
    channel = _FakeChannel(is_open=False)
    ok = RabbitMqConsumer._safe_nack(channel, 12, requeue=False)
    assert ok is False
    assert channel.nacks == []
