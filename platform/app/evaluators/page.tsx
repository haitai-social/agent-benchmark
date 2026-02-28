import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { dbQuery } from "@/lib/db";
import { PaginationControls } from "@/app/components/pagination-controls";
import { BulkSelectionControls } from "@/app/components/bulk-selection-controls";
import { clampPage, getOffset, parsePage, parsePageSize } from "@/lib/pagination";
import { parseSelectedIds } from "@/lib/form-ids";
import { requireUser } from "@/lib/supabase-auth";
import { FilterIcon, JudgeIcon, PlusIcon, SearchIcon } from "../components/icons";
import { SubmitButton } from "../components/submit-button";
import { TextareaWithFileUpload } from "../components/textarea-with-file-upload";

function buildListHref(q: string, provider: string, model: string, page: number, pageSize: number) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (provider !== "all") params.set("provider", provider);
  if (model) params.set("model", model);
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 10) params.set("pageSize", String(pageSize));
  return params.size > 0 ? `/evaluators?${params.toString()}` : "/evaluators";
}

function normalizeApiStyle(raw: string) {
  const value = raw.trim().toLowerCase();
  if (value === "anthropic") return "anthropic";
  return "openai";
}

function maskApiKey(value: string) {
  const v = value.trim();
  if (!v) return "-";
  if (v.length <= 8) return "****";
  return `${v.slice(0, 4)}****${v.slice(-4)}`;
}

async function createEvaluator(formData: FormData) {
  "use server";
  const user = await requireUser();

  const evaluatorKey = String(formData.get("evaluatorKey") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const promptTemplate = String(formData.get("promptTemplate") ?? "").trim();
  const baseUrl = String(formData.get("baseUrl") ?? "").trim();
  const modelName = String(formData.get("modelName") ?? "").trim();
  const apiStyle = normalizeApiStyle(String(formData.get("apiStyle") ?? "openai"));
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const q = String(formData.get("q") ?? "").trim();
  const provider = String(formData.get("provider") ?? "all").trim() || "all";
  const model = String(formData.get("model") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));

  if (!evaluatorKey || !name || !promptTemplate || !baseUrl || !modelName) return;

  await dbQuery(
    `INSERT INTO evaluators (evaluator_key, name, prompt_template, base_url, model_name, api_style, api_key, created_by, updated_by, updated_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $8, CURRENT_TIMESTAMP
     WHERE NOT EXISTS (SELECT 1 FROM evaluators WHERE evaluator_key = $9 AND deleted_at IS NULL)`,
    [evaluatorKey, name, promptTemplate, baseUrl, modelName, apiStyle, apiKey, user.id, evaluatorKey]
  );

  revalidatePath("/evaluators");
  redirect(buildListHref(q, provider, model, page, pageSize));
}

async function updateEvaluator(formData: FormData) {
  "use server";
  const user = await requireUser();

  const idRaw = String(formData.get("id") ?? "").trim();
  const id = Number(idRaw);
  const evaluatorKey = String(formData.get("evaluatorKey") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const promptTemplate = String(formData.get("promptTemplate") ?? "").trim();
  const baseUrl = String(formData.get("baseUrl") ?? "").trim();
  const modelName = String(formData.get("modelName") ?? "").trim();
  const apiStyle = normalizeApiStyle(String(formData.get("apiStyle") ?? "openai"));
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const q = String(formData.get("q") ?? "").trim();
  const provider = String(formData.get("provider") ?? "all").trim() || "all";
  const model = String(formData.get("model") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));

  if (!idRaw || !Number.isInteger(id) || id <= 0 || !evaluatorKey || !name || !promptTemplate || !baseUrl || !modelName) return;

  await dbQuery(
    `UPDATE evaluators
     SET evaluator_key = $2, name = $3, prompt_template = $4, base_url = $5, model_name = $6, api_style = $7, api_key = $8, updated_by = $9, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND deleted_at IS NULL`,
    [id, evaluatorKey, name, promptTemplate, baseUrl, modelName, apiStyle, apiKey, user.id]
  );

  revalidatePath("/evaluators");
  redirect(buildListHref(q, provider, model, page, pageSize));
}

async function deleteEvaluator(formData: FormData) {
  "use server";
  const user = await requireUser();

  const idRaw = String(formData.get("id") ?? "").trim();
  const id = Number(idRaw);
  const q = String(formData.get("q") ?? "").trim();
  const provider = String(formData.get("provider") ?? "all").trim() || "all";
  const model = String(formData.get("model") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));
  if (!idRaw || !Number.isInteger(id) || id <= 0) return;
  await softDeleteEvaluatorById(id, user.id);
  revalidatePath("/evaluators");
  redirect(buildListHref(q, provider, model, page, pageSize));
}

