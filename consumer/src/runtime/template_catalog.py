from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class TemplateVariableDefinition:
    path: str
    description: str
    example: str | None


@dataclass(frozen=True)
class TemplateVariableGroup:
    title: str
    variables: tuple[TemplateVariableDefinition, ...]
    applies_to_fields: tuple[str, ...]


_CACHED_GROUPS: dict[str, TemplateVariableGroup] | None = None


def _registry_path() -> Path:
    return Path(__file__).resolve().parents[3] / "contracts" / "template_variables.json"


def _load_registry_groups() -> dict[str, TemplateVariableGroup]:
    global _CACHED_GROUPS
    if _CACHED_GROUPS is not None:
        return _CACHED_GROUPS

    registry_file = _registry_path()
    payload = json.loads(registry_file.read_text(encoding="utf-8"))

    version = payload.get("version")
    if not isinstance(version, int) or version <= 0:
        raise RuntimeError(f"E_TEMPLATE_VARS_INVALID_VERSION: {version}")

    groups_raw = payload.get("groups")
    if not isinstance(groups_raw, dict):
        raise RuntimeError("E_TEMPLATE_VARS_INVALID_GROUPS")

    groups: dict[str, TemplateVariableGroup] = {}
    for group_name, group_value in groups_raw.items():
        if not isinstance(group_name, str) or not isinstance(group_value, dict):
            raise RuntimeError(f"E_TEMPLATE_VARS_INVALID_GROUP: {group_name}")
        title = str(group_value.get("title") or group_name).strip()
        variables_raw = group_value.get("variables")
        if not isinstance(variables_raw, list) or len(variables_raw) == 0:
            raise RuntimeError(f"E_TEMPLATE_VARS_EMPTY_GROUP: {group_name}")
        variables: list[TemplateVariableDefinition] = []
        for idx, item in enumerate(variables_raw):
            if not isinstance(item, dict):
                raise RuntimeError(f"E_TEMPLATE_VARS_INVALID_VARIABLE: group={group_name} index={idx}")
            path = str(item.get("path") or "").strip()
            description = str(item.get("description") or "").strip()
            example_raw = item.get("example")
            example = str(example_raw).strip() if example_raw is not None else None
            if not path or not description:
                raise RuntimeError(f"E_TEMPLATE_VARS_MISSING_FIELDS: group={group_name} index={idx}")
            variables.append(
                TemplateVariableDefinition(
                    path=path,
                    description=description,
                    example=example or None,
                )
            )
        applies_raw = group_value.get("applies_to_fields")
        applies_to_fields: list[str] = []
        if isinstance(applies_raw, list):
            for item in applies_raw:
                value = str(item).strip()
                if value:
                    applies_to_fields.append(value)
        groups[group_name] = TemplateVariableGroup(
            title=title,
            variables=tuple(variables),
            applies_to_fields=tuple(applies_to_fields),
        )

    _CACHED_GROUPS = groups
    return groups


def get_template_variable_group(group_name: str) -> TemplateVariableGroup:
    groups = _load_registry_groups()
    group = groups.get(group_name)
    if group is None:
        raise RuntimeError(f"E_TEMPLATE_VARS_GROUP_NOT_FOUND: {group_name}")
    return group


def list_template_variable_paths(group_name: str) -> tuple[str, ...]:
    group = get_template_variable_group(group_name)
    return tuple(item.path for item in group.variables)


def format_template_variable_macros(group_name: str) -> tuple[str, ...]:
    return tuple(f"{{{{{path}}}}}" for path in list_template_variable_paths(group_name))
