from __future__ import annotations

import json
import sys
import uuid

from infrastructure.config import Settings
from infrastructure.mq_consumer import RabbitMqConsumer


def main() -> int:
    try:
        from testcontainers.rabbitmq import RabbitMqContainer
        import pika
    except Exception as e:
        raise RuntimeError("testcontainers and pika are required to run this smoke test") from e

    queue_name = "haitai.agent.benchmark.experiment.smoke"
    message_id = f"smoke-{uuid.uuid4()}"
    payload = {
        "message_type": "experiment.run.requested",
        "schema_version": "v2",
        "message_id": message_id,
        "run_cases": [],
        "experiment": {"id": 1, "triggered_by": "smoke"},
        "dataset": {"id": 1, "name": "smoke"},
        "agent": {
            "id": 1,
            "name": "smoke",
            "agent_key": "smoke",
            "version": "v1",
            "runtime_spec_json": {"runtime_type": "agno_docker", "agent_image": "alpine:3.20"},
        },
        "scorers": [],
    }

    with RabbitMqContainer("rabbitmq:3.13-management") as rabbit:
        settings = Settings(
            rabbitmq_host=rabbit.get_container_host_ip(),
            rabbitmq_port=int(rabbit.get_exposed_port(5672)),
            rabbitmq_user="guest",
            rabbitmq_password="guest",
            rabbitmq_vhost="/",
            rabbitmq_experiment_queue=queue_name,
            concurrent_cases=1,
            scorer_concurrent_cases=1,
            max_message_retries=1,
            case_timeout_seconds=30,
            docker_network=None,
            agent_exec_command=None,
            docker_pull_policy="always",
            docker_pull_timeout_seconds=30,
            docker_run_timeout_seconds=30,
            docker_inspect_timeout_seconds=10,
            otel_enabled=False,
            otel_endpoint=None,
            otel_query_timeout_seconds=10,
            otel_protocol="http/json",
            otel_collector_enabled=False,
            otel_collector_host="0.0.0.0",
            otel_collector_port=14318,
            otel_collector_path="/v1/traces",
            otel_public_endpoint=None,
            redis_host="127.0.0.1",
            redis_port=6379,
            redis_username=None,
            redis_password=None,
            redis_db=0,
            redis_processing_lock_ttl_seconds=60,
            redis_processed_ttl_seconds=3600,
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
            evaluator_timeout_seconds=30,
            evaluator_connect_timeout_seconds=10,
            evaluator_read_timeout_seconds=30,
            evaluator_max_retries=1,
            evaluator_retry_backoff_seconds=1.0,
            scorer_hard_timeout_seconds=60,
        )

        params = pika.URLParameters(settings.rabbitmq_url)
        connection = pika.BlockingConnection(params)
        channel = connection.channel()
        channel.queue_declare(queue=queue_name, durable=True)
        channel.basic_publish(exchange="", routing_key=queue_name, body=json.dumps(payload).encode("utf-8"))
        connection.close()

        received: list[str] = []

        def _handler(body: bytes) -> None:
            parsed = json.loads(body.decode("utf-8"))
            received.append(parsed.get("message_id", ""))

        consumer = RabbitMqConsumer(settings)
        ok = consumer.receive_once(_handler, timeout_seconds=15)
        print(json.dumps({"received": ok, "message_ids": received}, ensure_ascii=False))
        if not ok or received != [message_id]:
            return 1
        return 0


if __name__ == "__main__":
    sys.exit(main())
