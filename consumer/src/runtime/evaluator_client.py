from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any

import requests


@dataclass(frozen=True)
class EvaluatorCallInput:
    user_input: str
    trajectory: Any
    agent_output: Any
    reference_output: Any
    tools: Any


def call_evaluator(
    *,
    api_style: str,
    base_url: str,
    api_key: str,
    model_name: str,
    prompt_template: str,
    payload: EvaluatorCallInput,
    timeout_seconds: int = 30,
    connect_timeout_seconds: int | None = None,
    read_timeout_seconds: int | None = None,
    max_retries: int = 2,
    retry_backoff_seconds: float = 1.0,
) -> tuple[float, str, dict[str, Any]]:
    rendered_prompt = _render_prompt(prompt_template, payload)
    normalized_style = (api_style or "openai").strip().lower()
    timeout = _resolve_timeout(
        timeout_seconds=timeout_seconds,
        connect_timeout_seconds=connect_timeout_seconds,
        read_timeout_seconds=read_timeout_seconds,
    )
    attempts = max(1, max_retries + 1)
    last_exc: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            if normalized_style == "anthropic":
                return _call_anthropic(
                    base_url=base_url,
                    api_key=api_key,
                    model_name=model_name,
                    prompt=rendered_prompt,
                    timeout=timeout,
                )
            return _call_openai_compatible(
                base_url=base_url,
                api_key=api_key,
                model_name=model_name,
                prompt=rendered_prompt,
                timeout=timeout,
            )
        except Exception as exc:
            last_exc = exc
            if attempt >= attempts or not _is_retryable_exception(exc):
                raise
            time.sleep(max(0.0, retry_backoff_seconds) * (2 ** (attempt - 1)))
    assert last_exc is not None
    raise last_exc


def _render_prompt(template: str, payload: EvaluatorCallInput) -> str:
    prompt = template or ""
    replacements = {
        "{{user_input}}": payload.user_input,
        "{{trajectory}}": json.dumps(payload.trajectory, ensure_ascii=False, indent=2),
        "{{agent_output}}": json.dumps(payload.agent_output, ensure_ascii=False, indent=2),
        "{{reference_output}}": json.dumps(payload.reference_output, ensure_ascii=False, indent=2),
        "{{tools}}": json.dumps(payload.tools, ensure_ascii=False, indent=2),
    }
    for key, value in replacements.items():
        prompt = prompt.replace(key, value)
    return prompt


def _call_openai_compatible(
    *,
    base_url: str,
    api_key: str,
    model_name: str,
    prompt: str,
    timeout: float | tuple[float, float],
) -> tuple[float, str, dict[str, Any]]:
    endpoint = f"{base_url.rstrip('/')}/chat/completions"
    response = requests.post(
        endpoint,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        json={
            "model": model_name,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": "Return JSON only: {\"score\":0|0.5|1,\"reason\":\"...\"}"},
                {"role": "user", "content": prompt},
            ],
            "response_format": {"type": "json_object"},
        },
        timeout=timeout,
    )
    response.raise_for_status()
    body = response.json()
    raw_content = (
        ((body.get("choices") or [{}])[0].get("message") or {}).get("content")
        if isinstance(body, dict)
        else None
    )
    score, reason = _extract_score(raw_content)
    return score, reason, body


def _call_anthropic(
    *,
    base_url: str,
    api_key: str,
    model_name: str,
    prompt: str,
    timeout: float | tuple[float, float],
) -> tuple[float, str, dict[str, Any]]:
    endpoint = f"{base_url.rstrip('/')}/messages"
    response = requests.post(
        endpoint,
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "Authorization": f"Bearer {api_key}",
            "anthropic-version": "2023-06-01",
        },
        json={
            "model": model_name,
            "max_tokens": 512,
            "temperature": 0,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=timeout,
    )
    if response.ok:
        body = response.json()
        raw_content = ""
        if isinstance(body, dict):
            items = body.get("content")
            if isinstance(items, list):
                for item in items:
                    if isinstance(item, dict) and isinstance(item.get("text"), str):
                        raw_content = item["text"]
                        break
        score, reason = _extract_score(raw_content)
        return score, reason, body

    # Some "anthropic-style" providers still expose OpenAI-compatible completions.
    fallback_endpoint = f"{base_url.rstrip('/')}/chat/completions"
    fallback = requests.post(
        fallback_endpoint,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "x-api-key": api_key,
        },
        json={
            "model": model_name,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": "Return JSON only: {\"score\":0|0.5|1,\"reason\":\"...\"}"},
                {"role": "user", "content": prompt},
            ],
            "response_format": {"type": "json_object"},
        },
        timeout=timeout,
    )
    fallback.raise_for_status()
    body = fallback.json()
    raw_content = (
        ((body.get("choices") or [{}])[0].get("message") or {}).get("content")
        if isinstance(body, dict)
        else None
    )
    score, reason = _extract_score(raw_content)
    return score, reason, body


def _resolve_timeout(
    *,
    timeout_seconds: int,
    connect_timeout_seconds: int | None,
    read_timeout_seconds: int | None,
) -> float | tuple[float, float]:
    connect = connect_timeout_seconds if connect_timeout_seconds is not None else timeout_seconds
    read = read_timeout_seconds if read_timeout_seconds is not None else timeout_seconds
    return (float(connect), float(read))


def _is_retryable_exception(exc: Exception) -> bool:
    if isinstance(exc, (requests.Timeout, requests.ConnectionError)):
        return True
    if isinstance(exc, requests.HTTPError):
        status = exc.response.status_code if exc.response is not None else 0
        return status in {408, 409, 425, 429, 500, 502, 503, 504}
    return False


def _extract_score(raw_content: Any) -> tuple[float, str]:
    if not isinstance(raw_content, str) or not raw_content.strip():
        return -1.0, "E_EVALUATOR_EMPTY_CONTENT"
    parsed: dict[str, Any]
    try:
        parsed = json.loads(raw_content)
    except json.JSONDecodeError:
        return -1.0, f"E_EVALUATOR_INVALID_JSON: {raw_content[:200]}"
    score = parsed.get("score")
    reason = str(parsed.get("reason") or "no reason provided")
    if score in (0, 0.5, 1):
        return float(score), reason
    try:
        numeric = float(score)
    except Exception:
        return -1.0, f"E_EVALUATOR_SCORE_INVALID: {reason}"
    if numeric >= 0.9:
        return 1.0, reason
    if numeric >= 0.6:
        return 0.5, reason
    return 0.0, reason
