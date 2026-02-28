from __future__ import annotations

import json
from datetime import datetime, timezone
from dataclasses import dataclass
from typing import Any

from .config import Settings


@dataclass
class TraceRepository:
    settings: Settings

    @classmethod
    def from_settings(cls, settings: Settings) -> "TraceRepository":
        return cls(settings=settings)

    def fetch_spans_by_run_case(
        self,
        *,
        run_case_id: int,
        start_ms: int,
        end_ms: int,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        if self.settings.database_engine == "postgres":
            return self._fetch_postgres(run_case_id=run_case_id, start_ms=start_ms, end_ms=end_ms, limit=limit)
        return self._fetch_mysql(run_case_id=run_case_id, start_ms=start_ms, end_ms=end_ms, limit=limit)

    def fetch_spans_by_time_window(
        self,
        *,
        start_ms: int,
        end_ms: int,
        service_name: str | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        if self.settings.database_engine == "postgres":
            return self._fetch_postgres_window(
                start_ms=start_ms,
                end_ms=end_ms,
                service_name=service_name,
                limit=limit,
            )
        return self._fetch_mysql_window(
            start_ms=start_ms,
            end_ms=end_ms,
            service_name=service_name,
            limit=limit,
        )

    def _fetch_postgres(self, *, run_case_id: int, start_ms: int, end_ms: int, limit: int) -> list[dict[str, Any]]:
        try:
            import psycopg  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("E_DB_DRIVER_MISSING: install psycopg[binary] for postgres traces query") from exc

        if not (self.settings.postgres_server and self.settings.postgres_user and self.settings.postgres_db):
            raise RuntimeError("E_DB_CONFIG_MISSING: postgres env vars are not configured")

        dsn = (
            f"host={self.settings.postgres_server} "
            f"port={self.settings.postgres_port} "
            f"user={self.settings.postgres_user} "
            f"password={self.settings.postgres_password or ''} "
            f"dbname={self.settings.postgres_db}"
        )
        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT
                      id,
                      trace_id,
                      span_id,
                      parent_span_id,
                      name,
                      service_name,
                      attributes,
                      start_time,
                      end_time,
                      status,
                      raw,
                      created_at
                    FROM traces
                    WHERE deleted_at IS NULL
                      AND (attributes ->> 'benchmark.run_case_id') = %s
                      AND COALESCE(start_time, created_at) >= (to_timestamp(%s / 1000.0) - interval '60 seconds')
                      AND COALESCE(start_time, created_at) <= (to_timestamp(%s / 1000.0) + interval '60 seconds')
                    ORDER BY COALESCE(start_time, created_at) ASC, id ASC
                    LIMIT %s
                    """,
                    (str(run_case_id), start_ms, end_ms, max(1, int(limit))),
                )
                rows = cur.fetchall() or []
        return [self._row_to_span_dict(row) for row in rows]

    def _fetch_postgres_window(
        self,
        *,
        start_ms: int,
        end_ms: int,
        service_name: str | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        try:
            import psycopg  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("E_DB_DRIVER_MISSING: install psycopg[binary] for postgres traces query") from exc

        if not (self.settings.postgres_server and self.settings.postgres_user and self.settings.postgres_db):
            raise RuntimeError("E_DB_CONFIG_MISSING: postgres env vars are not configured")

        dsn = (
            f"host={self.settings.postgres_server} "
            f"port={self.settings.postgres_port} "
            f"user={self.settings.postgres_user} "
            f"password={self.settings.postgres_password or ''} "
            f"dbname={self.settings.postgres_db}"
        )
        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cur:
                if service_name:
                    cur.execute(
                        """
                        SELECT id, trace_id, span_id, parent_span_id, name, service_name, attributes, start_time, end_time, status, raw, created_at
                        FROM traces
                        WHERE deleted_at IS NULL
                          AND COALESCE(service_name, attributes ->> 'service.name', '') = %s
                          AND COALESCE(start_time, created_at) >= (to_timestamp(%s / 1000.0) - interval '60 seconds')
                          AND COALESCE(start_time, created_at) <= (to_timestamp(%s / 1000.0) + interval '60 seconds')
                        ORDER BY COALESCE(start_time, created_at) ASC, id ASC
                        LIMIT %s
                        """,
                        (service_name, start_ms, end_ms, max(1, int(limit))),
                    )
                else:
                    cur.execute(
                        """
                        SELECT id, trace_id, span_id, parent_span_id, name, service_name, attributes, start_time, end_time, status, raw, created_at
                        FROM traces
                        WHERE deleted_at IS NULL
                          AND COALESCE(start_time, created_at) >= (to_timestamp(%s / 1000.0) - interval '60 seconds')
                          AND COALESCE(start_time, created_at) <= (to_timestamp(%s / 1000.0) + interval '60 seconds')
                        ORDER BY COALESCE(start_time, created_at) ASC, id ASC
                        LIMIT %s
                        """,
                        (start_ms, end_ms, max(1, int(limit))),
                    )
                rows = cur.fetchall() or []
        return [self._row_to_span_dict(row) for row in rows]

    def _fetch_mysql(self, *, run_case_id: int, start_ms: int, end_ms: int, limit: int) -> list[dict[str, Any]]:
        try:
            import pymysql  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("E_DB_DRIVER_MISSING: install pymysql for mysql traces query") from exc

        if not (self.settings.mysql_server and self.settings.mysql_user and self.settings.mysql_db):
            raise RuntimeError("E_DB_CONFIG_MISSING: mysql env vars are not configured")

        conn = pymysql.connect(
            host=self.settings.mysql_server,
            port=self.settings.mysql_port,
            user=self.settings.mysql_user,
            password=self.settings.mysql_password or "",
            database=self.settings.mysql_db,
            autocommit=True,
        )
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT
                      id,
                      trace_id,
                      span_id,
                      parent_span_id,
                      name,
                      service_name,
                      attributes,
                      start_time,
                      end_time,
                      status,
                      raw,
                      created_at
                    FROM traces
                    WHERE deleted_at IS NULL
                      AND JSON_UNQUOTE(JSON_EXTRACT(attributes, '$."benchmark.run_case_id"')) = %s
                      AND COALESCE(start_time, created_at) >= (FROM_UNIXTIME(%s / 1000) - INTERVAL 60 SECOND)
                      AND COALESCE(start_time, created_at) <= (FROM_UNIXTIME(%s / 1000) + INTERVAL 60 SECOND)
                    ORDER BY COALESCE(start_time, created_at) ASC, id ASC
                    LIMIT %s
                    """,
                    (str(run_case_id), start_ms, end_ms, max(1, int(limit))),
                )
                rows = cur.fetchall() or []
        finally:
            conn.close()
        return [self._row_to_span_dict(row) for row in rows]

    def _fetch_mysql_window(
        self,
        *,
        start_ms: int,
        end_ms: int,
        service_name: str | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        try:
            import pymysql  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("E_DB_DRIVER_MISSING: install pymysql for mysql traces query") from exc

        if not (self.settings.mysql_server and self.settings.mysql_user and self.settings.mysql_db):
            raise RuntimeError("E_DB_CONFIG_MISSING: mysql env vars are not configured")

        conn = pymysql.connect(
            host=self.settings.mysql_server,
            port=self.settings.mysql_port,
            user=self.settings.mysql_user,
            password=self.settings.mysql_password or "",
            database=self.settings.mysql_db,
            autocommit=True,
        )
        try:
            with conn.cursor() as cur:
                if service_name:
                    cur.execute(
                        """
                        SELECT id, trace_id, span_id, parent_span_id, name, service_name, attributes, start_time, end_time, status, raw, created_at
                        FROM traces
                        WHERE deleted_at IS NULL
                          AND COALESCE(service_name, JSON_UNQUOTE(JSON_EXTRACT(attributes, '$."service.name"')), '') = %s
                          AND COALESCE(start_time, created_at) >= (FROM_UNIXTIME(%s / 1000) - INTERVAL 60 SECOND)
                          AND COALESCE(start_time, created_at) <= (FROM_UNIXTIME(%s / 1000) + INTERVAL 60 SECOND)
                        ORDER BY COALESCE(start_time, created_at) ASC, id ASC
                        LIMIT %s
                        """,
                        (service_name, start_ms, end_ms, max(1, int(limit))),
                    )
                else:
                    cur.execute(
                        """
                        SELECT id, trace_id, span_id, parent_span_id, name, service_name, attributes, start_time, end_time, status, raw, created_at
                        FROM traces
                        WHERE deleted_at IS NULL
                          AND COALESCE(start_time, created_at) >= (FROM_UNIXTIME(%s / 1000) - INTERVAL 60 SECOND)
                          AND COALESCE(start_time, created_at) <= (FROM_UNIXTIME(%s / 1000) + INTERVAL 60 SECOND)
                        ORDER BY COALESCE(start_time, created_at) ASC, id ASC
                        LIMIT %s
                        """,
                        (start_ms, end_ms, max(1, int(limit))),
                    )
                rows = cur.fetchall() or []
        finally:
            conn.close()
        return [self._row_to_span_dict(row) for row in rows]

    def _row_to_span_dict(self, row: Any) -> dict[str, Any]:
        if isinstance(row, dict):
            rec = row
        else:
            rec = {
                "id": row[0],
                "trace_id": row[1],
                "span_id": row[2],
                "parent_span_id": row[3],
                "name": row[4],
                "service_name": row[5],
                "attributes": row[6],
                "start_time": row[7],
                "end_time": row[8],
                "status": row[9],
                "raw": row[10],
                "created_at": row[11],
            }
        return {
            "id": rec.get("id"),
            "trace_id": rec.get("trace_id"),
            "span_id": rec.get("span_id"),
            "parent_span_id": rec.get("parent_span_id"),
            "name": rec.get("name"),
            "service_name": rec.get("service_name"),
            "attributes": self._coerce_json(rec.get("attributes"), default={}),
            "start_time": rec.get("start_time"),
            "end_time": rec.get("end_time"),
            "status": rec.get("status"),
            "raw": self._coerce_json(rec.get("raw"), default={}),
            "created_at": rec.get("created_at"),
        }

    def _coerce_json(self, value: Any, *, default: Any) -> Any:
        if value is None:
            return default
        if isinstance(value, (dict, list)):
            return value
        if isinstance(value, str):
            try:
                return json.loads(value)
            except Exception:
                return default
        return default


@dataclass
class TraceIngestRepository:
    settings: Settings

    @classmethod
    def from_settings(cls, settings: Settings) -> "TraceIngestRepository":
        return cls(settings=settings)

    def persist_spans(self, spans: list[dict[str, Any]]) -> int:
        if not spans:
            return 0
        if self.settings.database_engine == "postgres":
            return self._persist_postgres(spans)
        return self._persist_mysql(spans)

    def _persist_postgres(self, spans: list[dict[str, Any]]) -> int:
        try:
            import psycopg  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("E_DB_DRIVER_MISSING: install psycopg[binary] for postgres traces insert") from exc

        if not (self.settings.postgres_server and self.settings.postgres_user and self.settings.postgres_db):
            raise RuntimeError("E_DB_CONFIG_MISSING: postgres env vars are not configured")

        dsn = (
            f"host={self.settings.postgres_server} "
            f"port={self.settings.postgres_port} "
            f"user={self.settings.postgres_user} "
            f"password={self.settings.postgres_password or ''} "
            f"dbname={self.settings.postgres_db}"
        )
        rows = [self._span_to_row(span) for span in spans]
        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cur:
                cur.executemany(
                    """
                    INSERT INTO traces (
                      trace_id, span_id, parent_span_id, name, service_name,
                      attributes, start_time, end_time, status, raw
                    ) VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s::jsonb)
                    """,
                    [
                        (
                            row["trace_id"],
                            row["span_id"],
                            row["parent_span_id"],
                            row["name"],
                            row["service_name"],
                            row["attributes_json"],
                            row["start_time"],
                            row["end_time"],
                            row["status"],
                            row["raw_json"],
                        )
                        for row in rows
                    ],
                )
            conn.commit()
        return len(rows)

    def _persist_mysql(self, spans: list[dict[str, Any]]) -> int:
        try:
            import pymysql  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("E_DB_DRIVER_MISSING: install pymysql for mysql traces insert") from exc

        if not (self.settings.mysql_server and self.settings.mysql_user and self.settings.mysql_db):
            raise RuntimeError("E_DB_CONFIG_MISSING: mysql env vars are not configured")

        conn = pymysql.connect(
            host=self.settings.mysql_server,
            port=self.settings.mysql_port,
            user=self.settings.mysql_user,
            password=self.settings.mysql_password or "",
            database=self.settings.mysql_db,
            autocommit=True,
        )
        rows = [self._span_to_row(span) for span in spans]
        try:
            with conn.cursor() as cur:
                cur.executemany(
                    """
                    INSERT INTO traces (
                      trace_id, span_id, parent_span_id, name, service_name,
                      attributes, start_time, end_time, status, raw
                    ) VALUES (%s, %s, %s, %s, %s, CAST(%s AS JSON), %s, %s, %s, CAST(%s AS JSON))
                    """,
                    [
                        (
                            row["trace_id"],
                            row["span_id"],
                            row["parent_span_id"],
                            row["name"],
                            row["service_name"],
                            row["attributes_json"],
                            row["start_time"],
                            row["end_time"],
                            row["status"],
                            row["raw_json"],
                        )
                        for row in rows
                    ],
                )
        finally:
            conn.close()
        return len(rows)

    def _span_to_row(self, span: dict[str, Any]) -> dict[str, Any]:
        attributes = span.get("attributes")
        attributes_obj = attributes if isinstance(attributes, dict) else {}
        raw = span.get("raw")
        raw_obj = raw if isinstance(raw, dict) else {}
        service_name = (
            str(attributes_obj.get("service.name") or "").strip()
            or str(span.get("service_name") or "").strip()
            or None
        )
        return {
            "trace_id": _str_or_none(span.get("trace_id")),
            "span_id": _str_or_none(span.get("span_id")),
            "parent_span_id": _str_or_none(span.get("parent_span_id")),
            "name": str(span.get("name") or "unnamed-span"),
            "service_name": service_name,
            "attributes_json": json.dumps(attributes_obj, ensure_ascii=False),
            "start_time": _db_datetime(span.get("start_time")),
            "end_time": _db_datetime(span.get("end_time")),
            "status": _str_or_none(span.get("status")),
            "raw_json": json.dumps(raw_obj, ensure_ascii=False),
        }


def _str_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _db_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except Exception:
            return None
    return None
