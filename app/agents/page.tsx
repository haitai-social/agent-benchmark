import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { dbQuery } from "@/lib/db";
import { parseJsonOrWrap } from "@/lib/safe-json";
import { requireUser } from "@/lib/supabase-auth";
import { AgentIcon, FilterIcon, PlusIcon, SearchIcon } from "../components/icons";
import { SubmitButton } from "../components/submit-button";

const defaultOpenApiSpec = {
  openapi: "3.1.0",
  info: { title: "Agent Runtime API", version: "1.0.0" },
  paths: {
    "/run": {
      post: {
        "x-benchmark-operation": "run",
        summary: "Run agent with session + input",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["session_jsonl", "user_input"],
                properties: {
                  session_jsonl: { type: "string" },
                  user_input: { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          "200": {
            description: "trajectory and output",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["trajectory", "output"],
                  properties: {
                    trajectory: {},
                    output: {}
                  }
                }
              }
            }
          }
        }
      }
    }
  }
};

function buildListHref(q: string, status: string, keyLike: string) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (status !== "all") params.set("status", status);
  if (keyLike) params.set("keyLike", keyLike);
  return params.size > 0 ? `/agents?${params.toString()}` : "/agents";
}

async function createAgent(formData: FormData) {
  "use server";
  const user = await requireUser();

  const agentKey = String(formData.get("agentKey") ?? "").trim();
  const version = String(formData.get("version") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const dockerImage = String(formData.get("dockerImage") ?? "").trim();
  const openapiSpecRaw = String(formData.get("openapiSpec") ?? "{}");
  const metadataRaw = String(formData.get("metadata") ?? "{}");
  const q = String(formData.get("q") ?? "").trim();
  const status = String(formData.get("statusFilter") ?? "all").trim() || "all";
  const keyLike = String(formData.get("keyLike") ?? "").trim();

  if (!agentKey || !version || !name || !dockerImage) return;

  await dbQuery(
    `INSERT INTO agents (agent_key, version, name, description, docker_image, openapi_spec, status, metadata, created_by, updated_by, updated_at)
     SELECT $1, $2, $3, $4, $5, $6, 'active', $7, $8, $8, CURRENT_TIMESTAMP
     WHERE NOT EXISTS (SELECT 1 FROM agents WHERE agent_key = $9 AND version = $10)`,
    [
      agentKey,
      version,
      name,
      description,
      dockerImage,
      JSON.stringify(parseJsonOrWrap(openapiSpecRaw)),
      JSON.stringify(parseJsonOrWrap(metadataRaw)),
      user.id,
      agentKey,
      version
    ]
  );

  revalidatePath("/agents");
  redirect(buildListHref(q, status, keyLike));
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
  const dockerImage = String(formData.get("dockerImage") ?? "").trim();
  const openapiSpecRaw = String(formData.get("openapiSpec") ?? "{}");
  const metadataRaw = String(formData.get("metadata") ?? "{}");
  const statusValue = String(formData.get("status") ?? "active").trim();
  const q = String(formData.get("q") ?? "").trim();
  const statusFilter = String(formData.get("statusFilter") ?? "all").trim() || "all";
  const keyLike = String(formData.get("keyLike") ?? "").trim();

  if (!idRaw || !Number.isInteger(id) || id <= 0 || !agentKey || !version || !name || !dockerImage) return;

  await dbQuery(
    `UPDATE agents
     SET agent_key = $2,
         version = $3,
         name = $4,
         description = $5,
         docker_image = $6,
         openapi_spec = $7,
         metadata = $8,
         status = $9,
         updated_by = $10,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      id,
      agentKey,
      version,
      name,
      description,
      dockerImage,
      JSON.stringify(parseJsonOrWrap(openapiSpecRaw)),
      JSON.stringify(parseJsonOrWrap(metadataRaw)),
      statusValue || "active",
      user.id
    ]
  );

  revalidatePath("/agents");
  redirect(buildListHref(q, statusFilter, keyLike));
}

async function deleteAgent(formData: FormData) {
  "use server";
  await requireUser();

  const idRaw = String(formData.get("id") ?? "").trim();
  const id = Number(idRaw);
  const q = String(formData.get("q") ?? "").trim();
  const status = String(formData.get("statusFilter") ?? "all").trim() || "all";
  const keyLike = String(formData.get("keyLike") ?? "").trim();
  if (!idRaw || !Number.isInteger(id) || id <= 0) return;

  await dbQuery(`DELETE FROM agents WHERE id = $1`, [id]);
  revalidatePath("/agents");
  redirect(buildListHref(q, status, keyLike));
}

export default async function AgentsPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; status?: string; keyLike?: string; panel?: string; id?: string }>;
}) {
  await requireUser();

  const { q = "", status = "all", keyLike = "", panel = "none", id = "" } = await searchParams;
  const filters = { q: q.trim(), status: status.trim() || "all", keyLike: keyLike.trim() };
  const creating = panel === "create";
  const filtering = panel === "filter";
  const parsedId = id.trim() ? Number(id.trim()) : 0;
  const editingId = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : 0;

  const rowsResult = await dbQuery<{
    id: number;
    agent_key: string;
    version: string;
    name: string;
    description: string;
    docker_image: string;
    openapi_spec: unknown;
    status: string;
    metadata: unknown;
    updated_at: string;
  }>(
    `SELECT id, agent_key, version, name, description, docker_image, openapi_spec, status, metadata, updated_at
     FROM agents
     WHERE ($1 = '' OR LOWER(name) LIKE CONCAT('%', LOWER($2), '%') OR LOWER(agent_key) LIKE CONCAT('%', LOWER($3), '%') OR LOWER(version) LIKE CONCAT('%', LOWER($4), '%'))
       AND ($5 = '' OR LOWER(agent_key) LIKE CONCAT('%', LOWER($6), '%'))
       AND ($7 = 'all' OR status = $8)
     ORDER BY updated_at DESC`,
    [filters.q, filters.q, filters.q, filters.q, filters.keyLike, filters.keyLike, filters.status, filters.status]
  );

  const rows = rowsResult.rows;

  const listHref = buildListHref(filters.q, filters.status, filters.keyLike);
  const createHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=create`;
  const filterHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=filter`;
  const hasFilter = filters.status !== "all" || !!filters.keyLike;
  const editing = editingId ? rows.find((row) => row.id === editingId) : undefined;
  const showDrawer = creating || Boolean(editing);

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
        </div>
      </section>

      {hasFilter ? (
        <section className="active-filters">
          <span className="muted">当前筛选:</span>
          {filters.status !== "all" ? <span className="filter-pill">{`状态: ${filters.status}`}</span> : null}
          {filters.keyLike ? <span className="filter-pill">{`Agent Key: ${filters.keyLike}`}</span> : null}
          <Link href={filters.q ? `/agents?q=${encodeURIComponent(filters.q)}` : "/agents"} className="text-btn">
            清空筛选
          </Link>
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
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>Key / Version</th>
              <th>Docker Image</th>
              <th>Status</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                <td>
                  <div><code>{row.agent_key}</code></div>
                  <div className="muted"><code>{row.version}</code></div>
                </td>
                <td><code>{row.docker_image}</code></td>
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
                      详情
                    </Link>
                    <form action={deleteAgent}>
                      <input type="hidden" name="id" value={row.id} />
                      <input type="hidden" name="q" value={filters.q} />
                      <input type="hidden" name="statusFilter" value={filters.status} />
                      <input type="hidden" name="keyLike" value={filters.keyLike} />
                      <SubmitButton className="text-btn danger" pendingText="删除中...">
                        删除
                      </SubmitButton>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
                <Link href={filters.q ? `/agents?q=${encodeURIComponent(filters.q)}` : "/agents"} className="ghost-btn">
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
              <h3>{editing ? "Agent 详情" : "新建 Agent"}</h3>
              <Link href={listHref} className="icon-btn" aria-label="关闭">
                <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
              </Link>
            </div>
            <div className="action-drawer-body">
              <form action={editing ? updateAgent : createAgent} className="menu-form">
                {editing ? <input type="hidden" name="id" value={editing.id} /> : null}
                <input type="hidden" name="q" value={filters.q} />
                <input type="hidden" name="statusFilter" value={filters.status} />
                <input type="hidden" name="keyLike" value={filters.keyLike} />

                <label className="field-label">名称</label>
                <input name="name" placeholder="Agent 名称" required defaultValue={editing?.name ?? ""} />

                <label className="field-label">Agent Key</label>
                <input name="agentKey" placeholder="例如 openclaw" required defaultValue={editing?.agent_key ?? ""} />

                <label className="field-label">Version</label>
                <input name="version" placeholder="例如 v2026.02.26" required defaultValue={editing?.version ?? ""} />

                <label className="field-label">Docker Image</label>
                <input name="dockerImage" placeholder="例如 ghcr.io/org/openclaw:v2026.02.26" required defaultValue={editing?.docker_image ?? ""} />

                <label className="field-label">Status</label>
                <div className="chip-row">
                  {["active", "archived"].map((item) => (
                    <label key={item} className="chip">
                      <input type="radio" name="status" value={item} defaultChecked={(editing?.status ?? "active") === item} />
                      {item}
                    </label>
                  ))}
                </div>

                <label className="field-label">Description</label>
                <textarea name="description" placeholder="描述" defaultValue={editing?.description ?? ""} />

                <label className="field-label">OpenAPI Spec (JSON)</label>
                <textarea
                  name="openapiSpec"
                  required
                  defaultValue={
                    editing?.openapi_spec
                      ? JSON.stringify(editing.openapi_spec, null, 2)
                      : JSON.stringify(defaultOpenApiSpec, null, 2)
                  }
                />

                <label className="field-label">Metadata (JSON)</label>
                <textarea
                  name="metadata"
                  defaultValue={editing?.metadata ? JSON.stringify(editing.metadata, null, 2) : "{}"}
                />

                <SubmitButton pendingText={editing ? "更新中..." : "创建中..."}>{editing ? "更新" : "创建"}</SubmitButton>
              </form>
              {editing ? (
                <form action={deleteAgent} className="menu-form">
                  <input type="hidden" name="id" value={editing.id} />
                  <input type="hidden" name="q" value={filters.q} />
                  <input type="hidden" name="statusFilter" value={filters.status} />
                  <input type="hidden" name="keyLike" value={filters.keyLike} />
                  <SubmitButton type="submit" className="text-btn danger" pendingText="删除中...">
                    删除
                  </SubmitButton>
                </form>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
