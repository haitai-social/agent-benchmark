# Agno OTel Demo Image

This folder contains a minimal Agno-based image for consumer E2E OTEL verification.

## Build

Run from `consumer/` root:

```bash
docker build -f tests/agno-otel-demo/Dockerfile -t ghcr.io/haitai-social/agent-benchmark:agno-otel-demo .
```

## Runtime command

The image provides:

- `/opt/agno/agno_case_request.py`

Expected args:

- `--user-input`
- `--base-url`
- `--api-key`
- `--model-name`
- `--run-case-id`
- `--experiment-id`
- `--trace-id` (optional)
- `--otel-endpoint` (optional, default `http://host.docker.internal:14318/api/otel`)

Behavior:

1. Runs an Agno agent call.
2. Exports OTEL traces and logs using OTLP HTTP to `/api/otel/v1/traces` and `/api/otel/v1/logs`.
3. Prints an OpenAI-compatible JSON response to stdout.
