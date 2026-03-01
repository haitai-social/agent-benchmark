import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { dbQuery } from "@/lib/db";
import { formatDateTime } from "@/lib/datetime";
import { PaginationControls } from "@/app/components/pagination-controls";
import { BulkSelectionControls } from "@/app/components/bulk-selection-controls";
import { clampPage, getOffset, parsePage, parsePageSize } from "@/lib/pagination";
import { parseSelectedIds } from "@/lib/form-ids";
import { requireUser } from "@/lib/supabase-auth";
import {
  formatTemplateVariableDetailLines,
  formatTemplateVariableList,
  getTemplateVariableGroup,
} from "@/lib/template-vars";
import { AgentIcon, FilterIcon, PlusIcon, SearchIcon } from "../components/icons";
import { SubmitButton } from "../components/submit-button";
import { TextareaWithFileUpload } from "../components/textarea-with-file-upload";

const runtimeSpecDefaults = {
  runtime_type: "agno_docker",
  agent_image: "ghcr.io/example/agno-agent@sha256:replace-me",
  agent_command: "",
  sandbox: { timeout_seconds: 180 },
  services: [],
  scorers: [{ scorer_key: "task_success" }],
  sandbox_start_command: "",
  case_exec_command: "python /workspace/main.py",
  after_exec_command: "",
};

type RuntimeSpec = {
  runtime_type?: string;
  agent_image?: string;
  sandbox_start_command?: string;
  case_exec_command?: string;
  after_exec_command?: string;
  services?: unknown[];
  scorers?: unknown[];
  [key: string]: unknown;
};

function parseRuntimeSpec(value: unknown): RuntimeSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as RuntimeSpec;
}

const RUNTIME_CORE_KEYS = [
  "agent_image",
  "sandbox_start_command",
  "case_exec_command",
  "after_exec_command",
] as const;

type RuntimeCoreField = (typeof RUNTIME_CORE_KEYS)[number];

type RuntimeCoreFields = {
  agentImage: string;
  sandboxStartCommand: string;
  caseExecCommand: string;
  afterExecCommand: string;
};

function splitRuntimeSpec(runtimeSpec: RuntimeSpec | null): { core: RuntimeCoreFields; additional: Record<string, unknown> } {
  const parsed = parseRuntimeSpec(runtimeSpec ?? {});
  const additional: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if ((RUNTIME_CORE_KEYS as readonly string[]).includes(key)) continue;
    additional[key] = value;
  }
  return {
    core: {
      agentImage: String(parsed.agent_image ?? runtimeSpecDefaults.agent_image).trim(),
      sandboxStartCommand: String(parsed.sandbox_start_command ?? "").trim(),
      caseExecCommand: String(parsed.case_exec_command ?? runtimeSpecDefaults.case_exec_command).trim(),
      afterExecCommand: String(parsed.after_exec_command ?? "").trim(),
    },
    additional: Object.keys(additional).length > 0 ? additional : {
      runtime_type: runtimeSpecDefaults.runtime_type,
      agent_command: runtimeSpecDefaults.agent_command,
      sandbox: runtimeSpecDefaults.sandbox,
      services: runtimeSpecDefaults.services,
      scorers: runtimeSpecDefaults.scorers,
    },
  };
}

function parseAdditionalRuntimeSpec(raw: string): Record<string, unknown> {
  const value = raw.trim();
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("E_ADDITIONAL_RUNTIME_SPEC_OBJECT_REQUIRED");
  }
  return parsed as Record<string, unknown>;
}

function hasCoreRuntimeKeys(runtimeSpec: Record<string, unknown>): boolean {
  return RUNTIME_CORE_KEYS.some((key) => key in runtimeSpec);
}

