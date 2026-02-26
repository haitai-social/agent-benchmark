import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { dbQuery } from "@/lib/db";
import { requireUser } from "@/lib/supabase-auth";
import { FilterIcon, JudgeIcon, PlusIcon, SearchIcon } from "../components/icons";
import { SubmitButton } from "../components/submit-button";
import { TextareaWithFileUpload } from "../components/textarea-with-file-upload";

function buildListHref(q: string, provider: string, model: string) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (provider !== "all") params.set("provider", provider);
  if (model) params.set("model", model);
  return params.size > 0 ? `/evaluators?${params.toString()}` : "/evaluators";
}

async function createEvaluator(formData: FormData) {
  "use server";
  const user = await requireUser();

  const evaluatorKey = String(formData.get("evaluatorKey") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const promptTemplate = String(formData.get("promptTemplate") ?? "").trim();
  const baseUrl = String(formData.get("baseUrl") ?? "").trim();
  const modelName = String(formData.get("modelName") ?? "").trim();
  const q = String(formData.get("q") ?? "").trim();
  const provider = String(formData.get("provider") ?? "all").trim() || "all";
  const model = String(formData.get("model") ?? "").trim();

  if (!evaluatorKey || !name || !promptTemplate || !baseUrl || !modelName) return;

  await dbQuery(
    `INSERT INTO evaluators (evaluator_key, name, prompt_template, base_url, model_name, created_by, updated_by, updated_at)
     SELECT $1, $2, $3, $4, $5, $6, $6, CURRENT_TIMESTAMP
     WHERE NOT EXISTS (SELECT 1 FROM evaluators WHERE evaluator_key = $7 AND deleted_at IS NULL)`,
    [evaluatorKey, name, promptTemplate, baseUrl, modelName, user.id, evaluatorKey]
  );

  revalidatePath("/evaluators");
  redirect(buildListHref(q, provider, model));
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
  const q = String(formData.get("q") ?? "").trim();
  const provider = String(formData.get("provider") ?? "all").trim() || "all";
  const model = String(formData.get("model") ?? "").trim();

  if (!idRaw || !Number.isInteger(id) || id <= 0 || !evaluatorKey || !name || !promptTemplate || !baseUrl || !modelName) return;

  await dbQuery(
    `UPDATE evaluators
     SET evaluator_key = $2, name = $3, prompt_template = $4, base_url = $5, model_name = $6, updated_by = $7, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND deleted_at IS NULL`,
    [id, evaluatorKey, name, promptTemplate, baseUrl, modelName, user.id]
  );

  revalidatePath("/evaluators");
  redirect(buildListHref(q, provider, model));
}

async function deleteEvaluator(formData: FormData) {
  "use server";
  const user = await requireUser();

  const idRaw = String(formData.get("id") ?? "").trim();
  const id = Number(idRaw);
  const q = String(formData.get("q") ?? "").trim();
  const provider = String(formData.get("provider") ?? "all").trim() || "all";
  const model = String(formData.get("model") ?? "").trim();
  if (!idRaw || !Number.isInteger(id) || id <= 0) return;
  await dbQuery(
    `UPDATE evaluators
     SET is_deleted = TRUE,
         deleted_at = CURRENT_TIMESTAMP,
         updated_by = $2,
         updated_at = CURRENT_TIMESTAMP,
         evaluator_key = CONCAT(evaluator_key, '__deleted__', id)
     WHERE id = $1 AND deleted_at IS NULL`,
    [id, user.id]
  );
  revalidatePath("/evaluators");
  redirect(buildListHref(q, provider, model));
}

export default async function EvaluatorsPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; panel?: string; id?: string; provider?: string; model?: string }>;
}) {
  await requireUser();

  const { q = "", panel = "none", id = "", provider = "all", model = "" } = await searchParams;
  const filters = { q: q.trim(), provider: provider.trim() || "all", model: model.trim() };
  const creating = panel === "create";
  const filtering = panel === "filter";
  const parsedId = id.trim() ? Number(id.trim()) : 0;
  const editingId = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : 0;

  const { rows } = await dbQuery<{
    id: number;
    evaluator_key: string;
    name: string;
    prompt_template: string;
    base_url: string;
    model_name: string;
  }>(
    `SELECT id, evaluator_key, name, prompt_template, base_url, model_name
     FROM evaluators
     WHERE ($1 = '' OR LOWER(name) LIKE CONCAT('%', LOWER($2), '%') OR LOWER(evaluator_key) LIKE CONCAT('%', LOWER($3), '%'))
       AND deleted_at IS NULL
       AND ($4 = '' OR LOWER(model_name) LIKE CONCAT('%', LOWER($5), '%'))
       AND (
         $6 = 'all'
         OR ($6 = 'openai' AND LOWER(base_url) LIKE '%openai%')
         OR ($6 = 'custom' AND LOWER(base_url) NOT LIKE '%openai%')
       )
     ORDER BY created_at ASC`,
    [filters.q, filters.q, filters.q, filters.model, filters.model, filters.provider]
  );

  const listHref = buildListHref(filters.q, filters.provider, filters.model);
  const createHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=create`;
  const filterHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=filter`;
  const hasFilter = filters.provider !== "all" || !!filters.model;
  const editing = editingId ? rows.find((row) => row.id === editingId) : undefined;
  const showDrawer = creating || Boolean(editing);

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
        </div>
      </section>

      {hasFilter ? (
        <section className="active-filters">
          <span className="muted">当前筛选:</span>
          {filters.provider !== "all" ? <span className="filter-pill">{`Provider: ${filters.provider}`}</span> : null}
          {filters.model ? <span className="filter-pill">{`Model: ${filters.model}`}</span> : null}
          <Link href={filters.q ? `/evaluators?q=${encodeURIComponent(filters.q)}` : "/evaluators"} className="text-btn">
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
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>Key</th>
              <th>Base URL / Model</th>
              <th>Prompt 预览</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
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
                      详情
                    </Link>
                    <form action={deleteEvaluator}>
                      <input type="hidden" name="id" value={row.id} />
                      <input type="hidden" name="q" value={filters.q} />
                      <input type="hidden" name="provider" value={filters.provider} />
                      <input type="hidden" name="model" value={filters.model} />
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
                <Link href={filters.q ? `/evaluators?q=${encodeURIComponent(filters.q)}` : "/evaluators"} className="ghost-btn">
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
              <h3>{editing ? "Evaluator 详情" : "新建 Evaluator"}</h3>
              <Link href={listHref} className="icon-btn" aria-label="关闭">
                <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
              </Link>
            </div>
            <div className="action-drawer-body">
              <form
                id={editing ? `evaluator-form-${editing.id}` : "evaluator-form-create"}
                action={editing ? updateEvaluator : createEvaluator}
                className="menu-form form-tone-green"
              >
                {editing ? <input type="hidden" name="id" value={editing.id} /> : null}
                <input type="hidden" name="q" value={filters.q} />
                <input type="hidden" name="provider" value={filters.provider} />
                <input type="hidden" name="model" value={filters.model} />
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title required">Evaluator 名称</span>
                    <span className="type-pill">String</span>
                  </label>
                  <input name="name" placeholder="Evaluator 名称" required defaultValue={editing?.name ?? ""} />
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
                    defaultValue={editing?.evaluator_key ?? ""}
                  />
                </div>
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title required">Base URL</span>
                    <span className="type-pill">URL</span>
                  </label>
                  <input
                    name="baseUrl"
                    placeholder="Base URL（如 https://api.openai.com/v1）"
                    required
                    defaultValue={editing?.base_url ?? "https://api.openai.com/v1"}
                  />
                </div>
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title required">Model Name</span>
                    <span className="type-pill">String</span>
                  </label>
                  <input
                    name="modelName"
                    placeholder="Model Name（如 gpt-4.1-mini）"
                    required
                    defaultValue={editing?.model_name ?? "gpt-4.1-mini"}
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
                    defaultValue={editing?.prompt_template ?? ""}
                  />
                </div>
              </form>
              <div className="drawer-actions">
                <SubmitButton
                  form={editing ? `evaluator-form-${editing.id}` : "evaluator-form-create"}
                  className="primary-btn"
                  pendingText={editing ? "更新中..." : "创建中..."}
                >
                  {editing ? "更新" : "创建"}
                </SubmitButton>
                {editing ? (
                  <form action={deleteEvaluator} className="drawer-inline-form">
                    <input type="hidden" name="id" value={editing.id} />
                    <input type="hidden" name="q" value={filters.q} />
                    <input type="hidden" name="provider" value={filters.provider} />
                    <input type="hidden" name="model" value={filters.model} />
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
