import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { dbQuery } from "@/lib/db";
import { PaginationControls } from "@/app/components/pagination-controls";
import { BulkSelectionControls } from "@/app/components/bulk-selection-controls";
import { clampPage, getOffset, parsePage, parsePageSize } from "@/lib/pagination";
import { parseSelectedIds } from "@/lib/form-ids";
import { requireUser } from "@/lib/supabase-auth";
import { AgentIcon, FilterIcon, PlusIcon, SearchIcon } from "../components/icons";
import { SubmitButton } from "../components/submit-button";
import { TextareaWithFileUpload } from "../components/textarea-with-file-upload";

const defaultRuntimeSpec = {
  runtime_type: "agno_docker",
  agent_image: "ghcr.io/example/agno-agent@sha256:replace-me",
  agent_command: "",
  agent_env_template: {},
  sandbox: { timeout_seconds: 180 },
  services: [],
  scorers: [{ scorer_key: "task_success" }]
};

type RuntimeSpec = {
  runtime_type?: string;
  agent_image?: string;
  services?: unknown[];
  scorers?: unknown[];
};

function parseRuntimeSpec(value: unknown): RuntimeSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as RuntimeSpec;
}

function buildListHref(q: string, status: string, keyLike: string, page: number, pageSize: number) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (status !== "all") params.set("status", status);
  if (keyLike) params.set("keyLike", keyLike);
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 10) params.set("pageSize", String(pageSize));
  return params.size > 0 ? `/agents?${params.toString()}` : "/agents";
}

function buildErrorHref(q: string, status: string, keyLike: string, page: number, pageSize: number, errorMessage: string) {
  const base = buildListHref(q, status, keyLike, page, pageSize);
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
  const runtimeSpecRaw = String(formData.get("runtimeSpec") ?? "{}");
  const q = String(formData.get("q") ?? "").trim();
  const status = String(formData.get("statusFilter") ?? "all").trim() || "all";
  const keyLike = String(formData.get("keyLike") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));

  let runtimeSpec: Record<string, unknown>;
  try {
    runtimeSpec = JSON.parse(runtimeSpecRaw) as Record<string, unknown>;
  } catch {
    redirect(buildErrorHref(q, status, keyLike, page, pageSize, "Runtime Spec 必须是合法 JSON"));
  }
  if (!runtimeSpec || typeof runtimeSpec !== "object" || Array.isArray(runtimeSpec)) {
    redirect(buildErrorHref(q, status, keyLike, page, pageSize, "Runtime Spec 必须是 JSON 对象"));
  }
  const dockerImage = String(runtimeSpec.agent_image ?? "").trim();
  if (!agentKey || !version || !name || !dockerImage) {
    redirect(buildErrorHref(q, status, keyLike, page, pageSize, "请填写 name/agentKey/version，且 Runtime Spec 必须包含 agent_image"));
  }

  await dbQuery(
    `INSERT INTO agents (agent_key, version, name, description, docker_image, openapi_spec, status, metadata, runtime_spec_json, created_by, updated_by, updated_at)
     SELECT $1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $9, CURRENT_TIMESTAMP
     WHERE NOT EXISTS (SELECT 1 FROM agents WHERE agent_key = $10 AND version = $11 AND deleted_at IS NULL)`,
    [
      agentKey,
      version,
      name,
      description,
      dockerImage,
      JSON.stringify({}),
      JSON.stringify({}),
      JSON.stringify(runtimeSpec),
      user.id,
      agentKey,
      version
    ]
  );

  revalidatePath("/agents");
  redirect(buildListHref(q, status, keyLike, page, pageSize));
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
  const runtimeSpecRaw = String(formData.get("runtimeSpec") ?? "{}");
  const statusValue = String(formData.get("status") ?? "active").trim();
  const q = String(formData.get("q") ?? "").trim();
  const statusFilter = String(formData.get("statusFilter") ?? "all").trim() || "all";
  const keyLike = String(formData.get("keyLike") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));

  let runtimeSpec: Record<string, unknown>;
  try {
    runtimeSpec = JSON.parse(runtimeSpecRaw) as Record<string, unknown>;
  } catch {
    redirect(buildErrorHref(q, statusFilter, keyLike, page, pageSize, "Runtime Spec 必须是合法 JSON"));
  }
  if (!runtimeSpec || typeof runtimeSpec !== "object" || Array.isArray(runtimeSpec)) {
    redirect(buildErrorHref(q, statusFilter, keyLike, page, pageSize, "Runtime Spec 必须是 JSON 对象"));
  }
  const dockerImage = String(runtimeSpec.agent_image ?? "").trim();
  if (!idRaw || !Number.isInteger(id) || id <= 0 || !agentKey || !version || !name || !dockerImage) {
    redirect(buildErrorHref(q, statusFilter, keyLike, page, pageSize, "更新失败：请填写完整字段，且 Runtime Spec 必须包含 agent_image"));
  }

  await dbQuery(
    `UPDATE agents
     SET agent_key = $2,
         version = $3,
         name = $4,
         description = $5,
         docker_image = $6,
         runtime_spec_json = $7,
         status = $8,
         updated_by = $9,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND deleted_at IS NULL`,
    [id, agentKey, version, name, description, dockerImage, JSON.stringify(runtimeSpec), statusValue || "active", user.id]
  );

  revalidatePath("/agents");
  redirect(buildListHref(q, statusFilter, keyLike, page, pageSize));
}

