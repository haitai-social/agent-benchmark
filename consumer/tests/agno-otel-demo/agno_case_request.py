#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
import uuid
from dataclasses import dataclass
from typing import Any

from agno.agent import Agent
from agno.models.openai.like import OpenAILike
from opentelemetry import trace
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


@dataclass(frozen=True)
class Args:
    user_input: str
    base_url: str
    api_key: str
    model_name: str
    run_case_id: str
    experiment_id: str
    trace_id: str
    otel_endpoint: str


def _parse_args() -> Args:
    parser = argparse.ArgumentParser(description="Run Agno case and export OTEL traces/logs.")
    parser.add_argument("--user-input", required=True, help="User input for the agent.")
    parser.add_argument("--base-url", required=True, help="Provider base_url in OpenAI style.")
    parser.add_argument("--api-key", required=True, help="Provider API key.")
    parser.add_argument("--model-name", required=True, help="Provider model name.")
    parser.add_argument("--run-case-id", required=True, help="Run case ID.")
    parser.add_argument("--experiment-id", required=True, help="Experiment ID.")
    parser.add_argument("--trace-id", default="", help="Optional run case trace id.")
    parser.add_argument(
        "--otel-endpoint",
        default="http://host.docker.internal:14318/api/otel",
        help="Base OTEL endpoint (without /v1/traces suffix).",
    )
    parsed = parser.parse_args()
    return Args(
        user_input=str(parsed.user_input or "").strip(),
        base_url=str(parsed.base_url or "").strip(),
        api_key=str(parsed.api_key or "").strip(),
        model_name=str(parsed.model_name or "").strip(),
        run_case_id=str(parsed.run_case_id or "").strip(),
        experiment_id=str(parsed.experiment_id or "").strip(),
        trace_id=str(parsed.trace_id or "").strip(),
        otel_endpoint=str(parsed.otel_endpoint or "").strip().rstrip("/"),
    )


def _init_telemetry(args: Args) -> tuple[TracerProvider, LoggerProvider, logging.Logger]:
    if not args.otel_endpoint:
        raise RuntimeError("empty --otel-endpoint")

    resource = Resource.create(
        {
            "service.name": "agno.gateway",
            "benchmark.run_case_id": args.run_case_id,
            "benchmark.experiment_id": args.experiment_id,
        }
    )

    tracer_provider = TracerProvider(resource=resource)
    span_exporter = OTLPSpanExporter(endpoint=f"{args.otel_endpoint}/v1/traces")
    tracer_provider.add_span_processor(
        BatchSpanProcessor(
            span_exporter,
            max_export_batch_size=128,
            schedule_delay_millis=500,
        )
    )
    trace.set_tracer_provider(tracer_provider)

    logger_provider = LoggerProvider(resource=resource)
    log_exporter = OTLPLogExporter(endpoint=f"{args.otel_endpoint}/v1/logs")
    logger_provider.add_log_record_processor(
        BatchLogRecordProcessor(
            log_exporter,
            max_export_batch_size=128,
            schedule_delay_millis=500,
        )
    )
    set_logger_provider(logger_provider)

    app_logger = logging.getLogger("agno.gateway")
    app_logger.setLevel(logging.INFO)
    app_logger.handlers.clear()
    app_logger.propagate = False
    app_logger.addHandler(LoggingHandler(level=logging.INFO, logger_provider=logger_provider))
    return tracer_provider, logger_provider, app_logger


def _extract_text(response: Any) -> str:
    if isinstance(response, str):
        return response.strip()

    content = getattr(response, "content", None)
    if isinstance(content, str) and content.strip():
        return content.strip()

    messages = getattr(response, "messages", None)
    if isinstance(messages, list) and messages:
        last = messages[-1]
        maybe_content = getattr(last, "content", None)
        if isinstance(maybe_content, str) and maybe_content.strip():
            return maybe_content.strip()

    if isinstance(response, dict):
        value = response.get("content")
        if isinstance(value, str) and value.strip():
            return value.strip()

    raise RuntimeError("E_AGNO_EMPTY_RESPONSE")


def main() -> int:
    args = _parse_args()
    if not args.user_input:
        raise RuntimeError("E_EMPTY_USER_INPUT")

    tracer_provider, logger_provider, app_logger = _init_telemetry(args)
    tracer = trace.get_tracer("agno.gateway.runner")

    request_id = uuid.uuid4().hex
    start = time.time()
    with tracer.start_as_current_span("agno.case.run") as root_span:
        root_span.set_attribute("benchmark.run_case_id", args.run_case_id)
        root_span.set_attribute("benchmark.experiment_id", args.experiment_id)
        root_span.set_attribute("query", args.user_input)
        if args.trace_id:
            root_span.set_attribute("benchmark.trace_id", args.trace_id)
        root_span.add_event("user.query", {"query": args.user_input})

        app_logger.info(
            "query",
            extra={
                "query": args.user_input,
                "benchmark.run_case_id": args.run_case_id,
                "benchmark.experiment_id": args.experiment_id,
                "service.name": "agno.gateway",
            },
        )

        model = OpenAILike(
            id=args.model_name,
            api_key=args.api_key,
            base_url=args.base_url,
        )
        agent = Agent(model=model)

        with tracer.start_as_current_span("agno.agent.invoke") as invoke_span:
            invoke_span.set_attribute("model.name", args.model_name)
            response = agent.run(args.user_input)

        output_text = _extract_text(response)
        root_span.set_attribute("final_answer", output_text)
        root_span.add_event("assistant.final", {"final_answer": output_text})

        app_logger.info(
            "final_answer",
            extra={
                "final_answer": output_text,
                "benchmark.run_case_id": args.run_case_id,
                "benchmark.experiment_id": args.experiment_id,
                "service.name": "agno.gateway",
            },
        )

    latency_ms = int((time.time() - start) * 1000)

    payload = {
        "id": f"chatcmpl-{request_id}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": args.model_name,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": output_text,
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
        "benchmark": {
            "run_case_id": args.run_case_id,
            "experiment_id": args.experiment_id,
            "latency_ms": latency_ms,
        },
    }
    print(json.dumps(payload, ensure_ascii=False))

    logger_provider.force_flush(timeout_millis=5000)
    tracer_provider.force_flush(timeout_millis=5000)
    logger_provider.shutdown()
    tracer_provider.shutdown()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise
