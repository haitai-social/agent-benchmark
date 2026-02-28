import errno
import gzip
import pytest

from infrastructure import otel_collector
from infrastructure.otel_collector import OTelCollectorServer, OTelSpanStore, OTelTraceRepository


def test_otel_span_store_ingest_and_query() -> None:
    store = OTelSpanStore()
    payload = {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": [
                        {"key": "benchmark.run_case_id", "value": {"stringValue": "7"}},
                    ]
                },
                "scopeSpans": [
                    {
                        "spans": [
                            {
                                "traceId": "t1",
                                "spanId": "s1",
                                "name": "step1",
                                "startTimeUnixNano": "1700000000000000000",
                                "endTimeUnixNano": "1700000001000000000",
                            }
                        ]
                    }
                ],
            }
        ]
    }
    inserted = store.ingest_payload(payload)
    assert inserted == 1
    spans = store.fetch_spans_by_run_case(run_case_id=7, start_ms=1699999999000, end_ms=1700000002000)
    assert len(spans) == 1
    assert spans[0]["name"] == "step1"


def test_otel_collector_port_in_use_returns_false(monkeypatch) -> None:
    def _raise_addr_in_use(*args, **kwargs):
        raise OSError(errno.EADDRINUSE, "Address already in use")

    monkeypatch.setattr(otel_collector, "ThreadingHTTPServer", _raise_addr_in_use)
    collector = OTelCollectorServer(host="127.0.0.1", port=14318, path="/v1/traces", store=OTelSpanStore())

    started = collector.start()

    assert started is False


def test_otel_trace_repository_fallback_when_store_empty() -> None:
    class _FallbackRepo:
        def __init__(self) -> None:
            self.called = False

        def fetch_spans_by_run_case(self, **kwargs):
            self.called = True
            return [{"name": "fallback-span", "kwargs": kwargs}]

    fallback = _FallbackRepo()
    repo = OTelTraceRepository(store=OTelSpanStore(), fallback_repository=fallback)

    spans = repo.fetch_spans_by_run_case(run_case_id=42, start_ms=1, end_ms=2)

    assert fallback.called is True
    assert spans
    assert spans[0]["name"] == "fallback-span"


def test_decode_otlp_protobuf_payload() -> None:
    if otel_collector.ExportTraceServiceRequest is None:
        pytest.skip("protobuf dependencies are unavailable")
    req = otel_collector.ExportTraceServiceRequest()
    rs = req.resource_spans.add()
    attr = rs.resource.attributes.add()
    attr.key = "benchmark.run_case_id"
    attr.value.string_value = "88"
    ss = rs.scope_spans.add()
    sp = ss.spans.add()
    sp.trace_id = b"\x01" * 16
    sp.span_id = b"\x02" * 8
    sp.name = "protobuf-span"
    sp.start_time_unix_nano = 1700000000000000000
    sp.end_time_unix_nano = 1700000001000000000

    payload = otel_collector._decode_otlp_protobuf_payload(req.SerializeToString())

    assert "resourceSpans" in payload
    store = OTelSpanStore()
    inserted = store.ingest_payload(payload)
    assert inserted == 1
    spans = store.fetch_spans_by_run_case(run_case_id=88, start_ms=1699999999000, end_ms=1700000002000)
    assert len(spans) == 1
    assert spans[0]["name"] == "protobuf-span"


def test_otel_collector_accepts_gzip_protobuf() -> None:
    if otel_collector.ExportTraceServiceRequest is None:
        pytest.skip("protobuf dependencies are unavailable")

    req = otel_collector.ExportTraceServiceRequest()
    rs = req.resource_spans.add()
    attr = rs.resource.attributes.add()
    attr.key = "benchmark.run_case_id"
    attr.value.string_value = "99"
    ss = rs.scope_spans.add()
    sp = ss.spans.add()
    sp.trace_id = b"\x03" * 16
    sp.span_id = b"\x04" * 8
    sp.name = "gzip-protobuf-span"
    sp.start_time_unix_nano = 1700000000000000000
    sp.end_time_unix_nano = 1700000001000000000

    payload = gzip.compress(req.SerializeToString())
    decoded = otel_collector._decode_otlp_protobuf_payload(gzip.decompress(payload))
    store = OTelSpanStore()
    inserted = store.ingest_payload(decoded)
    assert inserted == 1
    spans = store.fetch_spans_by_run_case(run_case_id=99, start_ms=1699999999000, end_ms=1700000002000)
    assert len(spans) == 1
    assert spans[0]["name"] == "gzip-protobuf-span"


def test_normalize_otel_logs_payload_to_span_like_records() -> None:
    payload = {
        "resourceLogs": [
            {
                "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "openclaw-gateway"}}]},
                "scopeLogs": [
                    {
                        "logRecords": [
                            {
                                "timeUnixNano": "1700000000000000000",
                                "severityText": "INFO",
                                "body": {"stringValue": "embedded run tool start"},
                                "attributes": [
                                    {"key": "openclaw.logger", "value": {"stringValue": "agent/embedded"}}
                                ],
                            }
                        ]
                    }
                ],
            }
        ]
    }
    spans = otel_collector._normalize_otel_logs_payload(payload)
    assert len(spans) == 1
    assert spans[0]["name"] == "agent/embedded"
    assert spans[0]["raw"]["events"][0]["name"] == "log"