async function deleteAgent(formData: FormData) {
  "use server";
  const user = await requireUser();

  const idRaw = String(formData.get("id") ?? "").trim();
  const id = Number(idRaw);
  const q = String(formData.get("q") ?? "").trim();
  const status = String(formData.get("statusFilter") ?? "all").trim() || "all";
  const keyLike = String(formData.get("keyLike") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));
  if (!idRaw || !Number.isInteger(id) || id <= 0) return;

  await softDeleteAgentById(id, user.id);
  revalidatePath("/agents");
  revalidatePath("/experiments");
  redirect(buildListHref(q, status, keyLike, page, pageSize));
}

async function softDeleteAgentById(id: number, userId: string) {
  await dbQuery(
    `UPDATE agents
     SET is_deleted = TRUE,
         deleted_at = CURRENT_TIMESTAMP,
         updated_by = $2,
         updated_at = CURRENT_TIMESTAMP,
         status = 'archived',
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
  const status = String(formData.get("statusFilter") ?? "all").trim() || "all";
  const keyLike = String(formData.get("keyLike") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));
  if (ids.length <= 0) return;

  for (const id of ids) {
    await softDeleteAgentById(id, user.id);
  }
  revalidatePath("/agents");
  revalidatePath("/experiments");
  redirect(buildListHref(q, status, keyLike, page, pageSize));
}

export default async function AgentsPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; status?: string; keyLike?: string; panel?: string; id?: string; error?: string; page?: string; pageSize?: string }>;
}) {
  await requireUser();

  const { q = "", status = "all", keyLike = "", panel = "none", id = "", error = "", page: pageRaw, pageSize: pageSizeRaw } = await searchParams;
  const filters = { q: q.trim(), status: status.trim() || "all", keyLike: keyLike.trim() };
  const pageSize = parsePageSize(pageSizeRaw);
  const requestedPage = parsePage(pageRaw);
  const creating = panel === "create";
  const filtering = panel === "filter";
  const parsedId = id.trim() ? Number(id.trim()) : 0;
  const editingId = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : 0;

  const filterParams = [filters.q, filters.q, filters.q, filters.q, filters.keyLike, filters.keyLike, filters.status, filters.status];
  const [countResult, editing] = await Promise.all([
    dbQuery<{ total_count: number | string }>(
      `SELECT COUNT(*) AS total_count
       FROM agents
       WHERE ($1 = '' OR LOWER(name) LIKE CONCAT('%', LOWER($2), '%') OR LOWER(agent_key) LIKE CONCAT('%', LOWER($3), '%') OR LOWER(version) LIKE CONCAT('%', LOWER($4), '%'))
         AND deleted_at IS NULL
         AND ($5 = '' OR LOWER(agent_key) LIKE CONCAT('%', LOWER($6), '%'))
         AND ($7 = 'all' OR status = $8)`,
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
          status: string;
          updated_at: string;
        }>(
          `SELECT id, agent_key, version, name, description, runtime_spec_json, status, updated_at
           FROM agents
           WHERE id = $1 AND deleted_at IS NULL
           LIMIT 1`,
          [editingId]
        )
      : Promise.resolve({ rows: [], rowCount: 0 } as { rows: Array<{ id: number; agent_key: string; version: string; name: string; description: string; runtime_spec_json: RuntimeSpec | null; status: string; updated_at: string }>; rowCount: number })
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
    status: string;
    updated_at: string;
  }>(
    `SELECT id, agent_key, version, name, description, runtime_spec_json, status, updated_at
     FROM agents
     WHERE ($1 = '' OR LOWER(name) LIKE CONCAT('%', LOWER($2), '%') OR LOWER(agent_key) LIKE CONCAT('%', LOWER($3), '%') OR LOWER(version) LIKE CONCAT('%', LOWER($4), '%'))
       AND deleted_at IS NULL
       AND ($5 = '' OR LOWER(agent_key) LIKE CONCAT('%', LOWER($6), '%'))
       AND ($7 = 'all' OR status = $8)
     ORDER BY updated_at DESC
     LIMIT $9 OFFSET $10`,
    [...filterParams, pageSize, offset]
  );
  const rows = rowsResult.rows;

  const listHref = buildListHref(filters.q, filters.status, filters.keyLike, page, pageSize);
  const createHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=create`;
  const filterHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=filter`;
  const hasFilter = filters.status !== "all" || !!filters.keyLike;
  const editingRow = editing.rowCount > 0 ? editing.rows[0] : undefined;
  const paginationQuery = { q: filters.q, status: filters.status === "all" ? "" : filters.status, keyLike: filters.keyLike };
  const resetHref = buildListHref(filters.q, "all", "", 1, pageSize);
  const showDrawer = creating || Boolean(editingRow);
  const bulkDeleteFormId = "agent-bulk-delete-form";

  return (
    <div className="grid">
      <section className="page-hero">
        <div className="breadcrumb">评测 &nbsp;/&nbsp; Agents</div>
        <h1>Agents</h1>
        <p className="muted">管理 Agent 实体与版本（agent_key + version）。</p>
      </section>

      <section className="toolbar-row">
        <form action="/agents" className="search-form">
          <input type="hidden" name="status" value={filters.status} />
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
          {filters.status !== "all" ? <span className="filter-pill">{`状态: ${filters.status}`}</span> : null}
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
          <input type="hidden" name="statusFilter" value={filters.status} />
          <input type="hidden" name="keyLike" value={filters.keyLike} />
          <input type="hidden" name="page" value={page} />
          <input type="hidden" name="pageSize" value={pageSize} />
        </form>
        <table>
          <thead>
            <tr>
              <th className="bulk-select-cell">选</th>
              <th>名称</th>
              <th>Key / Version</th>
              <th>Runtime</th>
              <th>Status</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const runtime = parseRuntimeSpec(row.runtime_spec_json);
              const servicesCount = Array.isArray(runtime.services) ? runtime.services.length : 0;
              const scorersCount = Array.isArray(runtime.scorers) ? runtime.scorers.length : 0;
              return (
              <tr key={row.id}>
                <td className="bulk-select-cell">
                  <input type="checkbox" name="selectedIds" value={row.id} form={bulkDeleteFormId} aria-label={`选择 Agent ${row.id}`} />
                </td>
                <td>{row.name}</td>
                <td>
                  <div><code>{row.agent_key}</code></div>
                  <div className="muted"><code>{row.version}</code></div>
                </td>
                <td>
                  <div><code>{runtime.runtime_type ?? "-"}</code></div>
                  <div className="muted"><code>{runtime.agent_image ?? "-"}</code></div>
                  <div className="muted">{`services:${servicesCount} scorers:${scorersCount}`}</div>
                </td>
                <td>
                  <span className={`status-pill ${row.status}`}>{row.status}</span>
                </td>
                <td>{new Date(row.updated_at).toLocaleString()}</td>
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
                      <input type="hidden" name="statusFilter" value={filters.status} />
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
                <label className="field-label">状态</label>
                <div className="chip-row">
                  {[
                    { value: "all", label: "全部" },
                    { value: "active", label: "active" },
                    { value: "archived", label: "archived" }
                  ].map((item) => (
                    <label key={item.value} className="chip">
                      <input type="radio" name="status" value={item.value} defaultChecked={filters.status === item.value} />
                      {item.label}
                    </label>
                  ))}
                </div>
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
                <input type="hidden" name="statusFilter" value={filters.status} />
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
                    <span className="field-title">Status</span>
                    <span className="type-pill">Enum</span>
                  </label>
                  <div className="chip-row">
                    {["active", "archived"].map((item) => (
                      <label key={item} className="chip">
                        <input type="radio" name="status" value={item} defaultChecked={(editingRow?.status ?? "active") === item} />
                        {item}
                      </label>
                    ))}
                  </div>
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
                    <span className="field-title required">Runtime Spec (JSON)</span>
                    <span className="type-pill">JSON</span>
                  </label>
                  <TextareaWithFileUpload
                    name="runtimeSpec"
                    required
                    accept=".json,.yaml,.yml,.txt"
                    hint="统一运行配置（runtime_type / agent_image / sandbox / services / scorers）"
                    defaultValue={
                      editingRow?.runtime_spec_json
                        ? JSON.stringify(editingRow.runtime_spec_json, null, 2)
                        : JSON.stringify(defaultRuntimeSpec, null, 2)
                    }
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
                    <input type="hidden" name="statusFilter" value={filters.status} />
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
