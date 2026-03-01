FROM alpine/openclaw:2026.2.26

USER root
WORKDIR /app

RUN if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache python3; \
    elif command -v apt-get >/dev/null 2>&1; then \
      apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*; \
    else \
      echo "no supported package manager found" && exit 1; \
    fi

COPY tests/openclaw-otel-demo/openclaw_session_to_otel.py /opt/openclaw/openclaw_session_to_otel.py
COPY tests/openclaw-otel-demo/openclaw_case_request.py /opt/openclaw/openclaw_case_request.py
RUN chmod +x /opt/openclaw/openclaw_session_to_otel.py
RUN chmod +x /opt/openclaw/openclaw_case_request.py

USER node
