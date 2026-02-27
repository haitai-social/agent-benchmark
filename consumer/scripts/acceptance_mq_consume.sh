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

LOG_FILE="${ACCEPTANCE_CONSUMER_LOG:-/tmp/arcloop-consumer-acceptance.log}"
PID_FILE="${ACCEPTANCE_CONSUMER_PID_FILE:-/tmp/arcloop-consumer-acceptance.pid}"

cleanup() {
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$PID_FILE"
  fi
}
trap cleanup EXIT

echo "[acceptance] starting consumer in background..."
./scripts/run-local.sh >"$LOG_FILE" 2>&1 &
consumer_pid=$!
echo "$consumer_pid" >"$PID_FILE"
echo "[acceptance] consumer pid=$consumer_pid log=$LOG_FILE"

# Give consumer boot time (install deps + connect MQ/DB).
sleep "${ACCEPTANCE_BOOT_WAIT_SECONDS:-8}"

echo "[acceptance] dispatching and polling experiment..."
set +e
PYTHONPATH=src .venv/bin/python tests/acceptance/acceptance_mq_consume.py
result=$?
set -e

if [[ $result -ne 0 ]]; then
  echo "[acceptance] failed, showing consumer log tail:" >&2
  tail -n 200 "$LOG_FILE" >&2 || true
  exit "$result"
fi

echo "[acceptance] passed"
