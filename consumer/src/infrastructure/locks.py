from __future__ import annotations

import hashlib
import logging

import redis

from .config import Settings

logger = logging.getLogger(__name__)


class RedisMessageLock:
    def __init__(
        self,
        host: str,
        port: int,
        username: str | None,
        password: str | None,
        db: int,
        processing_ttl_seconds: int,
        processed_ttl_seconds: int,
    ) -> None:
        self._redis = redis.Redis(
            host=host,
            port=port,
            username=username,
            password=password,
            db=db,
            decode_responses=True,
            socket_timeout=5,
            socket_connect_timeout=5,
        )
        self.processing_ttl_seconds = processing_ttl_seconds
        self.processed_ttl_seconds = processed_ttl_seconds

    @classmethod
    def from_settings(cls, settings: Settings) -> "RedisMessageLock":
        return cls(
            host=settings.redis_host,
            port=settings.redis_port,
            username=settings.redis_username,
            password=settings.redis_password,
            db=settings.redis_db,
            processing_ttl_seconds=settings.redis_processing_lock_ttl_seconds,
            processed_ttl_seconds=settings.redis_processed_ttl_seconds,
        )

    def build_suffix(self, message_id: str, payload_bytes: bytes) -> str:
        if message_id:
            return message_id
        return hashlib.sha256(payload_bytes).hexdigest()

    def processing_key(self, suffix: str) -> str:
        return f"benchmark:consumer:processing:{suffix}"

    def processed_key(self, suffix: str) -> str:
        return f"benchmark:consumer:processed:{suffix}"

    def already_processed(self, suffix: str) -> bool:
        exists = bool(self._redis.exists(self.processed_key(suffix)))
        if exists:
            logger.info("code=E_DUPLICATE_MESSAGE_PROCESSED key=%s", self.processed_key(suffix))
        return exists

    def acquire_processing(self, suffix: str) -> bool:
        key = self.processing_key(suffix)
        locked = bool(self._redis.set(key, "1", ex=self.processing_ttl_seconds, nx=True))
        if not locked:
            logger.info("code=E_DUPLICATE_MESSAGE_PROCESSING key=%s", key)
        return locked

    def mark_processed(self, suffix: str) -> None:
        self._redis.set(self.processed_key(suffix), "1", ex=self.processed_ttl_seconds)

    def release_processing(self, suffix: str) -> None:
        self._redis.delete(self.processing_key(suffix))
