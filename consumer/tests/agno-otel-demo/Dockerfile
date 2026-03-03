FROM alpine/openclaw:2026.2.26

USER root
WORKDIR /app

RUN if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache python3 py3-pip ca-certificates; \
    elif command -v apt-get >/dev/null 2>&1; then \
      apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates && rm -rf /var/lib/apt/lists/*; \
    else \
      echo "no supported package manager found" && exit 1; \
    fi

RUN python3 -m pip install --break-system-packages --no-cache-dir \
    agno \
    openai \
    opentelemetry-sdk \
    opentelemetry-exporter-otlp-proto-http

COPY tests/agno-otel-demo/agno_case_request.py /opt/agno/agno_case_request.py
RUN chmod +x /opt/agno/agno_case_request.py

USER node
CMD ["sh", "-lc", "sleep infinity"]
