import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { dbQuery } from "@/lib/db";
import { requireUser } from "@/lib/supabase-auth";
import { FilterIcon, JudgeIcon, PlusIcon, RefreshIcon, SearchIcon } from "../components/icons";
import { SubmitButton } from "../components/submit-button";

async function createEvaluator(formData: FormData) {
  "use server";
  const user = await requireUser();

  const evaluatorKey = String(formData.get("evaluatorKey") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const promptTemplate = String(formData.get("promptTemplate") ?? "").trim();
  const baseUrl = String(formData.get("baseUrl") ?? "").trim();
  const modelName = String(formData.get("modelName") ?? "").trim();
  const q = String(formData.get("q") ?? "").trim();

  if (!evaluatorKey || !name || !promptTemplate || !baseUrl || !modelName) return;

  await dbQuery(
    `INSERT INTO evaluators (evaluator_key, name, prompt_template, base_url, model_name, created_by, updated_by, updated_at)
     SELECT $1, $2, $3, $4, $5, $6, $6, CURRENT_TIMESTAMP
     WHERE NOT EXISTS (SELECT 1 FROM evaluators WHERE evaluator_key = $7)`,
    [evaluatorKey, name, promptTemplate, baseUrl, modelName, user.id, evaluatorKey]
  );

  revalidatePath("/evaluators");
  redirect(q ? `/evaluators?q=${encodeURIComponent(q)}` : "/evaluators");
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

  if (!idRaw || !Number.isInteger(id) || id <= 0 || !evaluatorKey || !name || !promptTemplate || !baseUrl || !modelName) return;

  await dbQuery(
    `UPDATE evaluators
     SET evaluator_key = $2, name = $3, prompt_template = $4, base_url = $5, model_name = $6, updated_by = $7, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id, evaluatorKey, name, promptTemplate, baseUrl, modelName, user.id]
  );

  revalidatePath("/evaluators");
  redirect(q ? `/evaluators?q=${encodeURIComponent(q)}` : "/evaluators");
}

async function deleteEvaluator(formData: FormData) {
  "use server";
  await requireUser();

  const idRaw = String(formData.get("id") ?? "").trim();
  const id = Number(idRaw);
  const q = String(formData.get("q") ?? "").trim();
  if (!idRaw || !Number.isInteger(id) || id <= 0) return;
  await dbQuery(`DELETE FROM evaluators WHERE id = $1`, [id]);
  revalidatePath("/evaluators");
  redirect(q ? `/evaluators?q=${encodeURIComponent(q)}` : "/evaluators");
}

export default async function EvaluatorsPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; panel?: string; id?: string }>;
}) {
  await requireUser();

  const { q = "", panel = "none", id = "" } = await searchParams;
  const filters = { q: q.trim() };
  const creating = panel === "create";
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
     ORDER BY created_at ASC`,
    [filters.q, filters.q, filters.q]
  );

  const listParams = new URLSearchParams();
  if (filters.q) listParams.set("q", filters.q);
  const listHref = listParams.size > 0 ? `/evaluators?${listParams.toString()}` : "/evaluators";
  const createHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=create`;
  const editing = editingId ? rows.find((row) => row.id === editingId) : undefined;
  const showDrawer = creating || Boolean(editing);

  return (
    <div className="grid">
      <section className="page-hero">
        <div className="breadcrumb">评测 &nbsp;/&nbsp; 评估器</div>
        <h1>评估器</h1>
        <p className="muted">LLM as Judge 评估器管理。四个预设评估器已通过数据库初始化脚本内置。</p>
      </section>

      <section className="toolbar-row">
        <form action="/evaluators" className="search-form">
          <label className="input-icon-wrap">
            <SearchIcon width={16} height={16} />
            <input name="q" defaultValue={filters.q} placeholder="搜索评估器名称或 key" />
          </label>
          <button type="submit" className="ghost-btn">
            <FilterIcon width={16} height={16} /> 筛选
          </button>
        </form>

        <div className="action-group">
          <span className="toolbar-hint">共 {rows.length} 个</span>
          <a href={listHref} className="icon-btn" aria-label="刷新">
            <RefreshIcon width={16} height={16} />
          </a>
          <Link href={createHref} className="primary-btn">
            <PlusIcon width={16} height={16} /> 新建评估器
          </Link>
        </div>
      </section>

      <section className="card table-card">
        <div className="section-title-row">
          <h2>
            <JudgeIcon width={16} height={16} />
            评估器列表
          </h2>
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
                        listParams.size > 0
                          ? `/evaluators?${listParams.toString()}&id=${row.id}`
                          : `/evaluators?id=${row.id}`
                      }
                      className="text-btn"
                    >
                      详情
                    </Link>
                    <form action={deleteEvaluator}>
                      <input type="hidden" name="id" value={row.id} />
                      <input type="hidden" name="q" value={filters.q} />
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

      {showDrawer ? (
        <div className="action-overlay">
          <Link href={listHref} className="action-overlay-dismiss" aria-label="关闭抽屉蒙层" />
          <aside className="action-drawer">
            <div className="action-drawer-header">
              <h3>{editing ? "评估器详情" : "新建评估器"}</h3>
              <Link href={listHref} className="icon-btn" aria-label="关闭">
                <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
              </Link>
            </div>
            <div className="action-drawer-body">
              <p className="muted">列表页只提供查看能力，所有操作在右侧栏完成。</p>
              <form action={editing ? updateEvaluator : createEvaluator} className="menu-form">
                {editing ? <input type="hidden" name="id" value={editing.id} /> : null}
                <input type="hidden" name="q" value={filters.q} />
                <label className="field-label">评估器名称</label>
                <input name="name" placeholder="评估器名称" required defaultValue={editing?.name ?? ""} />
                <label className="field-label">Evaluator Key</label>
                <input
                  name="evaluatorKey"
                  placeholder="evaluator key（唯一）"
                  required
                  defaultValue={editing?.evaluator_key ?? ""}
                />
                <label className="field-label">Base URL</label>
                <input
                  name="baseUrl"
                  placeholder="Base URL（如 https://api.openai.com/v1）"
                  required
                  defaultValue={editing?.base_url ?? "https://api.openai.com/v1"}
                />
                <label className="field-label">Model Name</label>
                <input
                  name="modelName"
                  placeholder="Model Name（如 gpt-4.1-mini）"
                  required
                  defaultValue={editing?.model_name ?? "gpt-4.1-mini"}
                />
                <label className="field-label">Prompt Template</label>
                <textarea
                  name="promptTemplate"
                  placeholder="评估 Prompt 模板"
                  required
                  defaultValue={editing?.prompt_template ?? ""}
                />
                <SubmitButton pendingText={editing ? "更新中..." : "创建中..."}>{editing ? "更新" : "创建"}</SubmitButton>
              </form>
              {editing ? (
                <form action={deleteEvaluator} className="menu-form">
                  <input type="hidden" name="id" value={editing.id} />
                  <input type="hidden" name="q" value={filters.q} />
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