function buildRuntimeSpec(core: RuntimeCoreFields, additional: Record<string, unknown>): Record<string, unknown> {
  const nextAdditional = { ...additional };
  for (const key of RUNTIME_CORE_KEYS) {
    if (key in nextAdditional) {
      delete nextAdditional[key];
    }
  }
  return {
    ...nextAdditional,
    agent_image: core.agentImage,
    sandbox_start_command: core.sandboxStartCommand,
    case_exec_command: core.caseExecCommand,
    after_exec_command: core.afterExecCommand,
  };
}

function buildListHref(q: string, keyLike: string, page: number, pageSize: number) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (keyLike) params.set("keyLike", keyLike);
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 10) params.set("pageSize", String(pageSize));
  return params.size > 0 ? `/agents?${params.toString()}` : "/agents";
}

function buildErrorHref(q: string, keyLike: string, page: number, pageSize: number, errorMessage: string) {
  const base = buildListHref(q, keyLike, page, pageSize);
  const joiner = base.includes("?") ? "&" : "?";
  return `${base}${joiner}error=${encodeURIComponent(errorMessage)}`;
}

async function createAgent(formData: FormData) {
  "use server";
  const user = await requireUser();

  const agentKey = String(formData.get("agentKey") ?? "").trim();
  const version = String(formData.get("version") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const agentImage = String(formData.get("agentImage") ?? "").trim();
  const sandboxStartCommand = String(formData.get("sandboxStartCommand") ?? "").trim();
  const caseExecCommand = String(formData.get("caseExecCommand") ?? "").trim();
  const afterExecCommand = String(formData.get("afterExecCommand") ?? "").trim();
  const additionalRuntimeSpecRaw = String(formData.get("additionalRuntimeSpec") ?? "{}");
  const q = String(formData.get("q") ?? "").trim();
  const keyLike = String(formData.get("keyLike") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));

  let additionalRuntimeSpec: Record<string, unknown>;
  try {
    additionalRuntimeSpec = parseAdditionalRuntimeSpec(additionalRuntimeSpecRaw);
  } catch {
    redirect(buildErrorHref(q, keyLike, page, pageSize, "Additional Runtime Spec 必须是合法 JSON 对象"));
  }
  if (hasCoreRuntimeKeys(additionalRuntimeSpec)) {
    redirect(buildErrorHref(q, keyLike, page, pageSize, "Additional Runtime Spec 不能包含核心字段（agent_image/sandbox_start_command/case_exec_command/after_exec_command）"));
  }
  const runtimeSpec = buildRuntimeSpec(
    {
      agentImage,
      sandboxStartCommand,
      caseExecCommand,
      afterExecCommand,
    },
    additionalRuntimeSpec,
  );
  if (!agentKey || !version || !name || !agentImage || !caseExecCommand) {
    redirect(buildErrorHref(q, keyLike, page, pageSize, "请填写 name/agentKey/version/agent_image/case_exec_command"));
  }

  await dbQuery(
    `INSERT INTO agents (agent_key, version, name, description, docker_image, openapi_spec, metadata, runtime_spec_json, created_by, updated_by, updated_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $9, CURRENT_TIMESTAMP
     WHERE NOT EXISTS (SELECT 1 FROM agents WHERE agent_key = $10 AND version = $11 AND deleted_at IS NULL)`,
    [
      agentKey,
      version,
      name,
      description,
      agentImage,
      JSON.stringify({}),
      JSON.stringify({}),
      JSON.stringify(runtimeSpec),
      user.id,
      agentKey,
      version
    ]
  );

  revalidatePath("/agents");
  redirect(buildListHref(q, keyLike, page, pageSize));
}

