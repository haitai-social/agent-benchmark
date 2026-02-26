import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { dbQuery } from "@/lib/db";
import { requireUser } from "@/lib/supabase-auth";
import { DatasetIcon, FilterIcon, OpenInNewIcon, PlusIcon, SearchIcon } from "../components/icons";
import { SubmitButton } from "../components/submit-button";
import { EntityDrawer } from "../components/entity-drawer";
import { FormField } from "../components/form-field";

async function createDataset(formData: FormData) {
  "use server";
  const user = await requireUser();

  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const q = String(formData.get("q") ?? "").trim();
  const minItems = String(formData.get("minItems") ?? "all").trim() || "all";
  const updatedIn = String(formData.get("updatedIn") ?? "all").trim() || "all";
  if (!name) return;
  await dbQuery(
    `INSERT INTO datasets (name, description, created_by, updated_by, updated_at)
     SELECT $1, $2, $3, $3, CURRENT_TIMESTAMP
     WHERE NOT EXISTS (SELECT 1 FROM datasets WHERE name = $4 AND deleted_at IS NULL)`,
    [name, description, user.id, name]
  );
  revalidatePath("/datasets");
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (minItems !== "all") params.set("minItems", minItems);
  if (updatedIn !== "all") params.set("updatedIn", updatedIn);
  redirect(params.size > 0 ? `/datasets?${params.toString()}` : "/datasets");
}

async function deleteDataset(formData: FormData) {
  "use server";
  const user = await requireUser();

  const idRaw = String(formData.get("id") ?? "").trim();
  const id = Number(idRaw);
  if (!idRaw || !Number.isInteger(id) || id <= 0) return;
  await dbQuery(
    `UPDATE datasets
     SET is_deleted = TRUE,
         deleted_at = CURRENT_TIMESTAMP,
         updated_by = $2,
         updated_at = CURRENT_TIMESTAMP,
         name = CONCAT(name, '__deleted__', id)
     WHERE id = $1 AND deleted_at IS NULL`,
    [id, user.id]
  );
  await dbQuery(
    `UPDATE data_items
     SET is_deleted = TRUE,
         deleted_at = CURRENT_TIMESTAMP,
         updated_by = $2,
         updated_at = CURRENT_TIMESTAMP
     WHERE dataset_id = $1 AND deleted_at IS NULL`,
    [id, user.id]
  );
  await dbQuery(
    `UPDATE experiments
     SET is_deleted = TRUE,
         deleted_at = CURRENT_TIMESTAMP,
         updated_by = $2,
         updated_at = CURRENT_TIMESTAMP,
         status = 'archived'
     WHERE dataset_id = $1 AND deleted_at IS NULL`,
    [id, user.id]
  );
  revalidatePath("/datasets");
  revalidatePath("/experiments");
}

async function updateDataset(formData: FormData) {
  "use server";
  const user = await requireUser();

  const idRaw = String(formData.get("id") ?? "").trim();
  const id = Number(idRaw);
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const q = String(formData.get("q") ?? "").trim();
  const minItems = String(formData.get("minItems") ?? "all").trim() || "all";
  const updatedIn = String(formData.get("updatedIn") ?? "all").trim() || "all";
  if (!idRaw || !Number.isInteger(id) || id <= 0 || !name) return;
  await dbQuery(`UPDATE datasets SET name = $2, description = $3, updated_by = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND deleted_at IS NULL`, [
    id,
    name,
    description,
    user.id
  ]);
  revalidatePath("/datasets");
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (minItems !== "all") params.set("minItems", minItems);
  if (updatedIn !== "all") params.set("updatedIn", updatedIn);
  redirect(params.size > 0 ? `/datasets?${params.toString()}` : "/datasets");
}

