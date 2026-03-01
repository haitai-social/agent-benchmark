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
import { DatasetIcon, FilterIcon, OpenInNewIcon, PlusIcon, SearchIcon } from "../components/icons";
import { SubmitButton } from "../components/submit-button";
import { EntityDrawer } from "../components/entity-drawer";
import { FormField } from "../components/form-field";

function buildListHref(q: string, minItems: string, updatedIn: string, page: number, pageSize: number) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (minItems !== "all") params.set("minItems", minItems);
  if (updatedIn !== "all") params.set("updatedIn", updatedIn);
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 10) params.set("pageSize", String(pageSize));
  return params.size > 0 ? `/datasets?${params.toString()}` : "/datasets";
}

async function createDataset(formData: FormData) {
  "use server";
  const user = await requireUser();

  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const q = String(formData.get("q") ?? "").trim();
  const minItems = String(formData.get("minItems") ?? "all").trim() || "all";
  const updatedIn = String(formData.get("updatedIn") ?? "all").trim() || "all";
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));
  if (!name) return;
  await dbQuery(
    `INSERT INTO datasets (name, description, created_by, updated_by, updated_at)
     SELECT $1, $2, $3, $3, CURRENT_TIMESTAMP
     WHERE NOT EXISTS (SELECT 1 FROM datasets WHERE name = $4 AND deleted_at IS NULL)`,
    [name, description, user.id, name]
  );
  revalidatePath("/datasets");
  redirect(buildListHref(q, minItems, updatedIn, page, pageSize));
}

async function deleteDataset(formData: FormData) {
  "use server";
  const user = await requireUser();

  const idRaw = String(formData.get("id") ?? "").trim();
  const id = Number(idRaw);
  const q = String(formData.get("q") ?? "").trim();
  const minItems = String(formData.get("minItems") ?? "all").trim() || "all";
  const updatedIn = String(formData.get("updatedIn") ?? "all").trim() || "all";
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));
  if (!idRaw || !Number.isInteger(id) || id <= 0) return;
  await softDeleteDatasetById(id, user.id);
  revalidatePath("/datasets");
  revalidatePath("/experiments");
  redirect(buildListHref(q, minItems, updatedIn, page, pageSize));
}

async function softDeleteDatasetById(id: number, userId: string) {
  await dbQuery(
    `UPDATE datasets
     SET is_deleted = TRUE,
         deleted_at = CURRENT_TIMESTAMP,
         updated_by = $2,
         updated_at = CURRENT_TIMESTAMP,
         name = CONCAT(name, '__deleted__', id)
     WHERE id = $1 AND deleted_at IS NULL`,
    [id, userId]
  );
  await dbQuery(
    `UPDATE data_items
     SET is_deleted = TRUE,
         deleted_at = CURRENT_TIMESTAMP,
         updated_by = $2,
         updated_at = CURRENT_TIMESTAMP
     WHERE dataset_id = $1 AND deleted_at IS NULL`,
    [id, userId]
  );
  await dbQuery(
    `UPDATE experiments
     SET is_deleted = TRUE,
         deleted_at = CURRENT_TIMESTAMP,
         updated_by = $2,
         updated_at = CURRENT_TIMESTAMP
     WHERE dataset_id = $1 AND deleted_at IS NULL`,
    [id, userId]
  );
}

async function bulkDeleteDataset(formData: FormData) {
  "use server";
  const user = await requireUser();

  const ids = parseSelectedIds(formData);
  const q = String(formData.get("q") ?? "").trim();
  const minItems = String(formData.get("minItems") ?? "all").trim() || "all";
  const updatedIn = String(formData.get("updatedIn") ?? "all").trim() || "all";
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));
  if (ids.length <= 0) return;

  for (const id of ids) {
    await softDeleteDatasetById(id, user.id);
  }
  revalidatePath("/datasets");
  revalidatePath("/experiments");
  redirect(buildListHref(q, minItems, updatedIn, page, pageSize));
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
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));
  if (!idRaw || !Number.isInteger(id) || id <= 0 || !name) return;
  await dbQuery(
    `UPDATE datasets
     SET name = $2, description = $3, updated_by = $4, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
       AND deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM datasets d2
         WHERE d2.name = $2
           AND d2.id <> $1
           AND d2.deleted_at IS NULL
       )`,
    [id, name, description, user.id]
  );
  revalidatePath("/datasets");
  redirect(buildListHref(q, minItems, updatedIn, page, pageSize));
}

