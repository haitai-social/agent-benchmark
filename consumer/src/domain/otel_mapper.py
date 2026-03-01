from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def map_spans_to_trajectory(spans: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(spans, key=_span_sort_key)
    trajectory: list[dict[str, Any]] = []
    for idx, span in enumerate(ordered, start=1):
        start_ms = _to_epoch_ms(span.get("start_time") or span.get("created_at"))
        end_ms = _to_epoch_ms(span.get("end_time")) or start_ms
        latency_ms = max(0, end_ms - start_ms)
        raw = span.get("raw")
        raw_obj = raw if isinstance(raw, dict) else {}
        events = raw_obj.get("events") if isinstance(raw_obj.get("events"), list) else []
        trajectory.append(
            {
                "step": idx,
                "span_id": span.get("span_id"),
                "parent_span_id": span.get("parent_span_id"),
                "name": str(span.get("name") or "unnamed-span"),
                "start_time_ms": start_ms,
                "end_time_ms": end_ms,
                "latency_ms": latency_ms,
                "status": span.get("status"),
                "attributes": _pick_key_attributes(span.get("attributes")),
                "events": events,
            }
        )
    return trajectory


def map_logs_to_trajectory(logs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(logs, key=_log_sort_key)
    trajectory: list[dict[str, Any]] = []
    for idx, log in enumerate(ordered, start=1):
        event_ms = _to_epoch_ms(log.get("event_time") or log.get("observed_time") or log.get("created_at"))
        body = _log_body(log)
        trajectory.append(
            {
                "step": idx,
                "source": "otel.log",
                "trace_id": log.get("trace_id"),
                "span_id": log.get("span_id"),
                "name": str(log.get("severity_text") or "log"),
                "start_time_ms": event_ms,
                "end_time_ms": event_ms,
                "latency_ms": 0,
                "status": log.get("severity_text"),
                "attributes": _pick_key_attributes(log.get("attributes")),
                "events": [
                    {
                        "name": "log",
                        "attributes": [
                            {"key": "body", "value": body},
                            {"key": "severity_text", "value": str(log.get("severity_text") or "")},
                            {"key": "service.name", "value": str(log.get("service_name") or "")},
                        ],
                    }
                ],
            }
        )
    return trajectory


def _span_sort_key(span: dict[str, Any]) -> tuple[int, int, str]:
    start_ms = _to_epoch_ms(span.get("start_time") or span.get("created_at"))
    end_ms = _to_epoch_ms(span.get("end_time"))
    span_id = str(span.get("span_id") or "")
    return (start_ms, end_ms, span_id)


def _log_sort_key(log: dict[str, Any]) -> tuple[int, str, str]:
    event_ms = _to_epoch_ms(log.get("event_time") or log.get("observed_time") or log.get("created_at"))
    trace_id = str(log.get("trace_id") or "")
    span_id = str(log.get("span_id") or "")
    return (event_ms, trace_id, span_id)


def _to_epoch_ms(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        if value > 1_000_000_000_000:
            return int(value / 1_000_000)
        if value > 1_000_000_000:
            return int(value)
        return int(value * 1000)
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


def _pick_key_attributes(attributes: Any) -> dict[str, Any]:
    if not isinstance(attributes, dict):
        return {}
    keys = (
        "tool.name",
        "tool",
        "model",
        "model.name",
        "http.method",
        "http.url",
        "http.status_code",
        "db.system",
        "db.operation",
        "benchmark.run_case_id",
        "benchmark.data_item_id",
    )
    picked: dict[str, Any] = {}
    for key in keys:
        if key in attributes:
            picked[key] = attributes[key]
    return picked


def _log_body(log: dict[str, Any]) -> Any:
    body_text = log.get("body_text")
    if isinstance(body_text, str) and body_text.strip():
        return body_text
    body_json = log.get("body_json")
    if body_json is not None:
        return body_json
    return ""
