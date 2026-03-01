#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, TypedDict


class SessionRecord(TypedDict):
    index: int
    payload: object


class EventRecord(TypedDict):
    name: str
    payload: object
    attributes: dict[str, object]


def _iso_now(offset_ms: int = 0) -> str:
    now = time.time() + (offset_ms / 1000.0)
    return datetime.fromtimestamp(now, tz=timezone.utc).isoformat()


def _otel_endpoint() -> str:
    return "http://host.docker.internal:14318/api/otel"


def _parse_session_jsonl(raw: str) -> list[SessionRecord]:
    records: list[SessionRecord] = []
    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    for idx, line in enumerate(lines, start=1):
        parsed: object
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            parsed = {"raw_text": line}
        records.append({"index": idx, "payload": parsed})
    return records


def _record_name(payload: object, default_name: str = "session.step") -> str:
    if isinstance(payload, dict):
        if isinstance(payload.get("type"), str) and payload["type"].strip():
            return payload["type"].strip()
        if isinstance(payload.get("event"), str) and payload["event"].strip():
            return payload["event"].strip()
        if isinstance(payload.get("role"), str) and payload["role"].strip():
            return f"message.{payload['role'].strip()}"
        if isinstance(payload.get("name"), str) and payload["name"].strip():
            return payload["name"].strip()
    return default_name


def _value_preview(value: object, limit: int = 800) -> str:
    if isinstance(value, str):
        return value[:limit]
    if isinstance(value, (int, float, bool)) or value is None:
        return str(value)
    try:
        return json.dumps(value, ensure_ascii=False)[:limit]
    except Exception:
        return str(value)[:limit]


def _read_session_jsonl_from_path_file() -> tuple[str, str]:
    path_file = str(os.getenv("OPENCLAW_SESSION_PATH_FILE") or "/tmp/openclaw-last-session-path.txt").strip()
    if not path_file:
        raise RuntimeError("missing OPENCLAW_SESSION_PATH_FILE")
    marker_path = Path(path_file)
    if not marker_path.exists() or not marker_path.is_file():
        raise RuntimeError(f"session path file not found: {path_file}")
    session_path = marker_path.read_text(encoding="utf-8", errors="replace").strip()
    if not session_path:
        raise RuntimeError(f"session path file is empty: {path_file}")
    file_path = Path(session_path)
    if not file_path.exists() or not file_path.is_file():
        raise RuntimeError(f"session jsonl not found: {session_path}")
    session_jsonl = file_path.read_text(encoding="utf-8", errors="replace")
    if not session_jsonl.strip():
        raise RuntimeError(f"session jsonl is empty: {session_path}")
    return session_path, session_jsonl


def _event_attributes(payload: object) -> list[dict[str, object]]:
    attrs: list[dict[str, object]] = []
    if isinstance(payload, dict):
        role = str(payload.get("role") or "").strip().lower()
        content = payload.get("content")
        if role == "user" and isinstance(content, str) and content.strip():
            attrs.append({"key": "query", "value": content.strip()})
        if role in {"assistant", "model"} and isinstance(content, str) and content.strip():
            attrs.append({"key": "final_answer", "value": content.strip()})
        if isinstance(payload.get("results"), (dict, list, str)):
            attrs.append({"key": "results", "value": payload.get("results")})
        if isinstance(payload.get("path"), str) and payload["path"].strip():
            attrs.append({"key": "path", "value": payload["path"].strip()})
        if isinstance(content, str) and content.strip() and not any(item.get("key") == "query" for item in attrs):
            attrs.append({"key": "content_preview", "value": content.strip()[:400]})
    if not attrs:
        attrs.append({"key": "content_preview", "value": str(payload)[:400]})
    return attrs


