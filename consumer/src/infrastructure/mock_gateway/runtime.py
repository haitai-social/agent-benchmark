from __future__ import annotations

import json
import threading
from dataclasses import asdict
from typing import Any

from domain.contracts import MockConfig
from infrastructure.config import load_settings
from infrastructure.trace_repository import TraceIngestRepository

from .otel_ingest import OTelIngestSink, ingest_otel_request
from .server import MockGatewayHandle, MockGatewayServer

_default_trace_sink: OTelIngestSink | None = None
_MOCK_GATEWAY_PORT = 14318
_shared_lock = threading.Lock()
_shared_handle: MockGatewayHandle | None = None
_shared_ref_count = 0
_shared_signature: str | None = None


def _signature_for_config(cfg: MockConfig, ingest: object | None) -> str:
    return json.dumps(
        {
            "cfg": asdict(cfg),
            "ingest": "default" if ingest is None else f"custom:{id(ingest)}",
            "port": _MOCK_GATEWAY_PORT,
        },
        ensure_ascii=False,
        sort_keys=True,
    )


def _get_default_trace_sink() -> OTelIngestSink | None:
    global _default_trace_sink
    if _default_trace_sink is not None:
        return _default_trace_sink
    try:
        settings = load_settings()
        _default_trace_sink = TraceIngestRepository.from_settings(settings)
    except Exception:
        # Do not cache failed initialization forever. Network/DB readiness
        # can recover during a long-running worker process.
        return None
    return _default_trace_sink


def _extract_extra_attributes(headers: dict[str, str] | None) -> dict[str, Any]:
    if not headers:
        return {}
    lowered = {str(k).lower(): str(v) for k, v in headers.items()}
    mapped: dict[str, Any] = {}
    run_case_id = lowered.get("x-benchmark-run-case-id") or lowered.get("x-run-case-id")
    data_item_id = lowered.get("x-benchmark-data-item-id") or lowered.get("x-data-item-id")
    experiment_id = lowered.get("x-benchmark-experiment-id") or lowered.get("x-experiment-id")
    if run_case_id:
        mapped["benchmark.run_case_id"] = run_case_id
    if data_item_id:
        mapped["benchmark.data_item_id"] = data_item_id
    if experiment_id:
        mapped["benchmark.experiment_id"] = experiment_id
    return mapped


def _default_otel_ingest(
    *,
    content_type: str,
    content_encoding: str,
    body: bytes,
    headers: dict[str, str] | None = None,
    request_path: str | None = None,
) -> int:
    sink = _get_default_trace_sink()
    if sink is None:
        return 0
    return ingest_otel_request(
        sink=sink,
        content_type=content_type,
        content_encoding=content_encoding,
        body=body,
        extra_attributes=_extract_extra_attributes(headers),
        request_path=request_path,
    )


def start_mock_gateway(cfg: MockConfig | None, otel_ingest: object | None = None) -> MockGatewayHandle | None:
    effective_cfg = cfg if cfg is not None else MockConfig(passthrough=True, rules=[])
    ingest = otel_ingest if otel_ingest is not None else _default_otel_ingest
    signature = _signature_for_config(effective_cfg, None if otel_ingest is None else otel_ingest)

    with _shared_lock:
        global _shared_handle
        global _shared_ref_count
        global _shared_signature

        if _shared_handle is not None:
            if _shared_signature != signature:
                raise RuntimeError(
                    "E_MOCK_GATEWAY_CONFIG_CONFLICT: concurrent start requested with different mock config"
                )
            _shared_ref_count += 1
            return MockGatewayHandle(
                endpoint=_shared_handle.endpoint,
                local_endpoint=_shared_handle.local_endpoint,
                _server=None,
                _thread=None,
                _closer=_release_shared_gateway,
            )

        _shared_handle = MockGatewayServer(effective_cfg, otel_ingest=ingest).start(port=_MOCK_GATEWAY_PORT)
        _shared_signature = signature
        _shared_ref_count = 1
        return MockGatewayHandle(
            endpoint=_shared_handle.endpoint,
            local_endpoint=_shared_handle.local_endpoint,
            _server=None,
            _thread=None,
            _closer=_release_shared_gateway,
        )


def _release_shared_gateway() -> None:
    with _shared_lock:
        global _shared_handle
        global _shared_ref_count
        global _shared_signature
        if _shared_ref_count > 0:
            _shared_ref_count -= 1
        if _shared_ref_count != 0:
            return
        handle = _shared_handle
        _shared_handle = None
        _shared_signature = None
    if handle is not None:
        handle.close()
