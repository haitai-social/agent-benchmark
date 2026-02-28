#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -x ".venv/bin/python" ]]; then
  echo "missing .venv/bin/python; please create venv first" >&2
  exit 1
fi

if [[ -f ".env" ]]; then
  set -a
  source ".env"
  set +a
fi

cleanup_inspect_sandboxes() {
  local ids=""
  ids="$(docker ps -aq --filter name=inspect-sb- 2>/dev/null || true)"
  if [[ -n "${ids}" ]]; then
    echo "[acceptance] cleanup stale inspect sandboxes: ${ids//$'\n'/ }"
    # shellcheck disable=SC2086
    docker rm -f ${ids} >/dev/null 2>&1 || true
  fi
}

verify_no_inspect_leak() {
  local left=""
  left="$(docker ps -aq --filter name=inspect-sb- 2>/dev/null || true)"
  if [[ -n "${left}" ]]; then
    echo "[acceptance] leak detected: inspect sandbox containers still exist: ${left//$'\n'/ }" >&2
    return 1
  fi
  echo "[acceptance] leak check passed: no inspect sandbox containers left"
  return 0
}

finalize() {
  local result=$?
  cleanup_inspect_sandboxes
  if ! verify_no_inspect_leak; then
    if [[ $result -eq 0 ]]; then
      result=1
    fi
  fi
  exit "$result"
}
trap finalize EXIT

echo "[acceptance] running direct acceptance (no RabbitMQ)..."
set +e
PYTHONPATH=src .venv/bin/python tests/acceptance/e2e_experiments.py
result=$?
set -e

if [[ $result -ne 0 ]]; then
  echo "[acceptance] failed" >&2
  exit "$result"
fi

echo "[acceptance] passed"