async function updateAgent(formData: FormData) {
  "use server";
  const user = await requireUser();

  const idRaw = String(formData.get("id") ?? "").trim();
  const id = Number(idRaw);
  const agentKey = String(formData.get("agentKey") ?? "").trim();
  const version = String(formData.get("version") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const agentImage = String(formData.get("agentImage") ?? "").trim();
  const sandboxStartCommand = String(formData.get("sandboxStartCommand") ?? "").trim();
  const caseExecCommand = String(formData.get("caseExecCommand") ?? "").trim();
  const afterExecCommand = String(formData.get("afterExecCommand") ?? "").trim();
  const additionalRuntimeSpecRaw = String(formData.get("additionalRuntimeSpec") ?? "{}");
  const q = String(formData.get("q") ?? "").trim();
  const keyLike = String(formData.get("keyLike") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));

  let additionalRuntimeSpec: Record<string, unknown>;
  try {
    additionalRuntimeSpec = parseAdditionalRuntimeSpec(additionalRuntimeSpecRaw);
  } catch {
    redirect(buildErrorHref(q, keyLike, page, pageSize, "Additional Runtime Spec 必须是合法 JSON 对象"));
  }
  if (hasCoreRuntimeKeys(additionalRuntimeSpec)) {
    redirect(buildErrorHref(q, keyLike, page, pageSize, "Additional Runtime Spec 不能包含核心字段（agent_image/sandbox_start_command/case_exec_command/after_exec_command）"));
  }
  const runtimeSpec = buildRuntimeSpec(
    {
      agentImage,
      sandboxStartCommand,
      caseExecCommand,
      afterExecCommand,
    },
    additionalRuntimeSpec,
  );
  if (!idRaw || !Number.isInteger(id) || id <= 0 || !agentKey || !version || !name || !agentImage || !caseExecCommand) {
    redirect(buildErrorHref(q, keyLike, page, pageSize, "更新失败：请填写完整字段（含 agent_image/case_exec_command）"));
  }

  await dbQuery(
    `UPDATE agents
     SET agent_key = $2,
         version = $3,
         name = $4,
         description = $5,
         docker_image = $6,
         runtime_spec_json = $7,
         updated_by = $8,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND deleted_at IS NULL`,
    [id, agentKey, version, name, description, agentImage, JSON.stringify(runtimeSpec), user.id]
  );

  revalidatePath("/agents");
  redirect(buildListHref(q, keyLike, page, pageSize));
}

async function deleteAgent(formData: FormData) {
  "use server";
  const user = await requireUser();

  const idRaw = String(formData.get("id") ?? "").trim();
  const id = Number(idRaw);
  const q = String(formData.get("q") ?? "").trim();
  const keyLike = String(formData.get("keyLike") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));
  if (!idRaw || !Number.isInteger(id) || id <= 0) return;

  await softDeleteAgentById(id, user.id);
  revalidatePath("/agents");
  revalidatePath("/experiments");
  redirect(buildListHref(q, keyLike, page, pageSize));
}

async function softDeleteAgentById(id: number, userId: string) {
  await dbQuery(
    `UPDATE agents
     SET is_deleted = TRUE,
         deleted_at = CURRENT_TIMESTAMP,
         updated_by = $2,
         updated_at = CURRENT_TIMESTAMP,
         version = CONCAT(version, '__deleted__', id)
     WHERE id = $1 AND deleted_at IS NULL`,
    [id, userId]
  );
  await dbQuery(
    `UPDATE experiments
     SET is_deleted = TRUE,
         deleted_at = CURRENT_TIMESTAMP,
         updated_by = $2,
     updated_at = CURRENT_TIMESTAMP
     WHERE agent_id = $1 AND deleted_at IS NULL`,
    [id, userId]
  );
}

async function bulkDeleteAgent(formData: FormData) {
  "use server";
  const user = await requireUser();

  const ids = parseSelectedIds(formData);
  const q = String(formData.get("q") ?? "").trim();
  const keyLike = String(formData.get("keyLike") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));
  if (ids.length <= 0) return;

  for (const id of ids) {
    await softDeleteAgentById(id, user.id);
  }
  revalidatePath("/agents");
  revalidatePath("/experiments");
  redirect(buildListHref(q, keyLike, page, pageSize));
}

