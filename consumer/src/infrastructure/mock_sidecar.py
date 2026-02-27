from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass
from typing import Protocol

from testcontainers.core.container import DockerContainer

from domain.contracts import MockConfig


class StoppableContainer(Protocol):
    def stop(self) -> None: ...


@dataclass
class SidecarHandle:
    endpoint: str
    _container: StoppableContainer | None

    def close(self) -> None:
        if self._container is not None:
            self._container.stop()
            self._container = None


def start_mock_sidecar(cfg: MockConfig | None) -> SidecarHandle | None:
    if cfg is None:
        return None

    container = DockerContainer("wiremock/wiremock:3.9.1").with_exposed_ports(8080)
    container.start()
    host = container.get_container_host_ip()
    port = container.get_exposed_port(8080)
    endpoint = f"http://{host}:{port}"

    for route in cfg.routes:
        payload = {
            "request": {"method": route.method.upper(), "urlPath": route.path},
            "response": {"status": route.status_code, "body": route.body, "headers": route.headers},
        }
        req = urllib.request.Request(
            f"{endpoint}/__admin/mappings",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status >= 300:
                raise RuntimeError(f"mock sidecar mapping failed with status {resp.status}")

    return SidecarHandle(endpoint=endpoint, _container=container)
