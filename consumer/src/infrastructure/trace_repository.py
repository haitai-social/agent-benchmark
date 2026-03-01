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

    def fetch_logs_by_run_case(
        self,
        *,
        run_case_id: int,
        start_ms: int,
        end_ms: int,
        limit: int = 2000,
    ) -> list[dict[str, Any]]:
        if self.settings.database_engine == "postgres":
            return self._fetch_logs_postgres(run_case_id=run_case_id, start_ms=start_ms, end_ms=end_ms, limit=limit)
        return self._fetch_logs_mysql(run_case_id=run_case_id, start_ms=start_ms, end_ms=end_ms, limit=limit)

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
                      resource_attributes,
                      scope_attributes,
                      scope_name,
                      scope_version,
                      start_time,
                      end_time,
                      status,
                      run_case_id,
                      experiment_id,
                      raw,
                      created_at
                    FROM otel_traces
                    WHERE is_deleted = FALSE
                      AND run_case_id = %s
                      AND (
                            (start_time IS NOT NULL AND start_time >= (to_timestamp(%s / 1000.0) - interval '60 seconds') AND start_time <= (to_timestamp(%s / 1000.0) + interval '60 seconds'))
                         OR (created_at IS NOT NULL AND created_at >= (to_timestamp(%s / 1000.0) - interval '60 seconds') AND created_at <= (to_timestamp(%s / 1000.0) + interval '60 seconds'))
                      )
                    ORDER BY COALESCE(start_time, created_at) ASC, id ASC
                    LIMIT %s
                    """,
                    (int(run_case_id), start_ms, end_ms, start_ms, end_ms, max(1, int(limit))),
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
                        SELECT id, trace_id, span_id, parent_span_id, name, service_name, attributes, resource_attributes, scope_attributes, scope_name, scope_version, start_time, end_time, status, run_case_id, experiment_id, raw, created_at
                        FROM otel_traces
                        WHERE is_deleted = FALSE
                          AND COALESCE(service_name, attributes ->> 'service.name', '') = %s
                          AND (
                                (start_time IS NOT NULL AND start_time >= (to_timestamp(%s / 1000.0) - interval '60 seconds') AND start_time <= (to_timestamp(%s / 1000.0) + interval '60 seconds'))
                             OR (created_at IS NOT NULL AND created_at >= (to_timestamp(%s / 1000.0) - interval '60 seconds') AND created_at <= (to_timestamp(%s / 1000.0) + interval '60 seconds'))
                          )
                        ORDER BY COALESCE(start_time, created_at) ASC, id ASC
                        LIMIT %s
                        """,
                        (service_name, start_ms, end_ms, start_ms, end_ms, max(1, int(limit))),
                    )
                else:
                    cur.execute(
                        """
                        SELECT id, trace_id, span_id, parent_span_id, name, service_name, attributes, resource_attributes, scope_attributes, scope_name, scope_version, start_time, end_time, status, run_case_id, experiment_id, raw, created_at
                        FROM otel_traces
                        WHERE is_deleted = FALSE
                          AND (
                                (start_time IS NOT NULL AND start_time >= (to_timestamp(%s / 1000.0) - interval '60 seconds') AND start_time <= (to_timestamp(%s / 1000.0) + interval '60 seconds'))
                             OR (created_at IS NOT NULL AND created_at >= (to_timestamp(%s / 1000.0) - interval '60 seconds') AND created_at <= (to_timestamp(%s / 1000.0) + interval '60 seconds'))
                          )
                        ORDER BY COALESCE(start_time, created_at) ASC, id ASC
                        LIMIT %s
                        """,
                        (start_ms, end_ms, start_ms, end_ms, max(1, int(limit))),
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
                      resource_attributes,
                      scope_attributes,
                      scope_name,
                      scope_version,
                      start_time,
                      end_time,
                      status,
                      run_case_id,
                      experiment_id,
                      raw,
                      created_at
                    FROM otel_traces
                    WHERE is_deleted = 0
                      AND run_case_id = %s
                      AND (
                            (start_time IS NOT NULL AND start_time >= (FROM_UNIXTIME(%s / 1000) - INTERVAL 60 SECOND) AND start_time <= (FROM_UNIXTIME(%s / 1000) + INTERVAL 60 SECOND))
                         OR (created_at IS NOT NULL AND created_at >= (FROM_UNIXTIME(%s / 1000) - INTERVAL 60 SECOND) AND created_at <= (FROM_UNIXTIME(%s / 1000) + INTERVAL 60 SECOND))
                      )
                    ORDER BY COALESCE(start_time, created_at) ASC, id ASC
                    LIMIT %s
                    """,
                    (int(run_case_id), start_ms, end_ms, start_ms, end_ms, max(1, int(limit))),
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
                        SELECT id, trace_id, span_id, parent_span_id, name, service_name, attributes, resource_attributes, scope_attributes, scope_name, scope_version, start_time, end_time, status, run_case_id, experiment_id, raw, created_at
                        FROM otel_traces
                        WHERE is_deleted = 0
                          AND COALESCE(service_name, JSON_UNQUOTE(JSON_EXTRACT(attributes, '$."service.name"')), '') = %s
                          AND (
                                (start_time IS NOT NULL AND start_time >= (FROM_UNIXTIME(%s / 1000) - INTERVAL 60 SECOND) AND start_time <= (FROM_UNIXTIME(%s / 1000) + INTERVAL 60 SECOND))
                             OR (created_at IS NOT NULL AND created_at >= (FROM_UNIXTIME(%s / 1000) - INTERVAL 60 SECOND) AND created_at <= (FROM_UNIXTIME(%s / 1000) + INTERVAL 60 SECOND))
                          )
                        ORDER BY COALESCE(start_time, created_at) ASC, id ASC
                        LIMIT %s
                        """,
                        (service_name, start_ms, end_ms, start_ms, end_ms, max(1, int(limit))),
                    )
                else:
                    cur.execute(
                        """
                        SELECT id, trace_id, span_id, parent_span_id, name, service_name, attributes, resource_attributes, scope_attributes, scope_name, scope_version, start_time, end_time, status, run_case_id, experiment_id, raw, created_at
                        FROM otel_traces
                        WHERE is_deleted = 0
                          AND (
                                (start_time IS NOT NULL AND start_time >= (FROM_UNIXTIME(%s / 1000) - INTERVAL 60 SECOND) AND start_time <= (FROM_UNIXTIME(%s / 1000) + INTERVAL 60 SECOND))
                             OR (created_at IS NOT NULL AND created_at >= (FROM_UNIXTIME(%s / 1000) - INTERVAL 60 SECOND) AND created_at <= (FROM_UNIXTIME(%s / 1000) + INTERVAL 60 SECOND))
                          )
                        ORDER BY COALESCE(start_time, created_at) ASC, id ASC
                        LIMIT %s
                        """,
                        (start_ms, end_ms, start_ms, end_ms, max(1, int(limit))),
                    )
                rows = cur.fetchall() or []
        finally:
            conn.close()
        return [self._row_to_span_dict(row) for row in rows]

    def _fetch_logs_postgres(self, *, run_case_id: int, start_ms: int, end_ms: int, limit: int) -> list[dict[str, Any]]:
        try:
            import psycopg  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("E_DB_DRIVER_MISSING: install psycopg[binary] for postgres logs query") from exc

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
                    SELECT id, trace_id, span_id, service_name, severity_text, severity_number,
                           body_text, body_json, attributes, resource_attributes, scope_attributes,
                           scope_name, scope_version, flags, dropped_attributes_count,
                           event_time, observed_time, run_case_id, experiment_id, raw, created_at
                    FROM otel_logs
                    WHERE is_deleted = FALSE
                      AND run_case_id = %s
                      AND (
                            (event_time IS NOT NULL AND event_time >= (to_timestamp(%s / 1000.0) - interval '60 seconds') AND event_time <= (to_timestamp(%s / 1000.0) + interval '60 seconds'))
                         OR (created_at IS NOT NULL AND created_at >= (to_timestamp(%s / 1000.0) - interval '60 seconds') AND created_at <= (to_timestamp(%s / 1000.0) + interval '60 seconds'))
                      )
                    ORDER BY COALESCE(event_time, created_at) ASC, id ASC
                    LIMIT %s
                    """,
                    (int(run_case_id), start_ms, end_ms, start_ms, end_ms, max(1, int(limit))),
                )
                rows = cur.fetchall() or []
        return [self._row_to_log_dict(row) for row in rows]

    def _fetch_logs_mysql(self, *, run_case_id: int, start_ms: int, end_ms: int, limit: int) -> list[dict[str, Any]]:
        try:
            import pymysql  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("E_DB_DRIVER_MISSING: install pymysql for mysql logs query") from exc

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
                    SELECT id, trace_id, span_id, service_name, severity_text, severity_number,
                           body_text, body_json, attributes, resource_attributes, scope_attributes,
                           scope_name, scope_version, flags, dropped_attributes_count,
                           event_time, observed_time, run_case_id, experiment_id, raw, created_at
                    FROM otel_logs
                    WHERE is_deleted = 0
                      AND run_case_id = %s
                      AND (
                            (event_time IS NOT NULL AND event_time >= (FROM_UNIXTIME(%s / 1000) - INTERVAL 60 SECOND) AND event_time <= (FROM_UNIXTIME(%s / 1000) + INTERVAL 60 SECOND))
                         OR (created_at IS NOT NULL AND created_at >= (FROM_UNIXTIME(%s / 1000) - INTERVAL 60 SECOND) AND created_at <= (FROM_UNIXTIME(%s / 1000) + INTERVAL 60 SECOND))
                      )
                    ORDER BY COALESCE(event_time, created_at) ASC, id ASC
                    LIMIT %s
                    """,
                    (int(run_case_id), start_ms, end_ms, start_ms, end_ms, max(1, int(limit))),
                )
                rows = cur.fetchall() or []
        finally:
            conn.close()
        return [self._row_to_log_dict(row) for row in rows]

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
                "resource_attributes": row[7],
                "scope_attributes": row[8],
                "scope_name": row[9],
                "scope_version": row[10],
                "start_time": row[11],
                "end_time": row[12],
                "status": row[13],
                "run_case_id": row[14],
                "experiment_id": row[15],
                "raw": row[16],
                "created_at": row[17],
            }
        return {
            "id": rec.get("id"),
            "trace_id": rec.get("trace_id"),
            "span_id": rec.get("span_id"),
            "parent_span_id": rec.get("parent_span_id"),
            "name": rec.get("name"),
            "service_name": rec.get("service_name"),
            "attributes": self._coerce_json(rec.get("attributes"), default={}),
            "resource_attributes": self._coerce_json(rec.get("resource_attributes"), default={}),
            "scope_attributes": self._coerce_json(rec.get("scope_attributes"), default={}),
            "scope_name": rec.get("scope_name"),
            "scope_version": rec.get("scope_version"),
            "start_time": rec.get("start_time"),
            "end_time": rec.get("end_time"),
            "status": rec.get("status"),
            "run_case_id": rec.get("run_case_id"),
            "experiment_id": rec.get("experiment_id"),
            "raw": self._coerce_json(rec.get("raw"), default={}),
            "created_at": rec.get("created_at"),
        }

    def _row_to_log_dict(self, row: Any) -> dict[str, Any]:
        if isinstance(row, dict):
            rec = row
        else:
            rec = {
                "id": row[0],
                "trace_id": row[1],
                "span_id": row[2],
                "service_name": row[3],
                "severity_text": row[4],
                "severity_number": row[5],
                "body_text": row[6],
                "body_json": row[7],
                "attributes": row[8],
                "resource_attributes": row[9],
                "scope_attributes": row[10],
                "scope_name": row[11],
                "scope_version": row[12],
                "flags": row[13],
                "dropped_attributes_count": row[14],
                "event_time": row[15],
                "observed_time": row[16],
                "run_case_id": row[17],
                "experiment_id": row[18],
                "raw": row[19],
                "created_at": row[20],
            }
        return {
            "id": rec.get("id"),
            "trace_id": rec.get("trace_id"),
            "span_id": rec.get("span_id"),
            "service_name": rec.get("service_name"),
            "severity_text": rec.get("severity_text"),
            "severity_number": rec.get("severity_number"),
            "body_text": rec.get("body_text"),
            "body_json": self._coerce_json(rec.get("body_json"), default=None),
            "attributes": self._coerce_json(rec.get("attributes"), default={}),
            "resource_attributes": self._coerce_json(rec.get("resource_attributes"), default={}),
            "scope_attributes": self._coerce_json(rec.get("scope_attributes"), default={}),
            "scope_name": rec.get("scope_name"),
            "scope_version": rec.get("scope_version"),
            "flags": rec.get("flags"),
            "dropped_attributes_count": rec.get("dropped_attributes_count"),
            "event_time": rec.get("event_time"),
            "observed_time": rec.get("observed_time"),
            "run_case_id": rec.get("run_case_id"),
            "experiment_id": rec.get("experiment_id"),
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

    def persist_logs(self, logs: list[dict[str, Any]]) -> int:
        if not logs:
            return 0
        if self.settings.database_engine == "postgres":
            return self._persist_logs_postgres(logs)
        return self._persist_logs_mysql(logs)

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
                    INSERT INTO otel_traces (
                      trace_id, span_id, parent_span_id, name, service_name,
                      status, attributes, resource_attributes, scope_attributes,
                      scope_name, scope_version, start_time, end_time,
                      run_case_id, experiment_id, raw
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s, %s, %s, %s, %s, %s::jsonb)
                    """,
                    [
                        (
                            row["trace_id"],
                            row["span_id"],
                            row["parent_span_id"],
                            row["name"],
                            row["service_name"],
                            row["status"],
                            row["attributes_json"],
                            row["resource_attributes_json"],
                            row["scope_attributes_json"],
                            row["scope_name"],
                            row["scope_version"],
                            row["start_time"],
                            row["end_time"],
                            row["run_case_id"],
                            row["experiment_id"],
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
                    INSERT INTO otel_traces (
                      trace_id, span_id, parent_span_id, name, service_name,
                      status, attributes, resource_attributes, scope_attributes,
                      scope_name, scope_version, start_time, end_time,
                      run_case_id, experiment_id, raw
                    ) VALUES (%s, %s, %s, %s, %s, %s,
                              CAST(%s AS JSON), CAST(%s AS JSON), CAST(%s AS JSON),
                              %s, %s, %s, %s, %s, %s, CAST(%s AS JSON))
                    """,
                    [
                        (
                            row["trace_id"],
                            row["span_id"],
                            row["parent_span_id"],
                            row["name"],
                            row["service_name"],
                            row["status"],
                            row["attributes_json"],
                            row["resource_attributes_json"],
                            row["scope_attributes_json"],
                            row["scope_name"],
                            row["scope_version"],
                            row["start_time"],
                            row["end_time"],
                            row["run_case_id"],
                            row["experiment_id"],
                            row["raw_json"],
                        )
                        for row in rows
                    ],
                )
        finally:
            conn.close()
        return len(rows)

    def _persist_logs_postgres(self, logs: list[dict[str, Any]]) -> int:
        try:
            import psycopg  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("E_DB_DRIVER_MISSING: install psycopg[binary] for postgres logs insert") from exc

        if not (self.settings.postgres_server and self.settings.postgres_user and self.settings.postgres_db):
            raise RuntimeError("E_DB_CONFIG_MISSING: postgres env vars are not configured")

        dsn = (
            f"host={self.settings.postgres_server} "
            f"port={self.settings.postgres_port} "
            f"user={self.settings.postgres_user} "
            f"password={self.settings.postgres_password or ''} "
            f"dbname={self.settings.postgres_db}"
        )
        rows = [self._log_to_row(item) for item in logs]
        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cur:
                cur.executemany(
                    """
                    INSERT INTO otel_logs (
                      trace_id, span_id, service_name, severity_text, severity_number,
                      body_text, body_json, attributes, resource_attributes, scope_attributes,
                      scope_name, scope_version, flags, dropped_attributes_count,
                      event_time, observed_time, run_case_id, experiment_id, raw
                    ) VALUES (%s, %s, %s, %s, %s,
                              %s, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb,
                              %s, %s, %s, %s,
                              %s, %s, %s, %s, %s::jsonb)
                    """,
                    [
                        (
                            row["trace_id"],
                            row["span_id"],
                            row["service_name"],
                            row["severity_text"],
                            row["severity_number"],
                            row["body_text"],
                            row["body_json"],
                            row["attributes_json"],
                            row["resource_attributes_json"],
                            row["scope_attributes_json"],
                            row["scope_name"],
                            row["scope_version"],
                            row["flags"],
                            row["dropped_attributes_count"],
                            row["event_time"],
                            row["observed_time"],
                            row["run_case_id"],
                            row["experiment_id"],
                            row["raw_json"],
                        )
                        for row in rows
                    ],
                )
            conn.commit()
        return len(rows)

    def _persist_logs_mysql(self, logs: list[dict[str, Any]]) -> int:
        try:
            import pymysql  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("E_DB_DRIVER_MISSING: install pymysql for mysql logs insert") from exc

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
        rows = [self._log_to_row(item) for item in logs]
        try:
            with conn.cursor() as cur:
                cur.executemany(
                    """
                    INSERT INTO otel_logs (
                      trace_id, span_id, service_name, severity_text, severity_number,
                      body_text, body_json, attributes, resource_attributes, scope_attributes,
                      scope_name, scope_version, flags, dropped_attributes_count,
                      event_time, observed_time, run_case_id, experiment_id, raw
                    ) VALUES (%s, %s, %s, %s, %s,
                              %s, CAST(%s AS JSON), CAST(%s AS JSON), CAST(%s AS JSON), CAST(%s AS JSON),
                              %s, %s, %s, %s,
                              %s, %s, %s, %s, CAST(%s AS JSON))
                    """,
                    [
                        (
                            row["trace_id"],
                            row["span_id"],
                            row["service_name"],
                            row["severity_text"],
                            row["severity_number"],
                            row["body_text"],
                            row["body_json"],
                            row["attributes_json"],
                            row["resource_attributes_json"],
                            row["scope_attributes_json"],
                            row["scope_name"],
                            row["scope_version"],
                            row["flags"],
                            row["dropped_attributes_count"],
                            row["event_time"],
                            row["observed_time"],
                            row["run_case_id"],
                            row["experiment_id"],
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
        resource_attributes = span.get("resource_attributes")
        resource_attributes_obj = resource_attributes if isinstance(resource_attributes, dict) else {}
        scope_attributes = span.get("scope_attributes")
        scope_attributes_obj = scope_attributes if isinstance(scope_attributes, dict) else {}
        raw = span.get("raw")
        raw_obj = raw if isinstance(raw, dict) else {}

        service_name = (
            str(attributes_obj.get("service.name") or "").strip()
            or str(resource_attributes_obj.get("service.name") or "").strip()
            or str(span.get("service_name") or "").strip()
            or "benchmark-agent"
        )
        attributes_obj.setdefault("service.name", service_name)

        run_case_id = _int_or_none(
            span.get("run_case_id")
            or attributes_obj.get("benchmark.run_case_id")
            or resource_attributes_obj.get("benchmark.run_case_id")
        )
        experiment_id = _int_or_none(
            span.get("experiment_id")
            or attributes_obj.get("benchmark.experiment_id")
            or resource_attributes_obj.get("benchmark.experiment_id")
        )

        return {
            "trace_id": _str_or_none(span.get("trace_id")),
            "span_id": _str_or_none(span.get("span_id")),
            "parent_span_id": _str_or_none(span.get("parent_span_id")),
            "name": str(span.get("name") or "unnamed-span"),
            "service_name": service_name,
            "status": _str_or_none(span.get("status")),
            "attributes_json": json.dumps(attributes_obj, ensure_ascii=False),
            "resource_attributes_json": json.dumps(resource_attributes_obj, ensure_ascii=False),
            "scope_attributes_json": json.dumps(scope_attributes_obj, ensure_ascii=False),
            "scope_name": _str_or_none(span.get("scope_name")),
            "scope_version": _str_or_none(span.get("scope_version")),
            "start_time": _db_datetime(span.get("start_time")),
            "end_time": _db_datetime(span.get("end_time")),
            "run_case_id": run_case_id,
            "experiment_id": experiment_id,
            "raw_json": json.dumps(raw_obj, ensure_ascii=False),
        }

    def _log_to_row(self, log: dict[str, Any]) -> dict[str, Any]:
        attributes = log.get("attributes")
        attributes_obj = attributes if isinstance(attributes, dict) else {}
        resource_attributes = log.get("resource_attributes")
        resource_attributes_obj = resource_attributes if isinstance(resource_attributes, dict) else {}
        scope_attributes = log.get("scope_attributes")
        scope_attributes_obj = scope_attributes if isinstance(scope_attributes, dict) else {}

        service_name = (
            str(log.get("service_name") or "").strip()
            or str(attributes_obj.get("service.name") or "").strip()
            or str(resource_attributes_obj.get("service.name") or "").strip()
            or "benchmark-agent"
        )

        run_case_id = _int_or_none(
            log.get("run_case_id")
            or attributes_obj.get("benchmark.run_case_id")
            or resource_attributes_obj.get("benchmark.run_case_id")
        )
        experiment_id = _int_or_none(
            log.get("experiment_id")
            or attributes_obj.get("benchmark.experiment_id")
            or resource_attributes_obj.get("benchmark.experiment_id")
        )

        body_json = log.get("body_json")
        body_json_obj = body_json if isinstance(body_json, (dict, list)) else None
        raw = log.get("raw")
        raw_obj = raw if isinstance(raw, dict) else {}

        return {
            "trace_id": _str_or_none(log.get("trace_id")),
            "span_id": _str_or_none(log.get("span_id")),
            "service_name": service_name,
            "severity_text": _str_or_none(log.get("severity_text")),
            "severity_number": _int_or_none(log.get("severity_number")),
            "body_text": _str_or_none(log.get("body_text")),
            "body_json": json.dumps(body_json_obj, ensure_ascii=False) if body_json_obj is not None else json.dumps(None),
            "attributes_json": json.dumps(attributes_obj, ensure_ascii=False),
            "resource_attributes_json": json.dumps(resource_attributes_obj, ensure_ascii=False),
            "scope_attributes_json": json.dumps(scope_attributes_obj, ensure_ascii=False),
            "scope_name": _str_or_none(log.get("scope_name")),
            "scope_version": _str_or_none(log.get("scope_version")),
            "flags": _int_or_none(log.get("flags")),
            "dropped_attributes_count": _int_or_none(log.get("dropped_attributes_count")),
            "event_time": _db_datetime(log.get("event_time")),
            "observed_time": _db_datetime(log.get("observed_time")),
            "run_case_id": run_case_id,
            "experiment_id": experiment_id,
            "raw_json": json.dumps(raw_obj, ensure_ascii=False),
        }


def _str_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _int_or_none(value: Any) -> int | None:
    if value is None:
        return None
    try:
        text = str(value).strip()
        if not text:
            return None
        return int(text)
    except Exception:
        return None


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