export default async function AgentsPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; keyLike?: string; panel?: string; id?: string; error?: string; page?: string; pageSize?: string }>;
}) {
  await requireUser();
  const runtimeCommandVars = await getTemplateVariableGroup("agent_runtime_commands");
  const runtimeCommandMacroList = formatTemplateVariableList(runtimeCommandVars.variables);
  const runtimeCommandDetailLines = formatTemplateVariableDetailLines(runtimeCommandVars.variables);

  const { q = "", keyLike = "", panel = "none", id = "", error = "", page: pageRaw, pageSize: pageSizeRaw } = await searchParams;
  const filters = { q: q.trim(), keyLike: keyLike.trim() };
  const pageSize = parsePageSize(pageSizeRaw);
  const requestedPage = parsePage(pageRaw);
  const creating = panel === "create";
  const filtering = panel === "filter";
  const parsedId = id.trim() ? Number(id.trim()) : 0;
  const editingId = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : 0;

  const filterParams = [filters.q, filters.q, filters.q, filters.q, filters.keyLike, filters.keyLike];
  const [countResult, editing] = await Promise.all([
    dbQuery<{ total_count: number | string }>(
      `SELECT COUNT(*) AS total_count
       FROM agents
       WHERE ($1 = '' OR LOWER(name) LIKE CONCAT('%', LOWER($2), '%') OR LOWER(agent_key) LIKE CONCAT('%', LOWER($3), '%') OR LOWER(version) LIKE CONCAT('%', LOWER($4), '%'))
         AND deleted_at IS NULL
         AND ($5 = '' OR LOWER(agent_key) LIKE CONCAT('%', LOWER($6), '%'))`,
      filterParams
    ),
    editingId
      ? dbQuery<{
          id: number;
          agent_key: string;
          version: string;
          name: string;
          description: string;
          runtime_spec_json: RuntimeSpec | null;
          updated_at: string;
        }>(
          `SELECT id, agent_key, version, name, description, runtime_spec_json, updated_at
           FROM agents
           WHERE id = $1 AND deleted_at IS NULL
           LIMIT 1`,
          [editingId]
        )
      : Promise.resolve({ rows: [], rowCount: 0 } as { rows: Array<{ id: number; agent_key: string; version: string; name: string; description: string; runtime_spec_json: RuntimeSpec | null; updated_at: string }>; rowCount: number })
  ]);
  const total = Number(countResult.rows[0]?.total_count ?? 0);
  const page = clampPage(requestedPage, total, pageSize);
  const offset = getOffset(page, pageSize);
  const rowsResult = await dbQuery<{
    id: number;
    agent_key: string;
    version: string;
    name: string;
    description: string;
    runtime_spec_json: RuntimeSpec | null;
    updated_at: string;
  }>(
    `SELECT id, agent_key, version, name, description, runtime_spec_json, updated_at
     FROM agents
     WHERE ($1 = '' OR LOWER(name) LIKE CONCAT('%', LOWER($2), '%') OR LOWER(agent_key) LIKE CONCAT('%', LOWER($3), '%') OR LOWER(version) LIKE CONCAT('%', LOWER($4), '%'))
       AND deleted_at IS NULL
       AND ($5 = '' OR LOWER(agent_key) LIKE CONCAT('%', LOWER($6), '%'))
     ORDER BY updated_at DESC
     LIMIT $7 OFFSET $8`,
    [...filterParams, pageSize, offset]
  );
  const rows = rowsResult.rows;

  const listHref = buildListHref(filters.q, filters.keyLike, page, pageSize);
  const createHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=create`;
  const filterHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=filter`;
  const hasFilter = !!filters.keyLike;
  const editingRow = editing.rowCount > 0 ? editing.rows[0] : undefined;
  const runtimeSplit = splitRuntimeSpec(editingRow?.runtime_spec_json ?? null);
  const paginationQuery = { q: filters.q, keyLike: filters.keyLike };
  const resetHref = buildListHref(filters.q, "", 1, pageSize);
  const showDrawer = creating || Boolean(editingRow);
  const bulkDeleteFormId = "agent-bulk-delete-form";

  return (
    <div className="grid">
      <section className="page-hero">
        <div className="breadcrumb">评测 &nbsp;/&nbsp; Agents</div>
        <h1>Agents</h1>
      </section>

      <section className="toolbar-row">
        <form action="/agents" className="search-form">
          <input type="hidden" name="keyLike" value={filters.keyLike} />
          <input type="hidden" name="pageSize" value={pageSize} />
          <label className="input-icon-wrap">
            <SearchIcon width={16} height={16} />
            <input name="q" defaultValue={filters.q} placeholder="搜索名称 / key / version" />
          </label>
          <button type="submit" className="ghost-btn">
            搜索
          </button>
        </form>

        <div className="action-group">
          <Link href={filterHref} className="ghost-btn">
            <FilterIcon width={16} height={16} /> 筛选
          </Link>
          <BulkSelectionControls formId={bulkDeleteFormId} variant="compact" confirmText="确认批量删除已选 {count} 条 Agent 吗？" />
          <PaginationControls basePath="/agents" query={paginationQuery} total={total} page={page} pageSize={pageSize} position="top" variant="compact" />
        </div>
      </section>

      {hasFilter ? (
        <section className="active-filters">
          <span className="muted">当前筛选:</span>
          {filters.keyLike ? <span className="filter-pill">{`Agent Key: ${filters.keyLike}`}</span> : null}
          <Link href={resetHref} className="text-btn">
            清空筛选
          </Link>
        </section>
      ) : null}
      {error ? (
        <section className="card">
          <div style={{ color: "#b42318", fontWeight: 600 }}>{error}</div>
        </section>
      ) : null}

      <section className="card table-card">
        <div className="section-title-row">
          <h2>
            <AgentIcon width={16} height={16} />
            Agents
          </h2>
          <Link href={createHref} className="primary-btn">
            <PlusIcon width={16} height={16} /> 新建 Agent
          </Link>
        </div>
        <form id={bulkDeleteFormId} action={bulkDeleteAgent}>
          <input type="hidden" name="q" value={filters.q} />
          <input type="hidden" name="keyLike" value={filters.keyLike} />
          <input type="hidden" name="page" value={page} />
          <input type="hidden" name="pageSize" value={pageSize} />
        </form>
        <table className="agents-table">
          <thead>
            <tr>
              <th className="bulk-select-cell">选</th>
              <th>ID</th>
              <th>名称</th>
              <th>Key</th>
              <th>Version</th>
              <th>Docker Image</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const runtime = parseRuntimeSpec(row.runtime_spec_json);
              return (
              <tr key={row.id}>
                <td className="bulk-select-cell">
                  <input type="checkbox" name="selectedIds" value={row.id} form={bulkDeleteFormId} aria-label={`选择 Agent ${row.id}`} />
                </td>
                <td><code>#{row.id}</code></td>
                <td>{row.name}</td>
                <td>
                  <code>{row.agent_key}</code>
                </td>
                <td>
                  <code>{row.version}</code>
                </td>
                <td className="agent-docker-cell">
                  <code>{runtime.agent_image ?? "-"}</code>
                </td>
                <td>{formatDateTime(row.updated_at)}</td>
                <td>
                  <div className="row-actions">
                    <Link
                      href={
                        listHref.includes("?")
                          ? `${listHref}&id=${row.id}`
                          : `/agents?id=${row.id}`
                      }
                      className="text-btn"
                    >
                      更新
                    </Link>
                    <form action={deleteAgent}>
                      <input type="hidden" name="id" value={row.id} />
                      <input type="hidden" name="q" value={filters.q} />
                      <input type="hidden" name="keyLike" value={filters.keyLike} />
                      <input type="hidden" name="page" value={page} />
                      <input type="hidden" name="pageSize" value={pageSize} />
                      <SubmitButton className="text-btn danger" pendingText="删除中...">
                        删除
                      </SubmitButton>
                    </form>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        <BulkSelectionControls formId={bulkDeleteFormId} variant="full" confirmText="确认批量删除已选 {count} 条 Agent 吗？" />
        <PaginationControls basePath="/agents" query={paginationQuery} total={total} page={page} pageSize={pageSize} position="bottom" />
      </section>

      {filtering ? (
        <div className="action-overlay">
          <Link href={listHref || "/agents"} className="action-overlay-dismiss" aria-label="关闭筛选" />
          <aside className="action-drawer">
            <div className="action-drawer-header">
              <h3>筛选 Agents</h3>
              <Link href={listHref || "/agents"} className="icon-btn" aria-label="关闭">
                <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
              </Link>
            </div>
            <div className="action-drawer-body">
              <form action="/agents" className="menu-form">
                <input type="hidden" name="q" value={filters.q} />
                <input type="hidden" name="panel" value="none" />
                <input type="hidden" name="pageSize" value={pageSize} />
                <label className="field-label">Agent Key 包含</label>
                <input name="keyLike" placeholder="例如 openclaw" defaultValue={filters.keyLike} />
                <SubmitButton pendingText="应用中...">应用筛选</SubmitButton>
                <Link href={resetHref} className="ghost-btn">
                  重置筛选
                </Link>
              </form>
            </div>
          </aside>
        </div>
      ) : null}

      {showDrawer ? (
        <div className="action-overlay">
          <Link href={listHref} className="action-overlay-dismiss" aria-label="关闭抽屉蒙层" />
          <aside className="action-drawer">
            <div className="action-drawer-header">
              <h3>{editingRow ? "Agent 详情" : "新建 Agent"}</h3>
              <Link href={listHref} className="icon-btn" aria-label="关闭">
                <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
              </Link>
            </div>
            <div className="action-drawer-body">
              <form
                id={editingRow ? `agent-form-${editingRow.id}` : "agent-form-create"}
                action={editingRow ? updateAgent : createAgent}
                className="menu-form form-tone-green"
              >
                {editingRow ? <input type="hidden" name="id" value={editingRow.id} /> : null}
                <input type="hidden" name="q" value={filters.q} />
                <input type="hidden" name="keyLike" value={filters.keyLike} />
                <input type="hidden" name="page" value={page} />
                <input type="hidden" name="pageSize" value={pageSize} />

                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title required">名称</span>
                    <span className="type-pill">String</span>
                  </label>
                  <input name="name" placeholder="Agent 名称" required defaultValue={editingRow?.name ?? ""} />
                </div>

                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title required">Agent Key</span>
                    <span className="type-pill">Unique</span>
                  </label>
                  <input name="agentKey" placeholder="例如 openclaw" required defaultValue={editingRow?.agent_key ?? ""} />
                </div>

                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title required">Version</span>
                    <span className="type-pill">SemVer</span>
                  </label>
                  <input name="version" placeholder="例如 v2026.02.26" required defaultValue={editingRow?.version ?? ""} />
                </div>

                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title">Description</span>
                    <span className="type-pill">Optional</span>
                  </label>
                  <TextareaWithFileUpload name="description" placeholder="描述" defaultValue={editingRow?.description ?? ""} accept=".txt,.md" />
                </div>

                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title required">agent_image</span>
                    <span className="type-pill">String</span>
                  </label>
                  <input
                    name="agentImage"
                    placeholder="例如 ghcr.io/example/agno-agent@sha256:replace-me"
                    required
                    defaultValue={runtimeSplit.core.agentImage}
                  />
                </div>

                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title field-title-with-help">
                      sandbox_start_command
                      <span className="field-help-icon" aria-label="可用模板变量" role="img" tabIndex={0}>
                        !
                        <span className="field-help-tooltip">
                          <strong>可用模板变量</strong>
                          <br />
                          {runtimeCommandDetailLines.map((line) => (
                            <span key={`sandbox-${line}`}>
                              {line}
                              <br />
                            </span>
                          ))}
                        </span>
                      </span>
                    </span>
                    <span className="type-pill">Command</span>
                  </label>
                  <TextareaWithFileUpload
                    name="sandboxStartCommand"
                    placeholder="容器启动命令（可选）"
                    accept=".txt,.sh"
                    hint={`可用变量：${runtimeCommandMacroList}`}
                    defaultValue={runtimeSplit.core.sandboxStartCommand}
                  />
                </div>

                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title required field-title-with-help">
                      case_exec_command
                      <span className="field-help-icon" aria-label="可用模板变量" role="img" tabIndex={0}>
                        !
                        <span className="field-help-tooltip">
                          <strong>可用模板变量</strong>
                          <br />
                          {runtimeCommandDetailLines.map((line) => (
                            <span key={`case-${line}`}>
                              {line}
                              <br />
                            </span>
                          ))}
                        </span>
                      </span>
                    </span>
                    <span className="type-pill">Command</span>
                  </label>
                  <TextareaWithFileUpload
                    name="caseExecCommand"
                    placeholder="Run Case 执行命令"
                    required
                    accept=".txt,.sh"
                    hint={`可用变量：${runtimeCommandMacroList}`}
                    defaultValue={runtimeSplit.core.caseExecCommand}
                  />
                </div>

                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title field-title-with-help">
                      after_exec_command
                      <span className="field-help-icon" aria-label="可用模板变量" role="img" tabIndex={0}>
                        !
                        <span className="field-help-tooltip">
                          <strong>可用模板变量</strong>
                          <br />
                          {runtimeCommandDetailLines.map((line) => (
                            <span key={`after-${line}`}>
                              {line}
                              <br />
                            </span>
                          ))}
                        </span>
                      </span>
                    </span>
                    <span className="type-pill">Command</span>
                  </label>
                  <TextareaWithFileUpload
                    name="afterExecCommand"
                    placeholder="Case 成功后的后置命令（可选）"
                    accept=".txt,.sh"
                    hint={`可用变量：${runtimeCommandMacroList}`}
                    defaultValue={runtimeSplit.core.afterExecCommand}
                  />
                </div>

                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title">Additional Runtime Spec (JSON)</span>
                    <span className="type-pill">JSON</span>
                  </label>
                  <TextareaWithFileUpload
                    name="additionalRuntimeSpec"
                    required
                    accept=".json,.yaml,.yml,.txt"
                    hint="除 agent_image/sandbox_start_command/case_exec_command/after_exec_command 外的全部 runtime 配置"
                    defaultValue={JSON.stringify(runtimeSplit.additional, null, 2)}
                  />
                </div>

              </form>
              <div className="drawer-actions">
                <SubmitButton
                  form={editingRow ? `agent-form-${editingRow.id}` : "agent-form-create"}
                  className="primary-btn"
                  pendingText={editingRow ? "更新中..." : "创建中..."}
                >
                  {editingRow ? "更新" : "创建"}
                </SubmitButton>
                {editingRow ? (
                  <form action={deleteAgent} className="drawer-inline-form">
                    <input type="hidden" name="id" value={editingRow.id} />
                    <input type="hidden" name="q" value={filters.q} />
                    <input type="hidden" name="keyLike" value={filters.keyLike} />
                    <input type="hidden" name="page" value={page} />
                    <input type="hidden" name="pageSize" value={pageSize} />
                    <SubmitButton type="submit" className="danger-btn" pendingText="删除中...">
                      删除
                    </SubmitButton>
                  </form>
                ) : null}
                <Link href={listHref} className="ghost-btn">
                  取消
                </Link>
              </div>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
