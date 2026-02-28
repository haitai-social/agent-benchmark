from __future__ import annotations

import json
import logging
import threading
import errno
import gzip
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

logger = logging.getLogger(__name__)

try:
    from google.protobuf.json_format import MessageToDict  # type: ignore
    from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import (  # type: ignore
        ExportLogsServiceRequest,
    )
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (  # type: ignore
        ExportTraceServiceRequest,
    )
except Exception:  # pragma: no cover - optional runtime dependency
    MessageToDict = None
    ExportLogsServiceRequest = None
    ExportTraceServiceRequest = None


def _as_record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_record_array(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _attr_value_to_any(value: dict[str, Any] | None) -> Any:
    if not value:
        return None
    if "stringValue" in value:
        return value["stringValue"]
    if "string_value" in value:
        return value["string_value"]
    if "intValue" in value:
        return int(value["intValue"])
    if "int_value" in value:
        return int(value["int_value"])
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "double_value" in value:
        return float(value["double_value"])
    if "boolValue" in value:
        return bool(value["boolValue"])
    if "bool_value" in value:
        return bool(value["bool_value"])
    return value


def _iso_from_nano(raw: Any) -> str | None:
    if raw is None:
        return None
    try:
        n = int(str(raw))
    except Exception:
        return None
    if n <= 0:
        return None
    return datetime.fromtimestamp(n / 1_000_000_000, tz=timezone.utc).isoformat()


def _epoch_ms(value: Any) -> int:
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return 0
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            return int(datetime.fromisoformat(text).timestamp() * 1000)
        except Exception:
            return 0
    return 0


def _normalize_otel_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    spans: list[dict[str, Any]] = []
    resource_spans = _as_record_array(payload.get("resourceSpans") or payload.get("resource_spans"))
    for rs in resource_spans:
        resource_attrs: dict[str, Any] = {}
        for attr in _as_record_array(_as_record(rs.get("resource")).get("attributes")):
            key = str(attr.get("key") or "")
            if not key:
                continue
            resource_attrs[key] = _attr_value_to_any(_as_record(attr.get("value")))

        for ss in _as_record_array(rs.get("scopeSpans") or rs.get("scope_spans") or rs.get("instrumentationLibrarySpans")):
            for span in _as_record_array(ss.get("spans")):
                attrs = dict(resource_attrs)
                for attr in _as_record_array(span.get("attributes")):
                    key = str(attr.get("key") or "")
                    if not key:
                        continue
                    attrs[key] = _attr_value_to_any(_as_record(attr.get("value")))
                spans.append(
                    {
                        "trace_id": span.get("traceId") or span.get("trace_id"),
                        "span_id": span.get("spanId") or span.get("span_id"),
                        "parent_span_id": span.get("parentSpanId") or span.get("parent_span_id"),
                        "name": str(span.get("name") or "unnamed-span"),
                        "attributes": attrs,
                        "start_time": _iso_from_nano(span.get("startTimeUnixNano") or span.get("start_time_unix_nano")),
                        "end_time": _iso_from_nano(span.get("endTimeUnixNano") or span.get("end_time_unix_nano")),
                        "status": _as_record(span.get("status")).get("code") or _as_record(span.get("status")).get("message"),
                        "raw": span,
                        "created_at": datetime.now(tz=timezone.utc).isoformat(),
                    }
                )
    # simplified {spans:[...]} fallback
    if not spans:
        simple_spans = _as_record_array(payload.get("spans"))
        for span in simple_spans:
            spans.append(
                {
                    "trace_id": span.get("traceId") or span.get("trace_id"),
                    "span_id": span.get("spanId") or span.get("span_id"),
                    "parent_span_id": span.get("parentSpanId") or span.get("parent_span_id"),
                    "name": str(span.get("name") or "unnamed-span"),
                    "attributes": _as_record(span.get("attributes")),
                    "start_time": span.get("startTime") or span.get("start_time"),
                    "end_time": span.get("endTime") or span.get("end_time"),
                    "status": span.get("status"),
                    "raw": span,
                    "created_at": datetime.now(tz=timezone.utc).isoformat(),
                }
            )
    return spans


def _decode_otlp_protobuf_payload(body: bytes) -> dict[str, Any]:
    if ExportTraceServiceRequest is None or MessageToDict is None:
        raise RuntimeError("E_OTEL_PROTOBUF_UNAVAILABLE: install protobuf and opentelemetry-proto")
    req = ExportTraceServiceRequest()
    req.ParseFromString(body)
    payload = MessageToDict(req, preserving_proto_field_name=False)
    return _as_record(payload)


def _decode_otlp_protobuf_logs_payload(body: bytes) -> dict[str, Any]:
    if ExportLogsServiceRequest is None or MessageToDict is None:
        raise RuntimeError("E_OTEL_PROTOBUF_UNAVAILABLE: install protobuf and opentelemetry-proto")
    req = ExportLogsServiceRequest()
    req.ParseFromString(body)
    payload = MessageToDict(req, preserving_proto_field_name=False)
    return _as_record(payload)


def _normalize_otel_logs_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    spans: list[dict[str, Any]] = []
    resource_logs = _as_record_array(payload.get("resourceLogs") or payload.get("resource_logs"))
    for rl in resource_logs:
        resource_attrs: dict[str, Any] = {}
        for attr in _as_record_array(_as_record(rl.get("resource")).get("attributes")):
            key = str(attr.get("key") or "")
            if not key:
                continue
            resource_attrs[key] = _attr_value_to_any(_as_record(attr.get("value")))
        for sl in _as_record_array(rl.get("scopeLogs") or rl.get("scope_logs")):
            for lr in _as_record_array(sl.get("logRecords") or sl.get("log_records")):
                attrs = dict(resource_attrs)
                for attr in _as_record_array(lr.get("attributes")):
                    key = str(attr.get("key") or "")
                    if not key:
                        continue
                    attrs[key] = _attr_value_to_any(_as_record(attr.get("value")))
                body = _attr_value_to_any(_as_record(lr.get("body")))
                severity = str(lr.get("severityText") or lr.get("severity_text") or "").strip()
                name = str(attrs.get("openclaw.logger") or f"otel.log.{severity or 'INFO'}")
                event = {"name": "log", "attributes": {"message": body}}
                spans.append(
                    {
                        "trace_id": lr.get("traceId") or lr.get("trace_id") or f"log-{uuid.uuid4().hex}",
                        "span_id": lr.get("spanId") or lr.get("span_id") or uuid.uuid4().hex[:16],
                        "parent_span_id": None,
                        "name": name,
                        "attributes": attrs,
                        "start_time": _iso_from_nano(lr.get("timeUnixNano") or lr.get("time_unix_nano")),
                        "end_time": _iso_from_nano(lr.get("observedTimeUnixNano") or lr.get("observed_time_unix_nano")),
                        "status": severity or None,
                        "raw": {"events": [event], "log_record": lr},
                        "created_at": datetime.now(tz=timezone.utc).isoformat(),
                    }
                )
    return spans


@dataclass
class OTelSpanStore:
    def __init__(self, sink: Any | None = None) -> None:
        self._lock = threading.Lock()
        self._spans: list[dict[str, Any]] = []
        self._sink = sink

    def ingest_payload(self, payload: dict[str, Any]) -> int:
        spans = _normalize_otel_payload(payload)
        return self.ingest_spans(spans)

    def ingest_spans(self, spans: list[dict[str, Any]]) -> int:
        if not spans:
            return 0
        with self._lock:
            self._spans.extend(spans)
        if self._sink is not None:
            try:
                self._sink.persist_spans(spans)
            except Exception as exc:
                logger.warning("code=E_OTEL_SPAN_PERSIST_FAILED err=%s", exc)
        return len(spans)

    def persist_spans(self, spans: list[dict[str, Any]]) -> int:
        return self.ingest_spans(spans)

    def fetch_spans_by_run_case(
        self,
        *,
        run_case_id: int,
        start_ms: int,
        end_ms: int,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        lower = start_ms - 60_000
        upper = end_ms + 60_000
        out: list[dict[str, Any]] = []
        with self._lock:
            for span in self._spans:
                attrs = _as_record(span.get("attributes"))
                if str(attrs.get("benchmark.run_case_id") or "") != str(run_case_id):
                    continue
                ts = _epoch_ms(span.get("start_time") or span.get("created_at"))
                if ts < lower or ts > upper:
                    continue
                out.append(span)
        out.sort(key=lambda rec: (_epoch_ms(rec.get("start_time") or rec.get("created_at")), str(rec.get("span_id") or "")))
        return out[: max(1, int(limit))]

    def fetch_spans_by_time_window(
        self,
        *,
        start_ms: int,
        end_ms: int,
        service_name: str | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        lower = start_ms - 60_000
        upper = end_ms + 60_000
        out: list[dict[str, Any]] = []
        svc = (service_name or "").strip()
        with self._lock:
            for span in self._spans:
                ts = _epoch_ms(span.get("start_time") or span.get("created_at"))
                if ts < lower or ts > upper:
                    continue
                if svc:
                    attrs = _as_record(span.get("attributes"))
                    span_svc = str(attrs.get("service.name") or span.get("service_name") or "")
                    if span_svc != svc:
                        continue
                out.append(span)
        out.sort(key=lambda rec: (_epoch_ms(rec.get("start_time") or rec.get("created_at")), str(rec.get("span_id") or "")))
        return out[: max(1, int(limit))]


class OTelCollectorServer:
    def __init__(self, host: str, port: int, path: str, store: OTelSpanStore) -> None:
        self.host = host
        self.port = port
        self.path = path
        self.store = store
        self._thread: threading.Thread | None = None
        self._httpd: ThreadingHTTPServer | None = None

    def start(self) -> bool:
        if self._thread and self._thread.is_alive():
            return True

        store = self.store
        path = self.path

        class _Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                content_type = self.headers.get("Content-Type") or ""
                content_encoding = self.headers.get("Content-Encoding") or ""
                length = int(self.headers.get("Content-Length") or "0")
                logger.info(
                    "code=OTEL_COLLECTOR_REQUEST path=%s content_type=%s content_encoding=%s content_length=%s",
                    self.path,
                    content_type,
                    content_encoding,
                    length,
                )
                traces_path = path
                logs_path = traces_path.replace("/v1/traces", "/v1/logs")
                metrics_path = traces_path.replace("/v1/traces", "/v1/metrics")
                accepted_paths = {traces_path, logs_path, metrics_path}
                if self.path not in accepted_paths:
                    logger.warning(
                        "code=E_OTEL_COLLECTOR_PATH_MISMATCH path=%s expected=%s",
                        self.path,
                        traces_path,
                    )
                    self.send_response(404)
                    self.end_headers()
                    return
                body = self.rfile.read(length)
                try:
                    lowered_encoding = content_encoding.lower()
                    if "gzip" in lowered_encoding:
                        body = gzip.decompress(body)
                    lowered = content_type.lower()
                    if self.path == metrics_path:
                        payload = {}
                        inserted = 0
                    elif "application/x-protobuf" in lowered or "application/protobuf" in lowered:
                        if self.path == logs_path:
                            payload = _decode_otlp_protobuf_logs_payload(body)
                            inserted = store.ingest_spans(_normalize_otel_logs_payload(payload))
                        else:
                            payload = _decode_otlp_protobuf_payload(body)
                            inserted = store.ingest_payload(payload)
                    else:
                        payload = json.loads(body.decode("utf-8"))
                        if self.path == logs_path:
                            inserted = store.ingest_spans(_normalize_otel_logs_payload(_as_record(payload)))
                        else:
                            inserted = store.ingest_payload(_as_record(payload))
                except Exception as exc:
                    logger.warning(
                        "code=E_OTEL_COLLECTOR_INVALID_PAYLOAD content_type=%s content_length=%s err=%s",
                        content_type,
                        length,
                        exc,
                    )
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b'{"ok":false,"error":"invalid_json"}')
                    return
                logger.info(
                    "code=OTEL_COLLECTOR_INGESTED spans=%s content_type=%s content_length=%s",
                    inserted,
                    content_type,
                    length,
                )
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True, "inserted": inserted}).encode("utf-8"))

            def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
                logger.debug("code=OTEL_COLLECTOR_HTTP " + fmt, *args)

        try:
            self._httpd = ThreadingHTTPServer((self.host, self.port), _Handler)
        except OSError as exc:
            address_in_use_errnos = {
                errno.EADDRINUSE,
                48,  # macOS
                98,  # Linux
                10048,  # Windows
            }
            if exc.errno in address_in_use_errnos:
                logger.warning(
                    "code=E_OTEL_COLLECTOR_PORT_IN_USE host=%s port=%s path=%s err=%s",
                    self.host,
                    self.port,
                    self.path,
                    exc,
                )
                self._httpd = None
                return False
            raise
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True, name="otel-collector")
        self._thread.start()
        logger.info("code=OTEL_COLLECTOR_STARTED endpoint=http://%s:%s%s", self.host, self.port, self.path)
        return True

    def stop(self) -> None:
        if self._httpd:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1)
        self._thread = None


