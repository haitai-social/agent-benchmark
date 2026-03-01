import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export type TemplateVariable = {
  path: string;
  description: string;
  example?: string;
};

export type TemplateVariableGroup = {
  title: string;
  variables: TemplateVariable[];
  applies_to_fields?: string[];
};

type TemplateRegistry = {
  version: number;
  groups: Record<string, TemplateVariableGroup>;
};

let cachedRegistry: TemplateRegistry | null = null;

function resolveRegistryPath(): string {
  const candidates = [
    path.resolve(process.cwd(), "..", "contracts", "template_variables.json"),
    path.resolve(process.cwd(), "contracts", "template_variables.json"),
  ];
  const found = candidates.find((item) => existsSync(item));
  if (!found) {
    throw new Error("E_TEMPLATE_VARS_FILE_NOT_FOUND");
  }
  return found;
}

function ensureVariable(raw: unknown, groupName: string, index: number): TemplateVariable {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`E_TEMPLATE_VARS_INVALID_VARIABLE: group=${groupName} index=${index}`);
  }
  const pathValue = String((raw as { path?: unknown }).path ?? "").trim();
  const descriptionValue = String((raw as { description?: unknown }).description ?? "").trim();
  const exampleValueRaw = (raw as { example?: unknown }).example;
  const exampleValue = exampleValueRaw == null ? "" : String(exampleValueRaw).trim();
  if (!pathValue || !descriptionValue) {
    throw new Error(`E_TEMPLATE_VARS_MISSING_FIELDS: group=${groupName} index=${index}`);
  }
  return {
    path: pathValue,
    description: descriptionValue,
    example: exampleValue || undefined,
  };
}

function ensureGroup(raw: unknown, groupName: string): TemplateVariableGroup {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`E_TEMPLATE_VARS_INVALID_GROUP: ${groupName}`);
  }
  const title = String((raw as { title?: unknown }).title ?? "").trim() || groupName;
  const variablesRaw = (raw as { variables?: unknown }).variables;
  if (!Array.isArray(variablesRaw) || variablesRaw.length <= 0) {
    throw new Error(`E_TEMPLATE_VARS_EMPTY_GROUP: ${groupName}`);
  }
  const variables = variablesRaw.map((item, idx) => ensureVariable(item, groupName, idx));
  const appliesToRaw = (raw as { applies_to_fields?: unknown }).applies_to_fields;
  const applies_to_fields = Array.isArray(appliesToRaw)
    ? appliesToRaw
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0)
    : undefined;
  return {
    title,
    variables,
    applies_to_fields,
  };
}

export async function loadTemplateRegistry(): Promise<TemplateRegistry> {
  if (cachedRegistry) return cachedRegistry;
  const filePath = resolveRegistryPath();
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw) as {
    version?: unknown;
    groups?: unknown;
  };
  const version = Number(parsed.version ?? 0);
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error(`E_TEMPLATE_VARS_INVALID_VERSION: ${String(parsed.version ?? "")}`);
  }
  if (!parsed.groups || typeof parsed.groups !== "object" || Array.isArray(parsed.groups)) {
    throw new Error("E_TEMPLATE_VARS_INVALID_GROUPS");
  }
  const groups: Record<string, TemplateVariableGroup> = {};
  for (const [name, value] of Object.entries(parsed.groups as Record<string, unknown>)) {
    groups[name] = ensureGroup(value, name);
  }
  cachedRegistry = { version, groups };
  return cachedRegistry;
}

export async function getTemplateVariableGroup(groupName: string): Promise<TemplateVariableGroup> {
  const registry = await loadTemplateRegistry();
  const group = registry.groups[groupName];
  if (!group) {
    throw new Error(`E_TEMPLATE_VARS_GROUP_NOT_FOUND: ${groupName}`);
  }
  return group;
}

export function formatTemplateVariableMacro(variablePath: string): string {
  return `{{${variablePath}}}`;
}

export function formatTemplateVariableList(variables: TemplateVariable[]): string {
  return variables.map((item) => formatTemplateVariableMacro(item.path)).join("、");
}

export function formatTemplateVariableDetailLines(variables: TemplateVariable[]): string[] {
  return variables.map((item) => {
    const macro = formatTemplateVariableMacro(item.path);
    if (item.example) {
      return `${macro}: ${item.description}（示例: ${item.example}）`;
    }
    return `${macro}: ${item.description}`;
  });
}
