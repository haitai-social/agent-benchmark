from __future__ import annotations

import json
import urllib.request

from domain.contracts import MockConfig, MockMatch, MockResponse, MockRule
from infrastructure.mock_gateway.runtime import start_mock_gateway


def _request_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=5) as resp:
        body = resp.read().decode("utf-8")
    return json.loads(body)


def test_mock_gateway_json_response() -> None:
    cfg = MockConfig(
        passthrough=False,
        rules=[
            MockRule(
                name="json-static",
                match=MockMatch(methods=["GET"], path="/v1/ping"),
                response=MockResponse(type="json", status=200, json_body={"pong": True}),
            )
        ],
    )
    handle = start_mock_gateway(cfg)
    assert handle is not None
    try:
        got = _request_json(f"{handle.local_endpoint}/v1/ping")
        assert got == {"pong": True}
    finally:
        handle.close()


def test_mock_gateway_python_response() -> None:
    cfg = MockConfig(
        passthrough=False,
        rules=[
            MockRule(
                name="python-dynamic",
                match=MockMatch(methods=["GET"], path="/v1/echo"),
                response=MockResponse(
                    type="python",
                    python_code=(
                        "def handle(request):\n"
                        "    name = request.get('query', {}).get('name', ['world'])[0]\n"
                        "    return {'status': 200, 'json': {'hello': name}}\n"
                    ),
                ),
            )
        ],
    )
    handle = start_mock_gateway(cfg)
    assert handle is not None
    try:
        got = _request_json(f"{handle.local_endpoint}/v1/echo?name=codex")
        assert got == {"hello": "codex"}
    finally:
        handle.close()


def test_mock_gateway_default_otel_mock() -> None:
    cfg = MockConfig(
        passthrough=False,
        rules=[],
    )
    handle = start_mock_gateway(cfg)
    assert handle is not None
    try:
        req = urllib.request.Request(
            f"{handle.local_endpoint}/api/otel/v1/traces",
            data=b'{"resourceSpans":[]}',
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read().decode("utf-8")
        got = json.loads(body)
        assert got.get("mock") == "otel-default"
    finally:
        handle.close()


def test_mock_gateway_default_otel_logs_mock() -> None:
    cfg = MockConfig(
        passthrough=False,
        rules=[],
    )
    handle = start_mock_gateway(cfg)
    assert handle is not None
    try:
        req = urllib.request.Request(
            f"{handle.local_endpoint}/api/otel/v1/logs",
            data=b'{"resourceLogs":[]}',
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read().decode("utf-8")
        got = json.loads(body)
        assert got.get("mock") == "otel-default"
    finally:
        handle.close()


def test_mock_gateway_default_otel_mock_with_ingest_callback() -> None:
    recorded: dict[str, int] = {"calls": 0, "bytes": 0}

    def _ingest(*, content_type: str, content_encoding: str, body: bytes, request_path: str, **_: object) -> int:
        assert "application/json" in content_type.lower()
        assert content_encoding == ""
        assert request_path == "/api/otel/v1/traces"
        recorded["calls"] += 1
        recorded["bytes"] += len(body)
        return 7

    cfg = MockConfig(passthrough=False, rules=[])
    handle = start_mock_gateway(cfg, otel_ingest=_ingest)
    assert handle is not None
    try:
        payload = b'{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"a","spanId":"b","name":"x"}]}]}]}'
        req = urllib.request.Request(
            f"{handle.local_endpoint}/api/otel/v1/traces",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read().decode("utf-8")
        got = json.loads(body)
        assert got.get("inserted") == 7
        assert recorded["calls"] == 1
        assert recorded["bytes"] == len(payload)
    finally:
        handle.close()


def test_mock_gateway_starts_even_without_config() -> None:
    handle = start_mock_gateway(None)
    assert handle is not None
    try:
        req = urllib.request.Request(
            f"{handle.local_endpoint}/api/otel/v1/traces",
            data=b'{"resourceSpans":[]}',
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read().decode("utf-8")
        got = json.loads(body)
        assert got.get("mock") == "otel-default"
    finally:
        handle.close()
