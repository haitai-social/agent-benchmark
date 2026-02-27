from __future__ import annotations

import logging
import time
from collections.abc import Callable

import pika

from .config import Settings

logger = logging.getLogger(__name__)

MessageHandler = Callable[[bytes], None]


class RabbitMqConsumer:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def start(self, handler: MessageHandler) -> None:
        params = pika.URLParameters(self.settings.rabbitmq_url)
        connection = pika.BlockingConnection(params)
        channel = connection.channel()
        channel.queue_declare(queue=self.settings.rabbitmq_experiment_queue, durable=True)
        channel.basic_qos(prefetch_count=1)

        def _on_message(ch, method, properties, body: bytes) -> None:
            del properties
            try:
                handler(body)
                ch.basic_ack(delivery_tag=method.delivery_tag)
            except Exception as exc:
                logger.error("code=E_MESSAGE_PROCESS err=%s", exc)
                ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)

        channel.basic_consume(queue=self.settings.rabbitmq_experiment_queue, on_message_callback=_on_message)
        logger.info("consumer started queue=%s", self.settings.rabbitmq_experiment_queue)
        channel.start_consuming()

    def receive_once(self, handler: MessageHandler, timeout_seconds: int = 10) -> bool:
        params = pika.URLParameters(self.settings.rabbitmq_url)
        connection = pika.BlockingConnection(params)
        channel = connection.channel()
        channel.queue_declare(queue=self.settings.rabbitmq_experiment_queue, durable=True)

        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            method, properties, body = channel.basic_get(queue=self.settings.rabbitmq_experiment_queue, auto_ack=False)
            if method is None:
                time.sleep(0.2)
                continue
            try:
                del properties
                handler(body)
                channel.basic_ack(delivery_tag=method.delivery_tag)
                return True
            except Exception:
                channel.basic_nack(delivery_tag=method.delivery_tag, requeue=False)
                raise
        return False
