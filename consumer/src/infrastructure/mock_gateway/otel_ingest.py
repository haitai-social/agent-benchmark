from __future__ import annotations

from datetime import datetime, timezone
import gzip
import json
from typing import Any, Protocol

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
    ExportTraceServiceRequest = None
    ExportLogsServiceRequest = None


class OTelIngestSink(Protocol):
    def persist_spans(self, spans: list[dict[str, Any]]) -> int: ...

    def persist_logs(self, logs: list[dict[str, Any]]) -> int: ...


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
    if "arrayValue" in value:
        array_value = _as_record(value.get("arrayValue"))
        return [_attr_value_to_any(_as_record(item)) for item in _as_record_array(array_value.get("values"))]
    if "array_value" in value:
        array_value = _as_record(value.get("array_value"))
        return [_attr_value_to_any(_as_record(item)) for item in _as_record_array(array_value.get("values"))]
    if "kvlistValue" in value:
        kv = _as_record(value.get("kvlistValue"))
        out: dict[str, Any] = {}
        for item in _as_record_array(kv.get("values")):
            key = str(item.get("key") or "").strip()
            if key:
                out[key] = _attr_value_to_any(_as_record(item.get("value")))
        return out
    if "kvlist_value" in value:
        kv = _as_record(value.get("kvlist_value"))
        out = {}
        for item in _as_record_array(kv.get("values")):
            key = str(item.get("key") or "").strip()
            if key:
                out[key] = _attr_value_to_any(_as_record(item.get("value")))
        return out
    if "bytesValue" in value:
        return value["bytesValue"]
    if "bytes_value" in value:
        return value["bytes_value"]
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


def _decode_trace_protobuf_payload(body: bytes) -> dict[str, Any]:
    if ExportTraceServiceRequest is None or MessageToDict is None:
        raise RuntimeError("E_OTEL_PROTOBUF_UNAVAILABLE: install protobuf and opentelemetry-proto")
    req = ExportTraceServiceRequest()
    req.ParseFromString(body)
    payload = MessageToDict(req, preserving_proto_field_name=False)
    return _as_record(payload)


def _decode_logs_protobuf_payload(body: bytes) -> dict[str, Any]:
    if ExportLogsServiceRequest is None or MessageToDict is None:
        raise RuntimeError("E_OTEL_PROTOBUF_UNAVAILABLE: install protobuf and opentelemetry-proto")
    req = ExportLogsServiceRequest()
    req.ParseFromString(body)
    payload = MessageToDict(req, preserving_proto_field_name=False)
    return _as_record(payload)


def _collect_attributes(value: Any) -> dict[str, Any]:
    attrs: dict[str, Any] = {}
    for attr in _as_record_array(value):
        key = str(attr.get("key") or "").strip()
        if not key:
            continue
        attrs[key] = _attr_value_to_any(_as_record(attr.get("value")))
    return attrs


