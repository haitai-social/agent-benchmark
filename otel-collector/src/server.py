from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

logger = logging.getLogger("otel_collector_service")


def _as_record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_record_array(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _attr_value_to_any(value: dict[str, Any] | None) -> Any:
    if not value:
        return None
    for key in ("stringValue", "string_value", "intValue", "int_value", "doubleValue", "double_value", "boolValue", "bool_value"):
        if key in value:
            return value[key]
    return value


def _iso_from_nano(raw: Any) -> str | None:
    try:
        n = int(str(raw))
    except Exception:
        return None
    if n <= 0:
        return None
    return datetime.fromtimestamp(n / 1_000_000_000, tz=timezone.utc).isoformat()


def _epoch_ms(value: Any) -> int:
    if isinstance(value, str):
        text = value.strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            return int(datetime.fromisoformat(text).timestamp() * 1000)
        except Exception:
            return 0
    return 0


def _normalize_otel_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    spans: list[dict[str, Any]] = []
    for rs in _as_record_array(payload.get("resourceSpans") or payload.get("resource_spans")):
        resource_attrs: dict[str, Any] = {}
        for attr in _as_record_array(_as_record(rs.get("resource")).get("attributes")):
            key = str(attr.get("key") or "")
            if key:
                resource_attrs[key] = _attr_value_to_any(_as_record(attr.get("value")))

        for ss in _as_record_array(rs.get("scopeSpans") or rs.get("scope_spans") or rs.get("instrumentationLibrarySpans")):
            for span in _as_record_array(ss.get("spans")):
                attrs = dict(resource_attrs)
                for attr in _as_record_array(span.get("attributes")):
                    key = str(attr.get("key") or "")
                    if key:
                        attrs[key] = _attr_value_to_any(_as_record(attr.get("value")))
                spans.append(
                    {
                        "trace_id": span.get("traceId") or span.get("trace_id"),
                        "span_id": span.get("spanId") or span.get("span_id"),
                        "parent_span_id": span.get("parentSpanId") or span.get("parent_span_id"),
                        "name": str(span.get("name") or "unnamed-span"),
                        "service_name": attrs.get("service.name"),
                        "attributes": attrs,
                        "start_time": _iso_from_nano(span.get("startTimeUnixNano") or span.get("start_time_unix_nano")),
                        "end_time": _iso_from_nano(span.get("endTimeUnixNano") or span.get("end_time_unix_nano")),
                        "status": _as_record(span.get("status")).get("code"),
                        "raw": span,
                        "created_at": datetime.now(tz=timezone.utc).isoformat(),
                    }
                )
    if spans:
        return spans
    for span in _as_record_array(payload.get("spans")):
        spans.append({
            "trace_id": span.get("trace_id") or span.get("traceId"),
            "span_id": span.get("span_id") or span.get("spanId"),
            "parent_span_id": span.get("parent_span_id") or span.get("parentSpanId"),
            "name": str(span.get("name") or "unnamed-span"),
            "service_name": span.get("service_name") or _as_record(span.get("attributes")).get("service.name"),
            "attributes": _as_record(span.get("attributes")),
            "start_time": span.get("start_time") or span.get("startTime"),
            "end_time": span.get("end_time") or span.get("endTime"),
            "status": span.get("status"),
            "raw": _as_record(span.get("raw")) or span,
            "created_at": datetime.now(tz=timezone.utc).isoformat(),
        })
    return spans


class SpanStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._spans: list[dict[str, Any]] = []

    def ingest(self, payload: dict[str, Any]) -> int:
        spans = _normalize_otel_payload(payload)
        if not spans:
            return 0
        with self._lock:
            self._spans.extend(spans)
        return len(spans)

    def fetch_by_run_case(self, run_case_id: int, start_ms: int, end_ms: int, limit: int) -> list[dict[str, Any]]:
        lower, upper = start_ms - 60_000, end_ms + 60_000
        out: list[dict[str, Any]] = []
        with self._lock:
            for span in self._spans:
                attrs = _as_record(span.get("attributes"))
                if str(attrs.get("benchmark.run_case_id") or "") != str(run_case_id):
                    continue
                ts = _epoch_ms(span.get("start_time") or span.get("created_at"))
                if lower <= ts <= upper:
                    out.append(span)
        return out[: max(1, int(limit))]

    def fetch_by_window(self, start_ms: int, end_ms: int, service_name: str | None, limit: int) -> list[dict[str, Any]]:
        lower, upper = start_ms - 60_000, end_ms + 60_000
        svc = (service_name or "").strip()
        out: list[dict[str, Any]] = []
        with self._lock:
            for span in self._spans:
                ts = _epoch_ms(span.get("start_time") or span.get("created_at"))
                if not (lower <= ts <= upper):
                    continue
                if svc:
                    attrs = _as_record(span.get("attributes"))
                    if str(attrs.get("service.name") or span.get("service_name") or "") != svc:
                        continue
                out.append(span)
        return out[: max(1, int(limit))]


class OTelCollectorService:
    def __init__(self, host: str, port: int, traces_path: str = "/v1/traces") -> None:
        self.host = host
        self.port = port
        self.traces_path = traces_path
        self.store = SpanStore()

    def start(self) -> None:
        store = self.store
        traces_path = self.traces_path

        class Handler(BaseHTTPRequestHandler):
            def _json(self, status: int, payload: dict[str, Any]) -> None:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length") or "0")
                try:
                    payload = _as_record(json.loads(self.rfile.read(length).decode("utf-8") or "{}"))
                except Exception:
                    self._json(400, {"ok": False, "error": "invalid_json"})
                    return
                if self.path == traces_path:
                    inserted = store.ingest(payload)
                    self._json(200, {"ok": True, "inserted": inserted})
                    return
                if self.path == "/v1/traces/query":
                    self._json(200, {"ok": True, "spans": store.fetch_by_run_case(int(payload.get("run_case_id") or 0), int(payload.get("start_ms") or 0), int(payload.get("end_ms") or 0), int(payload.get("limit") or 1000))})
                    return
                if self.path == "/v1/traces/query-window":
                    self._json(200, {"ok": True, "spans": store.fetch_by_window(int(payload.get("start_ms") or 0), int(payload.get("end_ms") or 0), str(payload.get("service_name") or "").strip() or None, int(payload.get("limit") or 1000))})
                    return
                self._json(404, {"ok": False, "error": "not_found"})

            def log_message(self, fmt: str, *args: Any) -> None:
                logger.debug(fmt, *args)

        httpd = ThreadingHTTPServer((self.host, self.port), Handler)
        logger.info("OTEL collector service started: http://%s:%s%s", self.host, self.port, self.traces_path)
        httpd.serve_forever()


if __name__ == "__main__":
    import os

    logging.basicConfig(level=logging.INFO)
    OTelCollectorService(
        host=os.getenv("OTEL_COLLECTOR_HOST", "0.0.0.0"),
        port=int(os.getenv("OTEL_COLLECTOR_PORT", "14318")),
        traces_path=os.getenv("OTEL_COLLECTOR_TRACES_PATH", "/v1/traces"),
    ).start()
