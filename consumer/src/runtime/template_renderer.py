from __future__ import annotations

import json
import re
from typing import Any

_PLACEHOLDER_PATTERN = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_\.]*)\s*\}\}")


class TemplateRenderError(ValueError):
    """Raised when a template contains an unknown or invalid variable path."""


def render_as_template(template: str, context: dict[str, Any]) -> str:
    def _replace(match: re.Match[str]) -> str:
        path = match.group(1)
        value = _resolve_path(context, path)
        if isinstance(value, str):
            return value
        return json.dumps(value, ensure_ascii=False, indent=2)

    return _PLACEHOLDER_PATTERN.sub(_replace, template)


def _resolve_path(context: dict[str, Any], path: str) -> Any:
    current: Any = context
    for segment in path.split("."):
        if isinstance(current, dict):
            if segment not in current:
                raise TemplateRenderError(f"E_TEMPLATE_VARIABLE_NOT_FOUND: {path}")
            current = current[segment]
            continue
        raise TemplateRenderError(f"E_TEMPLATE_VARIABLE_NOT_FOUND: {path}")
    return current