def _normalize_otel_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    spans: list[dict[str, Any]] = []
    resource_spans = _as_record_array(payload.get("resourceSpans") or payload.get("resource_spans"))
    for rs in resource_spans:
        resource = _as_record(rs.get("resource"))
        resource_attrs = _collect_attributes(resource.get("attributes"))
        resource_service_name = str(resource_attrs.get("service.name") or "").strip()

        scope_spans = rs.get("scopeSpans") or rs.get("scope_spans") or rs.get("instrumentationLibrarySpans")
        for ss in _as_record_array(scope_spans):
            scope = _as_record(ss.get("scope") or ss.get("instrumentationLibrary"))
            scope_attrs = _collect_attributes(scope.get("attributes"))
            for span in _as_record_array(ss.get("spans")):
                attrs = dict(resource_attrs)
                attrs.update(_collect_attributes(span.get("attributes")))
                service_name = str(attrs.get("service.name") or resource_service_name or "").strip() or "benchmark-agent"
                if not str(attrs.get("service.name") or "").strip():
                    attrs["service.name"] = service_name
                spans.append(
                    {
                        "trace_id": span.get("traceId") or span.get("trace_id"),
                        "span_id": span.get("spanId") or span.get("span_id"),
                        "parent_span_id": span.get("parentSpanId") or span.get("parent_span_id"),
                        "name": str(span.get("name") or "unnamed-span"),
                        "service_name": service_name,
                        "attributes": attrs,
                        "resource_attributes": resource_attrs,
                        "scope_attributes": scope_attrs,
                        "scope_name": scope.get("name"),
                        "scope_version": scope.get("version"),
                        "start_time": _iso_from_nano(span.get("startTimeUnixNano") or span.get("start_time_unix_nano")),
                        "end_time": _iso_from_nano(span.get("endTimeUnixNano") or span.get("end_time_unix_nano")),
                        "status": _as_record(span.get("status")).get("code") or _as_record(span.get("status")).get("message"),
                        "raw": span,
                        "created_at": datetime.now(tz=timezone.utc).isoformat(),
                    }
                )

    if spans:
        return spans

    for span in _as_record_array(payload.get("spans")):
        attrs = _as_record(span.get("attributes"))
        service_name = str(attrs.get("service.name") or span.get("service_name") or "").strip() or "benchmark-agent"
        if not str(attrs.get("service.name") or "").strip():
            attrs["service.name"] = service_name
        spans.append(
            {
                "trace_id": span.get("traceId") or span.get("trace_id"),
                "span_id": span.get("spanId") or span.get("span_id"),
                "parent_span_id": span.get("parentSpanId") or span.get("parent_span_id"),
                "name": str(span.get("name") or "unnamed-span"),
                "service_name": service_name,
                "attributes": attrs,
                "resource_attributes": {},
                "scope_attributes": {},
                "scope_name": None,
                "scope_version": None,
                "start_time": span.get("startTime") or span.get("start_time"),
                "end_time": span.get("endTime") or span.get("end_time"),
                "status": span.get("status"),
                "raw": span,
                "created_at": datetime.now(tz=timezone.utc).isoformat(),
            }
        )
    return spans


def _normalize_otel_logs_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    logs: list[dict[str, Any]] = []
    resource_logs = _as_record_array(payload.get("resourceLogs") or payload.get("resource_logs"))
    for rl in resource_logs:
        resource = _as_record(rl.get("resource"))
        resource_attrs = _collect_attributes(resource.get("attributes"))
        resource_service_name = str(resource_attrs.get("service.name") or "").strip()

        scope_logs = rl.get("scopeLogs") or rl.get("scope_logs") or rl.get("instrumentationLibraryLogs")
        for sl in _as_record_array(scope_logs):
            scope = _as_record(sl.get("scope") or sl.get("instrumentationLibrary"))
            scope_attrs = _collect_attributes(scope.get("attributes"))
            for record in _as_record_array(sl.get("logRecords") or sl.get("log_records")):
                attrs = dict(resource_attrs)
                attrs.update(_collect_attributes(record.get("attributes")))
                service_name = str(resource_service_name or attrs.get("service.name") or "").strip() or "benchmark-agent"
                if not str(attrs.get("service.name") or "").strip():
                    attrs["service.name"] = service_name

                body_value = _attr_value_to_any(_as_record(record.get("body")))
                body_text: str | None
                body_json: Any | None
                if isinstance(body_value, str):
                    body_text = body_value
                    body_json = None
                elif body_value is None:
                    body_text = None
                    body_json = None
                else:
                    body_text = json.dumps(body_value, ensure_ascii=False)
                    body_json = body_value

                logs.append(
                    {
                        "trace_id": record.get("traceId") or record.get("trace_id"),
                        "span_id": record.get("spanId") or record.get("span_id"),
                        "service_name": service_name,
                        "severity_text": record.get("severityText") or record.get("severity_text"),
                        "severity_number": record.get("severityNumber") or record.get("severity_number"),
                        "body_text": body_text,
                        "body_json": body_json,
                        "attributes": attrs,
                        "resource_attributes": resource_attrs,
                        "scope_attributes": scope_attrs,
                        "scope_name": scope.get("name"),
                        "scope_version": scope.get("version"),
                        "flags": record.get("flags"),
                        "dropped_attributes_count": record.get("droppedAttributesCount")
                        or record.get("dropped_attributes_count"),
                        "event_time": _iso_from_nano(record.get("timeUnixNano") or record.get("time_unix_nano")),
                        "observed_time": _iso_from_nano(
                            record.get("observedTimeUnixNano") or record.get("observed_time_unix_nano")
                        ),
                        "raw": record,
                        "created_at": datetime.now(tz=timezone.utc).isoformat(),
                    }
                )

    if logs:
        return logs

    for item in _as_record_array(payload.get("logs")):
        attrs = _as_record(item.get("attributes"))
        service_name = str(item.get("service_name") or attrs.get("service.name") or "").strip() or "benchmark-agent"
        if not str(attrs.get("service.name") or "").strip():
            attrs["service.name"] = service_name
        body = item.get("body")
        logs.append(
            {
                "trace_id": item.get("trace_id"),
                "span_id": item.get("span_id"),
                "service_name": service_name,
                "severity_text": item.get("severity_text"),
                "severity_number": item.get("severity_number"),
                "body_text": body if isinstance(body, str) else None,
                "body_json": body if isinstance(body, (dict, list)) else None,
                "attributes": attrs,
                "resource_attributes": _as_record(item.get("resource_attributes")),
                "scope_attributes": _as_record(item.get("scope_attributes")),
                "scope_name": item.get("scope_name"),
                "scope_version": item.get("scope_version"),
                "flags": item.get("flags"),
                "dropped_attributes_count": item.get("dropped_attributes_count"),
                "event_time": item.get("event_time"),
                "observed_time": item.get("observed_time"),
                "raw": item,
                "created_at": datetime.now(tz=timezone.utc).isoformat(),
            }
        )
    return logs