def _iter_events_from_value(value: object) -> Iterable[EventRecord]:
    if isinstance(value, list):
        for item in value:
            yield from _iter_events_from_value(item)
        return

    if not isinstance(value, dict):
        return

    name = _record_name(value)
    attrs: dict[str, object] = {}
    role = value.get("role")
    content = value.get("content")
    if isinstance(role, str) and role.strip():
        attrs["role"] = role.strip()
    if isinstance(content, str) and content.strip():
        if str(role or "").lower() == "user":
            attrs["query"] = content.strip()
        elif str(role or "").lower() in {"assistant", "model"}:
            attrs["final_answer"] = content.strip()
        else:
            attrs["content_preview"] = content.strip()[:800]

    tool_name_raw = value.get("tool_name") or value.get("tool") or value.get("name")
    tool_name = str(tool_name_raw).strip() if isinstance(tool_name_raw, str) else ""

    request_value = value.get("args") or value.get("arguments") or value.get("input")
    if isinstance(request_value, (dict, list, str)):
        if tool_name:
            attrs["tool.name"] = tool_name
            yield {
                "name": f"tool.{tool_name}.request",
                "payload": request_value,
                "attributes": {
                    **attrs,
                    "request_preview": _value_preview(request_value),
                },
            }
        else:
            attrs["request_preview"] = _value_preview(request_value)

    response_value = (
        value.get("result")
        or value.get("output")
        or value.get("response")
        or value.get("observation")
        or value.get("tool_result")
        or value.get("tool_output")
    )
    if isinstance(response_value, (dict, list, str)):
        if tool_name:
            yield {
                "name": f"tool.{tool_name}.response",
                "payload": response_value,
                "attributes": {
                    **attrs,
                    "results": _value_preview(response_value),
                },
            }
        else:
            attrs["results"] = _value_preview(response_value)

    path = value.get("path")
    if isinstance(path, str) and path.strip():
        attrs["path"] = path.strip()

    if attrs:
        yield {"name": name, "payload": value, "attributes": attrs}

    # OpenClaw v3 session message envelope:
    # {"type":"message","message":{"role":"assistant|toolResult|user", "content":[...]}}
    message_obj = value.get("message")
    if isinstance(message_obj, dict):
        message_role_raw = message_obj.get("role")
        message_role = str(message_role_raw).strip() if isinstance(message_role_raw, str) else ""
        message_content = message_obj.get("content")
        if message_role.lower() == "user":
            query_parts: list[str] = []
            if isinstance(message_content, list):
                for part in message_content:
                    if isinstance(part, dict) and str(part.get("type") or "") == "text":
                        text = part.get("text")
                        if isinstance(text, str) and text.strip():
                            query_parts.append(text.strip())
            if query_parts:
                yield {
                    "name": "message.user",
                    "payload": message_obj,
                    "attributes": {"query": "\n".join(query_parts)},
                }
        if message_role.lower() == "assistant" and isinstance(message_content, list):
            for part in message_content:
                if not isinstance(part, dict):
                    continue
                part_type = str(part.get("type") or "")
                if part_type == "toolCall":
                    call_name_raw = part.get("name")
                    call_name = str(call_name_raw).strip() if isinstance(call_name_raw, str) else ""
                    arguments = part.get("arguments")
                    attributes: dict[str, object] = {
                        "request_preview": _value_preview(arguments),
                    }
                    if call_name:
                        attributes["tool.name"] = call_name
                    if isinstance(arguments, dict):
                        for key in ("path", "query", "url", "file_path"):
                            v = arguments.get(key)
                            if isinstance(v, str) and v.strip():
                                attributes[key] = v.strip()
                    yield {
                        "name": f"tool.{call_name}.request" if call_name else "tool.request",
                        "payload": part,
                        "attributes": attributes,
                    }
                if part_type == "text":
                    text = part.get("text")
                    if isinstance(text, str) and text.strip():
                        yield {
                            "name": "message.assistant",
                            "payload": part,
                            "attributes": {"final_answer": text.strip()},
                        }
        if message_role.lower() == "toolresult":
            tool_name_value = message_obj.get("toolName")
            tool_name_text = str(tool_name_value).strip() if isinstance(tool_name_value, str) else ""
            result_texts: list[str] = []
            if isinstance(message_content, list):
                for part in message_content:
                    if isinstance(part, dict) and str(part.get("type") or "") == "text":
                        text = part.get("text")
                        if isinstance(text, str) and text.strip():
                            result_texts.append(text.strip())
            attributes = {
                "results": "\n".join(result_texts) if result_texts else _value_preview(message_obj),
            }
            if tool_name_text:
                attributes["tool.name"] = tool_name_text
            yield {
                "name": f"tool.{tool_name_text}.response" if tool_name_text else "tool.response",
                "payload": message_obj,
                "attributes": attributes,
            }

    nested_keys = (
        "events",
        "steps",
        "messages",
        "tool_calls",
        "calls",
        "actions",
        "items",
    )
    for key in nested_keys:
        nested = value.get(key)
        if isinstance(nested, (list, dict)):
            yield from _iter_events_from_value(nested)


