#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -d ".venv" ]]; then
  python3 -m venv .venv
fi

if [[ -f ".env" ]]; then
  set -a
  source ".env"
  set +a
fi

.venv/bin/pip install -r requirements.txt
PYTHONPATH=src .venv/bin/python -m app.main
