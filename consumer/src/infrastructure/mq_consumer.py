from __future__ import annotations

import logging
import time
from collections.abc import Callable

import pika
from pika.adapters.blocking_connection import BlockingChannel, BlockingConnection
from pika.exceptions import AMQPConnectionError, AMQPError, ChannelWrongStateError, StreamLostError

from .config import Settings

logger = logging.getLogger(__name__)

MessageHandler = Callable[[bytes], None]


class RabbitMqConsumer:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _build_connection_params(self) -> pika.URLParameters:
        params = pika.URLParameters(self.settings.rabbitmq_url)
        # Blocking callback may run for a long time, so heartbeat must be comfortably above
        # single-case timeout to avoid broker closing the socket during message handling.
        params.heartbeat = max(self.settings.case_timeout_seconds * 2, 600)
        params.blocked_connection_timeout = max(self.settings.case_timeout_seconds * 2, 600)
        return params

    def _declare_channel(self, connection: BlockingConnection) -> BlockingChannel:
        channel = connection.channel()
        channel.queue_declare(queue=self.settings.rabbitmq_experiment_queue, durable=True)
        channel.basic_qos(prefetch_count=1)
        return channel

    @staticmethod
    def _safe_ack(channel: BlockingChannel, delivery_tag: int) -> bool:
        if not channel.is_open:
            logger.warning("skip ack because channel already closed delivery_tag=%s", delivery_tag)
            return False
        try:
            channel.basic_ack(delivery_tag=delivery_tag)
            return True
        except (AMQPError, OSError) as exc:
            logger.error("code=E_ACK_FAILED delivery_tag=%s err=%s", delivery_tag, exc)
            return False

    @staticmethod
    def _safe_nack(channel: BlockingChannel, delivery_tag: int, *, requeue: bool) -> bool:
        if not channel.is_open:
            logger.warning("skip nack because channel already closed delivery_tag=%s", delivery_tag)
            return False
        try:
            channel.basic_nack(delivery_tag=delivery_tag, requeue=requeue)
            return True
        except (AMQPError, OSError) as exc:
            logger.error("code=E_NACK_FAILED delivery_tag=%s err=%s", delivery_tag, exc)
            return False

    def start(self, handler: MessageHandler) -> None:
        reconnect_backoff_seconds = 2
        while True:
            connection: BlockingConnection | None = None
            try:
                params = self._build_connection_params()
                connection = pika.BlockingConnection(params)
                channel = self._declare_channel(connection)

                def _on_message(
                    ch: BlockingChannel, method: pika.spec.Basic.Deliver, properties: pika.BasicProperties, body: bytes
                ) -> None:
                    del properties
                    try:
                        handler(body)
                        if not self._safe_ack(ch, method.delivery_tag):
                            raise StreamLostError("ack failed due to closed or unhealthy channel")
                    except Exception as exc:
                        logger.error("code=E_MESSAGE_PROCESS err=%s", exc)
                        if not self._safe_nack(ch, method.delivery_tag, requeue=False):
                            raise

                channel.basic_consume(queue=self.settings.rabbitmq_experiment_queue, on_message_callback=_on_message)
                logger.info(
                    "consumer started queue=%s heartbeat=%s blocked_timeout=%s",
                    self.settings.rabbitmq_experiment_queue,
                    params.heartbeat,
                    params.blocked_connection_timeout,
                )
                channel.start_consuming()
            except (AMQPConnectionError, StreamLostError, OSError, ChannelWrongStateError) as exc:
                logger.error(
                    "code=E_MQ_CONNECTION_LOST queue=%s err=%s; reconnect in %ss",
                    self.settings.rabbitmq_experiment_queue,
                    exc,
                    reconnect_backoff_seconds,
                )
                time.sleep(reconnect_backoff_seconds)
            finally:
                if connection is not None and connection.is_open:
                    connection.close()

    def receive_once(self, handler: MessageHandler, timeout_seconds: int = 10) -> bool:
        params = self._build_connection_params()
        connection = pika.BlockingConnection(params)
        channel = self._declare_channel(connection)

        deadline = time.time() + timeout_seconds
        try:
            while time.time() < deadline:
                method, properties, body = channel.basic_get(queue=self.settings.rabbitmq_experiment_queue, auto_ack=False)
                if method is None:
                    time.sleep(0.2)
                    continue
                try:
                    del properties
                    handler(body)
                    if not self._safe_ack(channel, method.delivery_tag):
                        raise StreamLostError("ack failed due to closed or unhealthy channel")
                    return True
                except Exception:
                    if not self._safe_nack(channel, method.delivery_tag, requeue=False):
                        raise
                    raise
            return False
        finally:
            if connection.is_open:
                connection.close()