async function softDeleteEvaluatorById(id: number, userId: string) {
  await dbQuery(
    `UPDATE evaluators
     SET is_deleted = TRUE,
         deleted_at = CURRENT_TIMESTAMP,
         updated_by = $2,
         updated_at = CURRENT_TIMESTAMP,
         evaluator_key = CONCAT(evaluator_key, '__deleted__', id)
     WHERE id = $1 AND deleted_at IS NULL`,
    [id, userId]
  );
}

async function bulkDeleteEvaluator(formData: FormData) {
  "use server";
  const user = await requireUser();

  const ids = parseSelectedIds(formData);
  const q = String(formData.get("q") ?? "").trim();
  const provider = String(formData.get("provider") ?? "all").trim() || "all";
  const model = String(formData.get("model") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));
  if (ids.length <= 0) return;

  for (const id of ids) {
    await softDeleteEvaluatorById(id, user.id);
  }
  revalidatePath("/evaluators");
  redirect(buildListHref(q, provider, model, page, pageSize));
}

export default async function EvaluatorsPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; panel?: string; id?: string; provider?: string; model?: string; page?: string; pageSize?: string }>;
}) {
  await requireUser();

  const { q = "", panel = "none", id = "", provider = "all", model = "", page: pageRaw, pageSize: pageSizeRaw } = await searchParams;
  const filters = { q: q.trim(), provider: provider.trim() || "all", model: model.trim() };
  const pageSize = parsePageSize(pageSizeRaw);
  const requestedPage = parsePage(pageRaw);
  const creating = panel === "create";
  const filtering = panel === "filter";
  const parsedId = id.trim() ? Number(id.trim()) : 0;
  const editingId = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : 0;

  const filterParams = [filters.q, filters.q, filters.q, filters.model, filters.model, filters.provider];
  const [countResult, editing] = await Promise.all([
    dbQuery<{ total_count: number | string }>(
      `SELECT COUNT(*) AS total_count
       FROM evaluators
       WHERE ($1 = '' OR LOWER(name) LIKE CONCAT('%', LOWER($2), '%') OR LOWER(evaluator_key) LIKE CONCAT('%', LOWER($3), '%'))
         AND deleted_at IS NULL
         AND ($4 = '' OR LOWER(model_name) LIKE CONCAT('%', LOWER($5), '%'))
         AND (
           $6 = 'all'
           OR ($6 = 'openai' AND api_style = 'openai')
           OR ($6 = 'custom' AND api_style <> 'openai')
         )`,
      filterParams
    ),
    editingId
      ? dbQuery<{
          id: number;
          evaluator_key: string;
          name: string;
          prompt_template: string;
          base_url: string;
          model_name: string;
          api_style: string;
          api_key: string;
        }>(
          `SELECT id, evaluator_key, name, prompt_template, base_url, model_name, api_style, api_key
           FROM evaluators
           WHERE id = $1 AND deleted_at IS NULL
           LIMIT 1`,
          [editingId]
        )
      : Promise.resolve({ rows: [], rowCount: 0 } as { rows: Array<{ id: number; evaluator_key: string; name: string; prompt_template: string; base_url: string; model_name: string; api_style: string; api_key: string }>; rowCount: number })
  ]);
  const total = Number(countResult.rows[0]?.total_count ?? 0);
  const page = clampPage(requestedPage, total, pageSize);
  const offset = getOffset(page, pageSize);
  const { rows } = await dbQuery<{
    id: number;
    evaluator_key: string;
    name: string;
    prompt_template: string;
    base_url: string;
    model_name: string;
    api_style: string;
    api_key: string;
  }>(
    `SELECT id, evaluator_key, name, prompt_template, base_url, model_name, api_style, api_key
     FROM evaluators
     WHERE ($1 = '' OR LOWER(name) LIKE CONCAT('%', LOWER($2), '%') OR LOWER(evaluator_key) LIKE CONCAT('%', LOWER($3), '%'))
       AND deleted_at IS NULL
       AND ($4 = '' OR LOWER(model_name) LIKE CONCAT('%', LOWER($5), '%'))
       AND (
         $6 = 'all'
         OR ($6 = 'openai' AND api_style = 'openai')
         OR ($6 = 'custom' AND api_style <> 'openai')
       )
     ORDER BY created_at ASC
     LIMIT $7 OFFSET $8`,
    [...filterParams, pageSize, offset]
  );

  const listHref = buildListHref(filters.q, filters.provider, filters.model, page, pageSize);
  const createHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=create`;
  const filterHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=filter`;
  const hasFilter = filters.provider !== "all" || !!filters.model;
  const editingRow = editing.rowCount > 0 ? editing.rows[0] : undefined;
  const paginationQuery = {
    q: filters.q,
    provider: filters.provider === "all" ? "" : filters.provider,
    model: filters.model
  };
  const resetHref = buildListHref(filters.q, "all", "", 1, pageSize);
  const showDrawer = creating || Boolean(editingRow);
  const bulkDeleteFormId = "evaluator-bulk-delete-form";

  return (
    <div className="grid">
      <section className="page-hero">
        <div className="breadcrumb">评测 &nbsp;/&nbsp; Evaluators</div>
        <h1>Evaluators</h1>
        <p className="muted">LLM as Judge 评估器管理。四个预设评估器已通过数据库初始化脚本内置。</p>
      </section>

      <section className="toolbar-row">
        <form action="/evaluators" className="search-form">
          <input type="hidden" name="provider" value={filters.provider} />
          <input type="hidden" name="model" value={filters.model} />
          <input type="hidden" name="pageSize" value={pageSize} />
          <label className="input-icon-wrap">
            <SearchIcon width={16} height={16} />
            <input name="q" defaultValue={filters.q} placeholder="搜索评估器名称或 key" />
          </label>
          <button type="submit" className="ghost-btn">
            搜索
          </button>
        </form>

        <div className="action-group">
          <Link href={filterHref} className="ghost-btn">
            <FilterIcon width={16} height={16} /> 筛选
          </Link>
          <BulkSelectionControls formId={bulkDeleteFormId} variant="compact" confirmText="确认批量删除已选 {count} 条 Evaluator 吗？" />
          <PaginationControls basePath="/evaluators" query={paginationQuery} total={total} page={page} pageSize={pageSize} position="top" variant="compact" />
        </div>
      </section>

      {hasFilter ? (
        <section className="active-filters">
          <span className="muted">当前筛选:</span>
          {filters.provider !== "all" ? <span className="filter-pill">{`Provider: ${filters.provider}`}</span> : null}
          {filters.model ? <span className="filter-pill">{`Model: ${filters.model}`}</span> : null}
          <Link href={resetHref} className="text-btn">
            清空筛选
          </Link>
        </section>
      ) : null}

      <section className="card table-card">
        <div className="section-title-row">
          <h2>
            <JudgeIcon width={16} height={16} />
            Evaluators
          </h2>
          <Link href={createHref} className="primary-btn">
            <PlusIcon width={16} height={16} /> 新建 Evaluator
          </Link>
        </div>
        <form id={bulkDeleteFormId} action={bulkDeleteEvaluator}>
          <input type="hidden" name="q" value={filters.q} />
          <input type="hidden" name="provider" value={filters.provider} />
          <input type="hidden" name="model" value={filters.model} />
          <input type="hidden" name="page" value={page} />
          <input type="hidden" name="pageSize" value={pageSize} />
        </form>
        <table>
          <thead>
            <tr>
              <th className="bulk-select-cell">选</th>
              <th>名称</th>
              <th>Key</th>
              <th>Base URL / Model</th>
              <th>API</th>
              <th>Prompt 预览</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="bulk-select-cell">
                  <input type="checkbox" name="selectedIds" value={row.id} form={bulkDeleteFormId} aria-label={`选择 Evaluator ${row.id}`} />
                </td>
                <td>{row.name}</td>
                <td>
                  <code>{row.evaluator_key}</code>
                </td>
                <td>
                  <div>
                    <code>{row.base_url}</code>
                  </div>
                  <div className="muted">
                    <code>{row.model_name}</code>
                  </div>
                </td>
                <td>
                  <div>
                    <code>{row.api_style}</code>
                  </div>
                  <div className="muted">
                    <code>{maskApiKey(row.api_key)}</code>
                  </div>
                </td>
                <td>
                  <div className="muted">{row.prompt_template.slice(0, 220)}...</div>
                </td>
                <td>
                  <div className="row-actions">
                    <Link
                      href={
                        listHref.includes("?")
                          ? `${listHref}&id=${row.id}`
                          : `/evaluators?id=${row.id}`
                      }
                      className="text-btn"
                    >
                      更新
                    </Link>
                    <form action={deleteEvaluator}>
                      <input type="hidden" name="id" value={row.id} />
                      <input type="hidden" name="q" value={filters.q} />
                      <input type="hidden" name="provider" value={filters.provider} />
                      <input type="hidden" name="model" value={filters.model} />
                      <input type="hidden" name="page" value={page} />
                      <input type="hidden" name="pageSize" value={pageSize} />
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
        <BulkSelectionControls formId={bulkDeleteFormId} variant="full" confirmText="确认批量删除已选 {count} 条 Evaluator 吗？" />
        <PaginationControls basePath="/evaluators" query={paginationQuery} total={total} page={page} pageSize={pageSize} position="bottom" />
      </section>

      {filtering ? (
        <div className="action-overlay">
          <Link href={listHref || "/evaluators"} className="action-overlay-dismiss" aria-label="关闭筛选" />
          <aside className="action-drawer">
            <div className="action-drawer-header">
              <h3>筛选 Evaluators</h3>
              <Link href={listHref || "/evaluators"} className="icon-btn" aria-label="关闭">
                <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
              </Link>
            </div>
            <div className="action-drawer-body">
              <form action="/evaluators" className="menu-form">
                <input type="hidden" name="q" value={filters.q} />
                <input type="hidden" name="panel" value="none" />
                <input type="hidden" name="pageSize" value={pageSize} />
                <label className="field-label">Provider 类型</label>
                <div className="chip-row">
                  {[
                    { value: "all", label: "全部" },
                    { value: "openai", label: "OpenAI" },
                    { value: "custom", label: "Custom" }
                  ].map((item) => (
                    <label key={item.value} className="chip">
                      <input type="radio" name="provider" value={item.value} defaultChecked={filters.provider === item.value} />
                      {item.label}
                    </label>
                  ))}
                </div>
                <label className="field-label">Model 包含</label>
                <input name="model" placeholder="如 gpt-4.1" defaultValue={filters.model} />
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
              <h3>{editingRow ? "Evaluator 详情" : "新建 Evaluator"}</h3>
              <Link href={listHref} className="icon-btn" aria-label="关闭">
                <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
              </Link>
            </div>
            <div className="action-drawer-body">
              <form
                id={editingRow ? `evaluator-form-${editingRow.id}` : "evaluator-form-create"}
                action={editingRow ? updateEvaluator : createEvaluator}
                className="menu-form form-tone-green"
              >
                {editingRow ? <input type="hidden" name="id" value={editingRow.id} /> : null}
                <input type="hidden" name="q" value={filters.q} />
                <input type="hidden" name="provider" value={filters.provider} />
                <input type="hidden" name="model" value={filters.model} />
                <input type="hidden" name="page" value={page} />
                <input type="hidden" name="pageSize" value={pageSize} />
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title required">Evaluator 名称</span>
                    <span className="type-pill">String</span>
                  </label>
                  <input name="name" placeholder="Evaluator 名称" required defaultValue={editingRow?.name ?? ""} />
                </div>
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title required">Evaluator Key</span>
                    <span className="type-pill">Unique</span>
                  </label>
                  <input
                    name="evaluatorKey"
                    placeholder="evaluator key（唯一）"
                    required
                    defaultValue={editingRow?.evaluator_key ?? ""}
                  />
                </div>
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title required">Base URL</span>
                    <span className="type-pill">URL</span>
                  </label>
                  <input
                    name="baseUrl"
                    placeholder="Base URL（如 https://ark.cn-beijing.volces.com/api/coding/v3）"
                    required
                    defaultValue={editingRow?.base_url ?? "https://ark.cn-beijing.volces.com/api/coding/v3"}
                  />
                </div>
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title required">Model Name</span>
                    <span className="type-pill">String</span>
                  </label>
                  <input
                    name="modelName"
                    placeholder="Model Name（如 kimi-k2.5）"
                    required
                    defaultValue={editingRow?.model_name ?? "kimi-k2.5"}
                  />
                </div>
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title required">API Style</span>
                    <span className="type-pill">Enum</span>
                  </label>
                  <select name="apiStyle" defaultValue={editingRow?.api_style ?? "anthropic"} required>
                    <option value="openai">openai</option>
                    <option value="anthropic">anthropic</option>
                  </select>
                </div>
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title required">API Key</span>
                    <span className="type-pill">Secret</span>
                  </label>
                  <input
                    name="apiKey"
                    placeholder="API Key"
                    required
                    defaultValue={editingRow?.api_key ?? ""}
                  />
                </div>
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title required">Prompt Template</span>
                    <span className="type-pill">Text</span>
                  </label>
                  <TextareaWithFileUpload
                    name="promptTemplate"
                    placeholder="评估 Prompt 模板"
                    required
                    accept=".txt,.md,.json"
                    defaultValue={editingRow?.prompt_template ?? ""}
                  />
                </div>
              </form>
              <div className="drawer-actions">
                <SubmitButton
                  form={editingRow ? `evaluator-form-${editingRow.id}` : "evaluator-form-create"}
                  className="primary-btn"
                  pendingText={editingRow ? "更新中..." : "创建中..."}
                >
                  {editingRow ? "更新" : "创建"}
                </SubmitButton>
                {editingRow ? (
                  <form action={deleteEvaluator} className="drawer-inline-form">
                    <input type="hidden" name="id" value={editingRow.id} />
                    <input type="hidden" name="q" value={filters.q} />
                    <input type="hidden" name="provider" value={filters.provider} />
                    <input type="hidden" name="model" value={filters.model} />
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