export default async function DatasetsPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; panel?: string; minItems?: string; updatedIn?: string; id?: string; page?: string; pageSize?: string }>;
}) {
  await requireUser();

  const { q = "", panel = "none", minItems = "all", updatedIn = "all", id = "", page: pageRaw, pageSize: pageSizeRaw } = await searchParams;
  const queryText = q.trim();
  const pageSize = parsePageSize(pageSizeRaw);
  const requestedPage = parsePage(pageRaw);
  const creating = panel === "create";
  const filtering = panel === "filter";
  const editingId = Number(id.trim());

  const minItemsValue = minItems === "all" ? null : Number(minItems);
  const minItemsFilter =
    typeof minItemsValue === "number" && Number.isFinite(minItemsValue) && minItemsValue >= 0 ? minItemsValue : null;
  const updatedWindow = updatedIn === "7d" ? 7 : updatedIn === "30d" ? 30 : null;
  const updatedAfter = updatedWindow ? new Date(Date.now() - updatedWindow * 24 * 60 * 60 * 1000).toISOString() : null;

  const filterParams = [queryText, queryText, updatedAfter, updatedAfter, minItemsFilter, minItemsFilter];
  const [countResult, editing] = await Promise.all([
    dbQuery<{ total_count: number | string }>(
      `SELECT COUNT(*) AS total_count
       FROM (
         SELECT d.id
         FROM datasets d
         LEFT JOIN data_items i ON i.dataset_id = d.id AND i.deleted_at IS NULL
         WHERE ($1 = '' OR LOWER(d.name) LIKE CONCAT('%', LOWER($2), '%'))
           AND d.deleted_at IS NULL
           AND ($3 IS NULL OR d.updated_at >= $4)
         GROUP BY d.id
         HAVING ($5 IS NULL OR COUNT(i.id) >= $6)
       ) grouped_rows`,
      filterParams
    ),
    Number.isInteger(editingId) && editingId > 0
      ? dbQuery<{ id: number; name: string; description: string }>(
          `SELECT id, name, description FROM datasets WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
          [editingId]
        )
      : Promise.resolve({ rows: [], rowCount: 0 } as { rows: Array<{ id: number; name: string; description: string }>; rowCount: number })
  ]);
  const total = Number(countResult.rows[0]?.total_count ?? 0);
  const page = clampPage(requestedPage, total, pageSize);
  const offset = getOffset(page, pageSize);
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
     ORDER BY d.updated_at DESC
     LIMIT $7 OFFSET $8`,
    [...filterParams, pageSize, offset]
  );

  const listHref = buildListHref(queryText, minItems, updatedIn, page, pageSize);
  const createHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=create`;
  const filterHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=filter`;
  const hasFilter = minItems !== "all" || updatedIn !== "all";
  const editingRow = editing.rowCount > 0 ? editing.rows[0] : null;
  const paginationQuery = {
    q: queryText,
    minItems: minItems === "all" ? "" : minItems,
    updatedIn: updatedIn === "all" ? "" : updatedIn
  };
  const resetHref = buildListHref(queryText, "all", "all", 1, pageSize);
  const showEditor = creating || Boolean(editingRow);
  const bulkDeleteFormId = "dataset-bulk-delete-form";

  return (
    <div className="grid">
      <section className="page-hero">
        <div className="breadcrumb">评测 &nbsp;/&nbsp; Datasets</div>
        <h1>Datasets</h1>
      </section>

      <section className="toolbar-row">
        <form action="/datasets" className="search-form">
          <input type="hidden" name="minItems" value={minItems} />
          <input type="hidden" name="updatedIn" value={updatedIn} />
          <input type="hidden" name="pageSize" value={pageSize} />
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
          <BulkSelectionControls formId={bulkDeleteFormId} variant="compact" confirmText="确认批量删除已选 {count} 条 Dataset 吗？" />
          <PaginationControls basePath="/datasets" query={paginationQuery} total={total} page={page} pageSize={pageSize} position="top" variant="compact" />
        </div>
      </section>

      {hasFilter ? (
        <section className="active-filters">
          <span className="muted">当前筛选:</span>
          {minItems !== "all" ? <span className="filter-pill">{`DataItems >= ${minItems}`}</span> : null}
          {updatedIn !== "all" ? <span className="filter-pill">{`更新时间: ${updatedIn}`}</span> : null}
          <Link href={resetHref} className="text-btn">
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
        <form id={bulkDeleteFormId} action={bulkDeleteDataset}>
          <input type="hidden" name="q" value={queryText} />
          <input type="hidden" name="minItems" value={minItems} />
          <input type="hidden" name="updatedIn" value={updatedIn} />
          <input type="hidden" name="page" value={page} />
          <input type="hidden" name="pageSize" value={pageSize} />
        </form>
        <table className="datasets-table">
          <thead>
            <tr>
              <th className="bulk-select-cell">选</th>
              <th>ID</th>
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
                <td className="bulk-select-cell">
                  <input type="checkbox" name="selectedIds" value={row.id} form={bulkDeleteFormId} aria-label={`选择 Dataset ${row.id}`} />
                </td>
                <td><code>#{row.id}</code></td>
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
                <td title={row.updated_by}>{row.updated_by.slice(0, 8)}</td>
                <td>{formatDateTime(row.updated_at)}</td>
                <td>
                  <div className="row-actions">
                    <Link href={`/datasets/${row.id}`} className="text-btn">
                      详情
                    </Link>
                    <Link href={`${listHref}${listHref.includes("?") ? "&" : "?"}id=${row.id}`} className="text-btn">
                      更新
                    </Link>
                    <form action={deleteDataset}>
                      <input type="hidden" name="id" value={row.id} />
                      <input type="hidden" name="q" value={queryText} />
                      <input type="hidden" name="minItems" value={minItems} />
                      <input type="hidden" name="updatedIn" value={updatedIn} />
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
        <BulkSelectionControls formId={bulkDeleteFormId} variant="full" confirmText="确认批量删除已选 {count} 条 Dataset 吗？" />
        <PaginationControls basePath="/datasets" query={paginationQuery} total={total} page={page} pageSize={pageSize} position="bottom" />
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
                <input type="hidden" name="pageSize" value={pageSize} />
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
                <Link href={resetHref} className="ghost-btn">
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
            <input type="hidden" name="page" value={page} />
            <input type="hidden" name="pageSize" value={pageSize} />
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
                <input type="hidden" name="q" value={queryText} />
                <input type="hidden" name="minItems" value={minItems} />
                <input type="hidden" name="updatedIn" value={updatedIn} />
                <input type="hidden" name="page" value={page} />
                <input type="hidden" name="pageSize" value={pageSize} />
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