export default async function DatasetsPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; panel?: string; minItems?: string; updatedIn?: string; id?: string }>;
}) {
  await requireUser();

  const { q = "", panel = "none", minItems = "all", updatedIn = "all", id = "" } = await searchParams;
  const queryText = q.trim();
  const creating = panel === "create";
  const filtering = panel === "filter";
  const editingId = Number(id.trim());

  const minItemsValue = minItems === "all" ? null : Number(minItems);
  const minItemsFilter =
    typeof minItemsValue === "number" && Number.isFinite(minItemsValue) && minItemsValue >= 0 ? minItemsValue : null;
  const updatedWindow = updatedIn === "7d" ? 7 : updatedIn === "30d" ? 30 : null;
  const updatedAfter = updatedWindow ? new Date(Date.now() - updatedWindow * 24 * 60 * 60 * 1000).toISOString() : null;

  const { rows } = await dbQuery<{
    id: number;
    name: string;
    description: string;
    item_count: number;
    created_by: string;
    updated_by: string;
    updated_at: string;
  }>(
    `SELECT
      d.id,
      d.name,
      d.description,
      d.created_by,
      d.updated_by,
      d.updated_at,
      COUNT(i.id) AS item_count
     FROM datasets d
     LEFT JOIN data_items i ON i.dataset_id = d.id AND i.deleted_at IS NULL
     WHERE ($1 = '' OR LOWER(d.name) LIKE CONCAT('%', LOWER($2), '%'))
       AND d.deleted_at IS NULL
       AND ($3 IS NULL OR d.updated_at >= $4)
     GROUP BY d.id, d.name, d.description, d.created_by, d.updated_by, d.updated_at
     HAVING ($5 IS NULL OR COUNT(i.id) >= $6)
     ORDER BY d.updated_at DESC`,
    [queryText, queryText, updatedAfter, updatedAfter, minItemsFilter, minItemsFilter]
  );

  const listParams = new URLSearchParams();
  if (queryText) listParams.set("q", queryText);
  if (minItems !== "all") listParams.set("minItems", minItems);
  if (updatedIn !== "all") listParams.set("updatedIn", updatedIn);
  const listHref = listParams.size > 0 ? `/datasets?${listParams.toString()}` : "/datasets";
  const createHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=create`;
  const filterHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=filter`;
  const hasFilter = minItems !== "all" || updatedIn !== "all";
  const editingRow = Number.isInteger(editingId) && editingId > 0 ? rows.find((r) => r.id === editingId) ?? null : null;
  const showEditor = creating || Boolean(editingRow);

  return (
    <div className="grid">
      <section className="page-hero">
        <div className="breadcrumb">评测 &nbsp;/&nbsp; Datasets</div>
        <h1>Datasets</h1>
        <p className="muted">管理数据集、字段结构与版本演进。</p>
      </section>

      <section className="toolbar-row">
        <form action="/datasets" className="search-form">
          <input type="hidden" name="minItems" value={minItems} />
          <input type="hidden" name="updatedIn" value={updatedIn} />
          <label className="input-icon-wrap">
            <SearchIcon width={16} height={16} />
            <input name="q" defaultValue={queryText} placeholder="搜索名称" />
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
          {minItems !== "all" ? <span className="filter-pill">{`DataItems >= ${minItems}`}</span> : null}
          {updatedIn !== "all" ? <span className="filter-pill">{`更新时间: ${updatedIn}`}</span> : null}
          <Link href={queryText ? `/datasets?q=${encodeURIComponent(queryText)}` : "/datasets"} className="text-btn">
            清空筛选
          </Link>
        </section>
      ) : null}

      <section className="card table-card">
        <div className="section-title-row">
          <h2>
            <DatasetIcon width={16} height={16} />
            Datasets
          </h2>
          <Link href={createHref} className="primary-btn">
            <PlusIcon width={16} height={16} /> 新建 Dataset
          </Link>
        </div>
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>列名</th>
              <th>DataItems</th>
              <th>最新版本</th>
              <th>描述</th>
              <th>更新人</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/datasets/${row.id}`} className="link-strong">
                    {row.name}
                  </Link>
                </td>
                <td>
                  <div className="tag-row">
                    <span className="tag">session_jsonl</span>
                    <span className="tag">input</span>
                    <span className="tag">reference_output</span>
                    <span className="tag">reference_trajectory</span>
                  </div>
                </td>
                <td>{row.item_count}</td>
                <td>-</td>
                <td className="muted">{row.description || "-"}</td>
                <td>{row.updated_by.slice(0, 8)}</td>
                <td>{new Date(row.updated_at).toLocaleString()}</td>
                <td>
                  <div className="row-actions">
                    <Link href={`${listHref}${listHref.includes("?") ? "&" : "?"}id=${row.id}`} className="text-btn">
                      详情
                    </Link>
                    <form action={deleteDataset}>
                      <input type="hidden" name="id" value={row.id} />
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
          <Link href={listHref || "/datasets"} className="action-overlay-dismiss" aria-label="关闭筛选" />
          <aside className="action-drawer">
            <div className="action-drawer-header">
              <h3>筛选 Datasets</h3>
              <Link href={listHref || "/datasets"} className="icon-btn" aria-label="关闭">
                <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
              </Link>
            </div>
            <div className="action-drawer-body">
              <form action="/datasets" className="menu-form">
                <input type="hidden" name="q" value={queryText} />
                <input type="hidden" name="panel" value="none" />
                <label className="field-label">最小 DataItems 数量</label>
                <div className="chip-row">
                  {["all", "1", "10", "50"].map((v) => (
                    <label key={v} className="chip">
                      <input type="radio" name="minItems" value={v} defaultChecked={minItems === v} />
                      {v === "all" ? "全部" : `>= ${v}`}
                    </label>
                  ))}
                </div>
                <label className="field-label">更新时间窗口</label>
                <div className="chip-row">
                  {[
                    { value: "all", label: "全部" },
                    { value: "7d", label: "最近 7 天" },
                    { value: "30d", label: "最近 30 天" }
                  ].map((item) => (
                    <label key={item.value} className="chip">
                      <input type="radio" name="updatedIn" value={item.value} defaultChecked={updatedIn === item.value} />
                      {item.label}
                    </label>
                  ))}
                </div>
                <SubmitButton pendingText="应用中...">应用筛选</SubmitButton>
                <Link href={queryText ? `/datasets?q=${encodeURIComponent(queryText)}` : "/datasets"} className="ghost-btn">
                  重置筛选
                </Link>
              </form>
            </div>
          </aside>
        </div>
      ) : null}

      {showEditor ? (
        <EntityDrawer
          closeHref={listHref || "/datasets"}
          title={editingRow ? "Dataset 详情" : "新建 Dataset"}
          headerActions={
            editingRow ? (
              <Link href={`/datasets/${editingRow.id}`} className="icon-btn" aria-label="打开 DataItems 页">
                <OpenInNewIcon width={16} height={16} />
              </Link>
            ) : null
          }
        >
          <form
            id={editingRow ? `dataset-form-${editingRow.id}` : "dataset-form-create"}
            action={editingRow ? updateDataset : createDataset}
            className="menu-form form-tone-green"
          >
            {editingRow ? <input type="hidden" name="id" value={editingRow.id} /> : null}
            <input type="hidden" name="q" value={queryText} />
            <input type="hidden" name="minItems" value={minItems} />
            <input type="hidden" name="updatedIn" value={updatedIn} />
            <FormField title="Dataset 名称" typeLabel="String" required>
              <input name="name" placeholder="Dataset 名称" required defaultValue={editingRow?.name ?? ""} />
            </FormField>
            <FormField title="描述" typeLabel="Optional">
              <textarea name="description" placeholder="描述" defaultValue={editingRow?.description ?? ""} />
            </FormField>
          </form>
          <div className="drawer-actions">
            <SubmitButton
              form={editingRow ? `dataset-form-${editingRow.id}` : "dataset-form-create"}
              className="primary-btn"
              pendingText={editingRow ? "更新中..." : "创建中..."}
            >
              {editingRow ? "更新" : "创建"}
            </SubmitButton>
            {editingRow ? (
              <form action={deleteDataset} className="drawer-inline-form">
                <input type="hidden" name="id" value={editingRow.id} />
                <SubmitButton className="danger-btn" pendingText="删除中...">
                  删除
                </SubmitButton>
              </form>
            ) : null}
            <Link href={listHref || "/datasets"} className="ghost-btn">
              取消
            </Link>
          </div>
        </EntityDrawer>
      ) : null}
    </div>
  );
}
