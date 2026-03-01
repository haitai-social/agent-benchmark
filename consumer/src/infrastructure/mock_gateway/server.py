from __future__ import annotations

import base64
import json
import logging
import re
import select
import socket
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

logger = logging.getLogger(__name__)


@dataclass
class MockGatewayHandle:
    endpoint: str
    local_endpoint: str
    _server: ThreadingHTTPServer | None
    _thread: threading.Thread | None
    _closer: Callable[[], None] | None = None

    def close(self) -> None:
        closer = self._closer
        self._closer = None
        if closer is not None:
            closer()
            return
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1)
        self._thread = None


class MockGatewayServer:
    def __init__(self, cfg: Any, otel_ingest: Any | None = None) -> None:
        self.cfg = cfg
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self._otel_ingest = otel_ingest

    def start(self, *, port: int = 0) -> MockGatewayHandle:
        gateway = self

        class _Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_CONNECT(self) -> None:  # noqa: N802
                gateway._handle_connect(self)

            def do_GET(self) -> None:  # noqa: N802
                gateway._handle_http(self)

            def do_POST(self) -> None:  # noqa: N802
                gateway._handle_http(self)

            def do_PUT(self) -> None:  # noqa: N802
                gateway._handle_http(self)

            def do_PATCH(self) -> None:  # noqa: N802
                gateway._handle_http(self)

            def do_DELETE(self) -> None:  # noqa: N802
                gateway._handle_http(self)

            def do_OPTIONS(self) -> None:  # noqa: N802
                gateway._handle_http(self)

            def do_HEAD(self) -> None:  # noqa: N802
                gateway._handle_http(self)

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
                logger.debug("code=MOCK_GATEWAY_HTTP " + format, *args)

        httpd = ThreadingHTTPServer(("0.0.0.0", port), _Handler)
        port = int(httpd.server_address[1])
        thread = threading.Thread(target=httpd.serve_forever, daemon=True, name="mock-gateway")
        thread.start()
        endpoint = f"http://host.docker.internal:{port}"
        local_endpoint = f"http://127.0.0.1:{port}"
        logger.info("code=MOCK_GATEWAY_STARTED endpoint=%s local_endpoint=%s rules=%s passthrough=%s", endpoint, local_endpoint, len(self.cfg.rules), self.cfg.passthrough)
        def _close_server() -> None:
            if httpd:
                httpd.shutdown()
                httpd.server_close()
            if thread.is_alive():
                thread.join(timeout=1)

        return MockGatewayHandle(
            endpoint=endpoint,
            local_endpoint=local_endpoint,
            _server=httpd,
            _thread=thread,
            _closer=_close_server,
        )

    def _handle_connect(self, handler: BaseHTTPRequestHandler) -> None:
        if not self.cfg.passthrough:
            handler.send_error(502, "CONNECT disabled by mock config")
            return
        try:
            host_port = handler.path.split(":", 1)
            host = host_port[0]
            port = int(host_port[1]) if len(host_port) > 1 else 443
            upstream = socket.create_connection((host, port), timeout=10)
        except Exception as exc:
            handler.send_error(502, f"CONNECT failed: {exc}")
            return

        handler.send_response(200, "Connection Established")
        handler.end_headers()
        self._tunnel(handler.connection, upstream)

    def _tunnel(self, client: socket.socket, upstream: socket.socket) -> None:
        sockets = [client, upstream]
        try:
            while True:
                readable, _, errored = select.select(sockets, [], sockets, 0.5)
                if errored:
                    return
                for src in readable:
                    data = src.recv(8192)
                    if not data:
                        return
                    dst = upstream if src is client else client
                    dst.sendall(data)
        finally:
            upstream.close()

    def _handle_http(self, handler: BaseHTTPRequestHandler) -> None:
        method = handler.command.upper()
        body = self._read_body(handler)
        url = self._resolve_url(handler)
        parsed = urlparse(url)
        headers = {k: v for k, v in handler.headers.items()}
        req = {
            "method": method,
            "url": url,
            "scheme": parsed.scheme,
            "host": parsed.netloc,
            "path": parsed.path or "/",
            "query": parse_qs(parsed.query, keep_blank_values=True),
            "headers": headers,
            "body_text": body.decode("utf-8", errors="replace"),
            "body_bytes_b64": base64.b64encode(body).decode("ascii"),
        }
        req_path_lower = str(req["path"]).lower()
        if req["method"] == "POST" and ("otel" in req_path_lower or "trace" in req_path_lower):
            logger.info(
                "code=MOCK_GATEWAY_OTEL_CANDIDATE method=%s url=%s path=%s host=%s content_type=%s",
                req["method"],
                req["url"],
                req["path"],
                req["host"],
                str(req["headers"].get("Content-Type") or ""),
            )

        if self._is_default_otel_request(req):
            inserted = 0
            if callable(self._otel_ingest):
                try:
                    try:
                        res = self._otel_ingest(
                            content_type=str(req["headers"].get("Content-Type") or ""),
                            content_encoding=str(req["headers"].get("Content-Encoding") or ""),
                            body=body,
                            headers={str(k): str(v) for k, v in req["headers"].items()},
                            request_path=str(req["path"] or ""),
                        )
                    except TypeError:
                        res = self._otel_ingest(
                            content_type=str(req["headers"].get("Content-Type") or ""),
                            content_encoding=str(req["headers"].get("Content-Encoding") or ""),
                            body=body,
                        )
                    if isinstance(res, (int, float, str)):
                        inserted = int(res)
                    else:
                        inserted = 0
                except Exception as exc:
                    logger.warning("code=MOCK_GATEWAY_OTEL_INGEST_FAILED err=%s", exc)
            logger.info(
                "code=MOCK_GATEWAY_OTEL_DEFAULT_HIT method=%s url=%s content_length=%s inserted=%s",
                req["method"],
                req["url"],
                len(body),
                inserted,
            )
            self._write_response(
                handler,
                200,
                {"content-type": "application/json", "x-mock-gateway": "otel-default"},
                json.dumps({"ok": True, "mock": "otel-default", "inserted": inserted}).encode("utf-8"),
            )
            return

        rule = self._match_rule(req)
        if rule is not None:
            status, resp_headers, payload = self._render_rule_response(rule, req)
            self._write_response(handler, status, resp_headers, payload)
            return

        if not self.cfg.passthrough:
            self._write_response(handler, 404, {"content-type": "application/json"}, b'{"ok":false,"error":"no_mock_rule"}')
            return

        self._proxy_request(handler, req, body)

    def _is_default_otel_request(self, req: dict[str, Any]) -> bool:
        if str(req.get("method") or "").upper() != "POST":
            return False
        path = str(req.get("path") or "")
        return path == "/api/otel/v1/traces" or path == "/api/otel/v1/logs"

    def _read_body(self, handler: BaseHTTPRequestHandler) -> bytes:
        length = int(handler.headers.get("Content-Length") or "0")
        if length <= 0:
            return b""
        return handler.rfile.read(length)

    def _resolve_url(self, handler: BaseHTTPRequestHandler) -> str:
        if handler.path.startswith("http://") or handler.path.startswith("https://"):
            return handler.path
        host = handler.headers.get("Host") or ""
        path = handler.path if handler.path.startswith("/") else f"/{handler.path}"
        return f"http://{host}{path}"

    def _match_rule(self, req: dict[str, Any]) -> Any | None:
        for rule in self.cfg.rules:
            if self._rule_matches(rule, req):
                return rule
        return None

    def _rule_matches(self, rule: Any, req: dict[str, Any]) -> bool:
        m = rule.match
        methods = [x.upper() for x in m.methods if x]
        if methods and req["method"] not in methods:
            return False
        if m.url and req["url"] != m.url:
            return False
        if m.url_regex and not re.search(m.url_regex, req["url"]):
            return False
        if m.host and req["host"] != m.host:
            return False
        if m.path and req["path"] != m.path:
            return False
        if m.path_regex and not re.search(m.path_regex, req["path"]):
            return False
        return True

    def _render_rule_response(self, rule: Any, req: dict[str, Any]) -> tuple[int, dict[str, str], bytes]:
        spec = rule.response
        status = max(100, int(spec.status or 200))
        headers = dict(spec.headers or {})

        if spec.type == "python":
            result = self._execute_python(spec.python_code, req)
            status = max(100, int(result.get("status", status)))
            headers.update({str(k): str(v) for k, v in dict(result.get("headers") or {}).items()})
            if "json" in result:
                headers.setdefault("content-type", "application/json")
                return status, headers, json.dumps(result.get("json"), ensure_ascii=False).encode("utf-8")
            if "text" in result:
                headers.setdefault("content-type", "text/plain; charset=utf-8")
                return status, headers, str(result.get("text")).encode("utf-8")
            if "body_base64" in result:
                return status, headers, base64.b64decode(str(result.get("body_base64")))
            return status, headers, b""

        if spec.type == "text":
            headers.setdefault("content-type", "text/plain; charset=utf-8")
            return status, headers, spec.text_body.encode("utf-8")

        headers.setdefault("content-type", "application/json")
        return status, headers, json.dumps(spec.json_body, ensure_ascii=False).encode("utf-8")

    def _execute_python(self, code: str, request: dict[str, Any]) -> dict[str, Any]:
        if not code.strip():
            raise RuntimeError("E_MOCK_PYTHON_EMPTY_CODE")
        safe_globals: dict[str, Any] = {
            "__builtins__": {
                "len": len,
                "str": str,
                "int": int,
                "float": float,
                "bool": bool,
                "dict": dict,
                "list": list,
                "min": min,
                "max": max,
                "sum": sum,
                "sorted": sorted,
                "range": range,
            },
            "json": json,
            "re": re,
            "time": time,
        }
        local_scope: dict[str, Any] = {}
        exec(code, safe_globals, local_scope)
        fn = local_scope.get("handle") or safe_globals.get("handle")
        if not callable(fn):
            raise RuntimeError("E_MOCK_PYTHON_MISSING_HANDLE: define handle(request)")
        result = fn(request)
        if not isinstance(result, dict):
            raise RuntimeError("E_MOCK_PYTHON_INVALID_RESULT: handle(request) must return dict")
        return result

    def _proxy_request(self, handler: BaseHTTPRequestHandler, req: dict[str, Any], body: bytes) -> None:
        target_url = str(req["url"])
        outgoing_headers = dict(req["headers"])
        outgoing_headers.pop("Proxy-Connection", None)
        outgoing_headers.pop("Connection", None)
        request = urllib.request.Request(target_url, data=body if body else None, method=str(req["method"]), headers=outgoing_headers)
        try:
            with self._opener.open(request, timeout=30) as resp:
                status = int(getattr(resp, "status", 200))
                headers = {k: v for k, v in resp.headers.items()}
                payload = resp.read()
                self._write_response(handler, status, headers, payload)
        except urllib.error.HTTPError as exc:
            payload = exc.read() if hasattr(exc, "read") else b""
            headers = dict(exc.headers.items()) if exc.headers else {}
            self._write_response(handler, int(exc.code), headers, payload)
        except Exception as exc:
            self._write_response(handler, 502, {"content-type": "application/json"}, json.dumps({"ok": False, "error": str(exc)}).encode("utf-8"))

    def _write_response(self, handler: BaseHTTPRequestHandler, status: int, headers: dict[str, str], payload: bytes) -> None:
        handler.send_response(status)
        sent_content_length = False
        for key, value in headers.items():
            lower = key.lower()
            if lower in {"transfer-encoding", "connection"}:
                continue
            if lower == "content-length":
                sent_content_length = True
            handler.send_header(key, value)
        if not sent_content_length:
            handler.send_header("Content-Length", str(len(payload)))
        handler.end_headers()
        if payload:
            handler.wfile.write(payload)
