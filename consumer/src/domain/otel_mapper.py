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


def _span_sort_key(span: dict[str, Any]) -> tuple[int, int, str]:
    start_ms = _to_epoch_ms(span.get("start_time") or span.get("created_at"))
    end_ms = _to_epoch_ms(span.get("end_time"))
    span_id = str(span.get("span_id") or "")
    return (start_ms, end_ms, span_id)


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