def _build_traces(events: list[EventRecord], trace_id: str, run_case_id: str, experiment_id: str) -> dict[str, object]:
    spans: list[dict[str, object]] = []
    parent_span_id = ""
    for idx, event in enumerate(events, start=1):
        span_id = uuid.uuid4().hex[:16]
        start_time = _iso_now(idx * 5)
        end_time = _iso_now(idx * 5 + 2)
        attributes = {
            "service.name": "openclaw.gateway",
            "benchmark.run_case_id": run_case_id,
            "benchmark.experiment_id": experiment_id,
            "session.step_index": idx,
        }
        attributes.update(event["attributes"])
        spans.append(
            {
                "trace_id": trace_id,
                "span_id": span_id,
                "parent_span_id": parent_span_id or None,
                "name": event["name"],
                "service_name": "openclaw.gateway",
                "start_time": start_time,
                "end_time": end_time,
                "status": "OK",
                "attributes": attributes,
                "events": [
                    {
                        "name": "session.event",
                        "attributes": _event_attributes(event["payload"]),
                    }
                ],
            }
        )
        parent_span_id = span_id
    return {"spans": spans}


def _build_logs(events: list[EventRecord], trace_id: str, run_case_id: str, experiment_id: str) -> dict[str, object]:
    logs: list[dict[str, object]] = []
    for idx, event in enumerate(events, start=1):
        payload = event["payload"]
        span_id = uuid.uuid4().hex[:16]
        attributes = {
            "service.name": "openclaw.gateway",
            "benchmark.run_case_id": run_case_id,
            "benchmark.experiment_id": experiment_id,
            "session.step_index": idx,
        }
        attributes.update(event["attributes"])
        logs.append(
            {
                "trace_id": trace_id,
                "span_id": span_id,
                "service_name": "openclaw.gateway",
                "severity_text": "INFO",
                "body": _value_preview(payload),
                "event_time": _iso_now(idx * 5 + 1),
                "attributes": attributes,
            }
        )
    return {"logs": logs}


def _post_json(url: str, payload: dict[str, object]) -> tuple[int, str]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url=url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return int(resp.status), body
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return int(exc.code), body


def _inserted_count(response_body: str) -> int:
    try:
        parsed = json.loads(response_body)
    except json.JSONDecodeError:
        return 0
    if not isinstance(parsed, dict):
        return 0
    value = parsed.get("inserted")
    return int(value) if isinstance(value, int) else 0


def main() -> int:
    session_path, session_jsonl = _read_session_jsonl_from_path_file()

    records = _parse_session_jsonl(session_jsonl)
    if not records:
        print("no_session_records", file=sys.stderr)
        return 2

    events: list[EventRecord] = []
    for record in records:
        event_records = list(_iter_events_from_value(record["payload"]))
        if event_records:
            events.extend(event_records)
        else:
            events.append(
                {
                    "name": _record_name(record["payload"]),
                    "payload": record["payload"],
                    "attributes": {"session.step_index": record["index"]},
                }
            )

    run_case_id = str(os.getenv("BENCHMARK_RUN_CASE_ID") or "")
    experiment_id = str(os.getenv("BENCHMARK_EXPERIMENT_ID") or "")
    trace_id = uuid.uuid4().hex

    endpoint = _otel_endpoint()
    traces_url = f"{endpoint}/v1/traces"
    logs_url = f"{endpoint}/v1/logs"

    trace_status, trace_body = _post_json(
        traces_url,
        _build_traces(events=events, trace_id=trace_id, run_case_id=run_case_id, experiment_id=experiment_id),
    )
    logs_status, logs_body = _post_json(
        logs_url,
        _build_logs(events=events, trace_id=trace_id, run_case_id=run_case_id, experiment_id=experiment_id),
    )

    trace_inserted = _inserted_count(trace_body)
    logs_inserted = _inserted_count(logs_body)
    print(
        json.dumps(
            {
                "traces_url": traces_url,
                "logs_url": logs_url,
                "trace_status": trace_status,
                "logs_status": logs_status,
                "trace_inserted": trace_inserted,
                "logs_inserted": logs_inserted,
                "records": len(records),
                "events": len(events),
                "session_path": session_path,
            },
            ensure_ascii=False,
        )
    )

    if trace_status != 200 or logs_status != 200:
        return 3
    if trace_inserted <= 0 or logs_inserted <= 0:
        return 4
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