def _merge_extra_attributes(items: list[dict[str, Any]], extra_attributes: dict[str, Any] | None) -> None:
    if not items or not extra_attributes:
        return
    for item in items:
        attrs = item.get("attributes")
        if not isinstance(attrs, dict):
            attrs = {}
            item["attributes"] = attrs
        resource_attrs = item.get("resource_attributes")
        resource_attrs_obj = resource_attrs if isinstance(resource_attrs, dict) else {}
        for key, value in extra_attributes.items():
            if key and value is not None and key not in attrs and key not in resource_attrs_obj:
                attrs[key] = value


def _detect_signal(request_path: str | None, payload: dict[str, Any]) -> str:
    path = str(request_path or "").strip()
    if path == "/api/otel/v1/logs":
        return "logs"
    if path == "/api/otel/v1/traces":
        return "traces"
    if payload.get("resourceLogs") is not None or payload.get("resource_logs") is not None:
        return "logs"
    if payload.get("resourceSpans") is not None or payload.get("resource_spans") is not None:
        return "traces"
    return "unknown"


def ingest_otel_request(
    *,
    sink: OTelIngestSink,
    content_type: str,
    content_encoding: str,
    body: bytes,
    extra_attributes: dict[str, Any] | None = None,
    request_path: str | None = None,
) -> int:
    raw_body = body
    if "gzip" in (content_encoding or "").lower():
        raw_body = gzip.decompress(raw_body)

    lowered = (content_type or "").lower()
    is_protobuf = "application/x-protobuf" in lowered or "application/protobuf" in lowered
    payload: dict[str, Any]

    if is_protobuf:
        if request_path == "/api/otel/v1/logs":
            payload = _decode_logs_protobuf_payload(raw_body)
            signal = "logs"
        else:
            payload = _decode_trace_protobuf_payload(raw_body)
            signal = "traces"
    else:
        parsed = json.loads(raw_body.decode("utf-8")) if raw_body else {}
        payload = parsed if isinstance(parsed, dict) else {}
        signal = _detect_signal(request_path, payload)

    if signal == "logs":
        logs = _normalize_otel_logs_payload(payload)
        _merge_extra_attributes(logs, extra_attributes)
        if not logs:
            return 0
        return int(sink.persist_logs(logs))

    spans = _normalize_otel_payload(payload)
    _merge_extra_attributes(spans, extra_attributes)
    if not spans:
        return 0
    return int(sink.persist_spans(spans))