@dataclass
class OTelTraceRepository:
    store: OTelSpanStore
    fallback_repository: Any | None = None

    def fetch_spans_by_run_case(
        self,
        *,
        run_case_id: int,
        start_ms: int,
        end_ms: int,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        spans = self.store.fetch_spans_by_run_case(
            run_case_id=run_case_id,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=limit,
        )
        if spans or self.fallback_repository is None:
            return spans
        try:
            return self.fallback_repository.fetch_spans_by_run_case(
                run_case_id=run_case_id,
                start_ms=start_ms,
                end_ms=end_ms,
                limit=limit,
            )
        except Exception as exc:
            logger.warning("code=E_OTEL_FALLBACK_QUERY_FAILED run_case_id=%s err=%s", run_case_id, exc)
            return spans

    def persist_spans(self, spans: list[dict[str, Any]]) -> int:
        return self.store.ingest_spans(spans)

    def fetch_spans_by_time_window(
        self,
        *,
        start_ms: int,
        end_ms: int,
        service_name: str | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        spans = self.store.fetch_spans_by_time_window(
            start_ms=start_ms,
            end_ms=end_ms,
            service_name=service_name,
            limit=limit,
        )
        if spans or self.fallback_repository is None:
            return spans
        fallback = getattr(self.fallback_repository, "fetch_spans_by_time_window", None)
        if not callable(fallback):
            return spans
        try:
            return fallback(start_ms=start_ms, end_ms=end_ms, service_name=service_name, limit=limit)
        except Exception as exc:
            logger.warning("code=E_OTEL_FALLBACK_QUERY_WINDOW_FAILED err=%s", exc)
            return spans
