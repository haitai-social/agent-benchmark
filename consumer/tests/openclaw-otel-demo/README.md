# OpenClaw OTel Demo Image

This folder contains the test/demo assets for building the OpenClaw OTEL demo image used in E2E debugging.

## Build

Run from `consumer/` root:

```bash
docker build -f tests/openclaw-otel-demo/Dockerfile -t local/openclaw:afterexec .
```

## Runtime scripts included in image

- `openclaw_case_request.py`
  - sends one `/v1/chat/completions` request to OpenClaw gateway
  - writes response to `/tmp/openclaw-last-response.json`
  - resolves generated session jsonl path and writes it to `/tmp/openclaw-last-session-path.txt`

- `openclaw_session_to_otel.py`
  - strictly reads session path from `/tmp/openclaw-last-session-path.txt`
  - parses OpenClaw session jsonl events
  - emits OTEL traces/logs to fixed endpoint:
    - `http://host.docker.internal:14318/api/otel/v1/traces`
    - `http://host.docker.internal:14318/api/otel/v1/logs`

