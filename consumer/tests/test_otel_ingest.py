from __future__ import annotations

import json
from typing import Any

from infrastructure.mock_gateway.otel_ingest import ingest_otel_request


class _Sink:
    def __init__(self) -> None:
        self.spans: list[dict[str, Any]] = []
        self.logs: list[dict[str, Any]] = []

    def persist_spans(self, spans: list[dict[str, Any]]) -> int:
        self.spans.extend(spans)
        return len(spans)

    def persist_logs(self, logs: list[dict[str, Any]]) -> int:
        self.logs.extend(logs)
        return len(logs)


def test_ingest_otel_request_merges_extra_attributes() -> None:
    sink = _Sink()
    body = json.dumps(
        {
            "resourceSpans": [
                {
                    "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "openclaw.gateway"}}]},
                    "scopeSpans": [
                        {
                            "spans": [
                                {
                                    "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                    "spanId": "bbbbbbbbbbbbbbbb",
                                    "name": "tool.call",
                                    "attributes": [],
                                }
                            ]
                        }
                    ],
                }
            ]
        }
    ).encode("utf-8")
    inserted = ingest_otel_request(
        sink=sink,
        content_type="application/json",
        content_encoding="",
        body=body,
        extra_attributes={"benchmark.run_case_id": "321", "benchmark.experiment_id": "99"},
    )
    assert inserted == 1
    assert sink.spans
    attrs = sink.spans[0].get("attributes")
    assert isinstance(attrs, dict)
    assert attrs.get("benchmark.run_case_id") == "321"
    assert attrs.get("benchmark.experiment_id") == "99"


def test_ingest_otel_request_does_not_override_existing_attributes() -> None:
    sink = _Sink()
    body = json.dumps(
        {
            "resourceSpans": [
                {
                    "resource": {
                        "attributes": [
                            {"key": "service.name", "value": {"stringValue": "openclaw.gateway"}},
                            {"key": "benchmark.run_case_id", "value": {"stringValue": "111"}},
                        ]
                    },
                    "scopeSpans": [
                        {
                            "spans": [
                                {
                                    "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                    "spanId": "bbbbbbbbbbbbbbbb",
                                    "name": "tool.call",
                                    "attributes": [],
                                }
                            ]
                        }
                    ],
                }
            ]
        }
    ).encode("utf-8")
    inserted = ingest_otel_request(
        sink=sink,
        content_type="application/json",
        content_encoding="",
        body=body,
        extra_attributes={"benchmark.run_case_id": "999"},
    )
    assert inserted == 1
    assert sink.spans
    attrs = sink.spans[0].get("attributes")
    assert isinstance(attrs, dict)
    assert attrs.get("benchmark.run_case_id") == "111"


def test_ingest_otel_logs_request_merges_extra_attributes() -> None:
    sink = _Sink()
    body = json.dumps(
        {
            "resourceLogs": [
                {
                    "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "openclaw.gateway"}}]},
                    "scopeLogs": [
                        {
                            "logRecords": [
                                {
                                    "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                    "spanId": "bbbbbbbbbbbbbbbb",
                                    "severityText": "INFO",
                                    "body": {"stringValue": "hello"},
                                    "attributes": [],
                                }
                            ]
                        }
                    ],
                }
            ]
        }
    ).encode("utf-8")
    inserted = ingest_otel_request(
        sink=sink,
        content_type="application/json",
        content_encoding="",
        body=body,
        extra_attributes={"benchmark.run_case_id": "321", "benchmark.experiment_id": "99"},
        request_path="/api/otel/v1/logs",
    )
    assert inserted == 1
    assert sink.logs
    attrs = sink.logs[0].get("attributes")
    assert isinstance(attrs, dict)
    assert attrs.get("benchmark.run_case_id") == "321"
    assert attrs.get("benchmark.experiment_id") == "99"
