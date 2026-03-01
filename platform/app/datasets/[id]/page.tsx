import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { dbQuery } from "@/lib/db";
import { formatDateTime } from "@/lib/datetime";
import { PaginationControls } from "@/app/components/pagination-controls";
import { BulkSelectionControls } from "@/app/components/bulk-selection-controls";
import { clampPage, getOffset, parsePage, parsePageSize } from "@/lib/pagination";
import { parseSelectedIds } from "@/lib/form-ids";
import { parseJsonOrWrap } from "@/lib/safe-json";
import { requireUser } from "@/lib/supabase-auth";
import {
  ArrowLeftIcon,
  DatasetIcon,
  FilterIcon,
  PlusIcon,
  RefreshIcon,
  UserIcon
} from "@/app/components/icons";
import { SubmitButton } from "@/app/components/submit-button";
import { EntityDrawer } from "@/app/components/entity-drawer";
import { FormField } from "@/app/components/form-field";
import { ExpandableTextCell } from "@/app/components/expandable-text-cell";
import { TextareaWithFileUpload } from "@/app/components/textarea-with-file-upload";

function buildDetailHref(id: number, q: string, page: number, pageSize: number, extras?: Record<string, string>) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 10) params.set("pageSize", String(pageSize));
  for (const [key, value] of Object.entries(extras ?? {})) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `/datasets/${id}?${qs}` : `/datasets/${id}`;
}

async function createItem(formData: FormData) {
  "use server";
  const user = await requireUser();

  const datasetIdRaw = String(formData.get("datasetId") ?? "").trim();
  const datasetId = Number(datasetIdRaw);
  const sessionJsonl = String(formData.get("sessionJsonl") ?? "").trim();
  const userInput = String(formData.get("userInput") ?? "").trim();
  const referenceOutputRaw = String(formData.get("referenceOutput") ?? "").trim();
  const q = String(formData.get("q") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));

  if (!datasetIdRaw || !Number.isInteger(datasetId) || datasetId <= 0 || !userInput) return;

  const referenceOutput = referenceOutputRaw ? parseJsonOrWrap(referenceOutputRaw) : {};

  await dbQuery(
    `INSERT INTO data_items (
      dataset_id, session_jsonl, user_input, reference_output, mock_config, created_by, updated_by, updated_at
    )
    SELECT $1,$2,$3,$4,$5,$6,$6,CURRENT_TIMESTAMP
    FROM datasets d
    WHERE d.id = $1 AND d.deleted_at IS NULL`,
    [
      datasetId,
      sessionJsonl || "",
      userInput,
      JSON.stringify(referenceOutput),
      JSON.stringify({}),
      user.id
    ]
  );

  await dbQuery(`UPDATE datasets SET updated_at = CURRENT_TIMESTAMP, updated_by = $2 WHERE id = $1 AND deleted_at IS NULL`, [datasetId, user.id]);

  revalidatePath(`/datasets/${datasetId}`);
  revalidatePath("/datasets");

  redirect(buildDetailHref(datasetId, q, page, pageSize));
}

async function deleteItem(formData: FormData) {
  "use server";
  const user = await requireUser();

  const idRaw = String(formData.get("id") ?? "").trim();
  const datasetIdRaw = String(formData.get("datasetId") ?? "").trim();
  const id = Number(idRaw);
  const datasetId = Number(datasetIdRaw);
  const q = String(formData.get("q") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));
  if (!idRaw || !datasetIdRaw || !Number.isInteger(id) || id <= 0 || !Number.isInteger(datasetId) || datasetId <= 0) return;
  await softDeleteDataItemById(id, datasetId, user.id);
  revalidatePath(`/datasets/${datasetId}`);
  revalidatePath("/datasets");
  redirect(buildDetailHref(datasetId, q, page, pageSize));
}

async function softDeleteDataItemById(id: number, datasetId: number, userId: string) {
  await dbQuery(
    `UPDATE data_items
     SET is_deleted = TRUE,
         deleted_at = CURRENT_TIMESTAMP,
         updated_by = $2,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND deleted_at IS NULL`,
    [id, userId]
  );
  await dbQuery(`UPDATE datasets SET updated_at = CURRENT_TIMESTAMP, updated_by = $2 WHERE id = $1 AND deleted_at IS NULL`, [datasetId, userId]);
}

async function bulkDeleteItem(formData: FormData) {
  "use server";
  const user = await requireUser();

  const datasetIdRaw = String(formData.get("datasetId") ?? "").trim();
  const datasetId = Number(datasetIdRaw);
  const ids = parseSelectedIds(formData);
  const q = String(formData.get("q") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));
  if (!datasetIdRaw || !Number.isInteger(datasetId) || datasetId <= 0 || ids.length <= 0) return;

  for (const id of ids) {
    await softDeleteDataItemById(id, datasetId, user.id);
  }
  revalidatePath(`/datasets/${datasetId}`);
  revalidatePath("/datasets");
  redirect(buildDetailHref(datasetId, q, page, pageSize));
}

async function updateItem(formData: FormData) {
  "use server";
  const user = await requireUser();

  const datasetIdRaw = String(formData.get("datasetId") ?? "").trim();
  const itemIdRaw = String(formData.get("itemId") ?? "").trim();
  const datasetId = Number(datasetIdRaw);
  const itemId = Number(itemIdRaw);
  const sessionJsonl = String(formData.get("sessionJsonl") ?? "").trim();
  const userInput = String(formData.get("userInput") ?? "").trim();
  const referenceOutputRaw = String(formData.get("referenceOutput") ?? "").trim();
  const q = String(formData.get("q") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));

  if (!datasetIdRaw || !itemIdRaw || !Number.isInteger(datasetId) || datasetId <= 0 || !Number.isInteger(itemId) || itemId <= 0 || !userInput) return;

  const referenceOutput = referenceOutputRaw ? parseJsonOrWrap(referenceOutputRaw) : {};

  await dbQuery(
    `UPDATE data_items
     SET session_jsonl = $3,
         user_input = $4,
         reference_output = $5,
         updated_by = $6,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND dataset_id = $2 AND deleted_at IS NULL`,
    [
      itemId,
      datasetId,
      sessionJsonl || "",
      userInput,
      JSON.stringify(referenceOutput),
      user.id
    ]
  );

  await dbQuery(`UPDATE datasets SET updated_at = CURRENT_TIMESTAMP, updated_by = $2 WHERE id = $1 AND deleted_at IS NULL`, [datasetId, user.id]);

  revalidatePath(`/datasets/${datasetId}`);
  revalidatePath("/datasets");

  redirect(buildDetailHref(datasetId, q, page, pageSize));
}

export default async function DatasetDetailPage({
  params,
  searchParams
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; add?: string; edit?: string; page?: string; pageSize?: string }>;
}) {
  await requireUser();

  const { id: idParam } = await params;
  const id = Number(idParam.trim());
  const { q = "", add = "0", edit = "", page: pageRaw, pageSize: pageSizeRaw } = await searchParams;
  const qv = q.trim();
  const pageSize = parsePageSize(pageSizeRaw);
  const requestedPage = parsePage(pageRaw);
  const adding = add === "1";
  const editId = edit.trim() ? Number(edit.trim()) : 0;

  if (!Number.isInteger(id) || id <= 0) {
    return <section className="card">评测集不存在</section>;
  }

  const ds = await dbQuery<{
    id: number;
    name: string;
    description: string;
    created_at: string;
    updated_at: string;
    created_by: string;
  }>(
    `SELECT id, name, description, created_at, updated_at, created_by FROM datasets WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );

  if (ds.rowCount === 0) {
    return <section className="card">评测集不存在</section>;
  }

  const [countResult, editingItemResult] = await Promise.all([
    dbQuery<{ total_count: number | string }>(
      `SELECT COUNT(*) AS total_count
       FROM data_items
       WHERE dataset_id = $1
         AND deleted_at IS NULL
         AND ($2 = '' OR LOWER(user_input) LIKE CONCAT('%', LOWER($3), '%'))`,
      [id, qv, qv]
    ),
    Number.isInteger(editId) && editId > 0
      ? dbQuery<{
          id: number;
          session_jsonl: string;
          user_input: string;
          reference_output: unknown;
          updated_at: string;
          created_at: string;
        }>(
          `SELECT id, session_jsonl, user_input, reference_output, updated_at, created_at
           FROM data_items
           WHERE id = $1 AND dataset_id = $2 AND deleted_at IS NULL
           LIMIT 1`,
          [editId, id]
        )
      : Promise.resolve({ rows: [], rowCount: 0 } as { rows: Array<{ id: number; session_jsonl: string; user_input: string; reference_output: unknown; updated_at: string; created_at: string }>; rowCount: number })
  ]);

  const total = Number(countResult.rows[0]?.total_count ?? 0);
  const page = clampPage(requestedPage, total, pageSize);
  const offset = getOffset(page, pageSize);
  const items = await dbQuery<{
      id: number;
      session_jsonl: string;
      user_input: string;
      reference_output: unknown;
      updated_at: string;
      created_at: string;
    }>(
      `SELECT id, session_jsonl, user_input, reference_output, updated_at, created_at
       FROM data_items
       WHERE dataset_id = $1
         AND deleted_at IS NULL
         AND ($2 = '' OR LOWER(user_input) LIKE CONCAT('%', LOWER($3), '%'))
       ORDER BY updated_at DESC
       LIMIT $4 OFFSET $5`,
    [id, qv, qv, pageSize, offset]
  );

  const dataset = ds.rows[0];
  const baseHref = buildDetailHref(id, qv, page, pageSize);
  const editingItem = editingItemResult.rowCount > 0 ? editingItemResult.rows[0] : undefined;
  const showingEditor = adding || Boolean(editingItem);
  const itemEditorFormId = editingItem ? `item-editor-${editingItem.id}` : "item-editor-create";
  const paginationQuery = { q: qv };
  const bulkDeleteFormId = "dataitem-bulk-delete-form";

  return (
    <>
      <div className="grid">
        <section className="page-hero">
          <div className="breadcrumb">评测 &nbsp;/&nbsp; 评测集 &nbsp;/&nbsp; {dataset.name}</div>
        </section>

        <section className="detail-head refined">
          <div className="detail-main-title">
            <Link href="/datasets" className="icon-btn" aria-label="返回">
              <ArrowLeftIcon width={16} height={16} />
            </Link>
            <div>
              <h1>{dataset.name}</h1>
            </div>
          </div>
          <div className="meta-pills">
            <span className="meta-pill">描述: {dataset.description || "-"}</span>
            <span className="meta-pill">更新时间: {formatDateTime(dataset.updated_at)}</span>
            <span className="meta-pill">创建时间: {formatDateTime(dataset.created_at)}</span>
            <span className="meta-pill">
              <UserIcon width={14} height={14} /> <span title={dataset.created_by}>{dataset.created_by.slice(0, 8)}</span>
            </span>
          </div>
        </section>

        <section className="card">
          <div className="section-title-row data-toolbar">
            <h2>
              <DatasetIcon width={16} height={16} /> DataItems
            </h2>
            <div className="action-group">
              <form action={`/datasets/${id}`} className="search-form compact">
                <input type="hidden" name="pageSize" value={pageSize} />
                <label className="input-icon-wrap compact">
                  <FilterIcon width={14} height={14} />
                  <input name="q" defaultValue={qv} placeholder="搜索 DataItems" />
                </label>
                <button type="submit" className="ghost-btn small">
                  筛选
                </button>
              </form>
              <BulkSelectionControls formId={bulkDeleteFormId} variant="compact" confirmText="确认批量删除已选 {count} 条 DataItem 吗？" />
              <PaginationControls basePath={`/datasets/${id}`} query={paginationQuery} total={total} page={page} pageSize={pageSize} position="top" variant="compact" />
              <a href={baseHref} className="icon-btn" aria-label="刷新">
                <RefreshIcon width={16} height={16} />
              </a>
              <Link
                href={buildDetailHref(id, qv, page, pageSize, { add: "1" })}
                className="primary-btn"
              >
                <PlusIcon width={16} height={16} /> 添加数据
              </Link>
            </div>
          </div>

          <div className="table-card" style={{ marginTop: 12 }}>
            <form id={bulkDeleteFormId} action={bulkDeleteItem}>
              <input type="hidden" name="datasetId" value={id} />
              <input type="hidden" name="q" value={qv} />
              <input type="hidden" name="page" value={page} />
              <input type="hidden" name="pageSize" value={pageSize} />
            </form>
            <table className="data-items-table">
              <thead>
                <tr>
                  <th className="bulk-select-cell">选</th>
                  <th>ID</th>
                  <th>input</th>
                  <th>session_jsonl</th>
                  <th>reference_output</th>
                  <th>更新时间</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.rows.map((item) => (
                  <tr key={item.id}>
                    <td className="bulk-select-cell">
                      <input type="checkbox" name="selectedIds" value={item.id} form={bulkDeleteFormId} aria-label={`选择 DataItem ${item.id}`} />
                    </td>
                    <td>
                      <code>{item.id}</code>
                    </td>
                    <td className="muted">
                      <ExpandableTextCell value={item.user_input} previewLength={80} className="muted" />
                    </td>
                    <td className="muted">
                      <ExpandableTextCell value={item.session_jsonl} previewLength={80} className="muted" />
                    </td>
                    <td className="muted">
                      <ExpandableTextCell value={item.reference_output} previewLength={90} className="muted" />
                    </td>
                    <td>{formatDateTime(item.updated_at)}</td>
                    <td>{formatDateTime(item.created_at)}</td>
                    <td>
                      <div className="row-actions">
                        <Link
                          href={buildDetailHref(id, qv, page, pageSize, { edit: String(item.id) })}
                          className="text-btn"
                        >
                          更新
                        </Link>
                        <form action={deleteItem}>
                          <input type="hidden" name="id" value={item.id} />
                          <input type="hidden" name="datasetId" value={id} />
                          <input type="hidden" name="q" value={qv} />
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
          </div>
          <BulkSelectionControls formId={bulkDeleteFormId} variant="full" confirmText="确认批量删除已选 {count} 条 DataItem 吗？" />
          <PaginationControls basePath={`/datasets/${id}`} query={paginationQuery} total={total} page={page} pageSize={pageSize} position="bottom" />
        </section>
      </div>

      {showingEditor ? (
        <EntityDrawer closeHref={baseHref} title={editingItem ? "数据详情" : "添加数据"} drawerClassName="wide">
          <form id={itemEditorFormId} action={editingItem ? updateItem : createItem} className="drawer-form form-tone-green">
            <input type="hidden" name="datasetId" value={id} />
            <input type="hidden" name="q" value={qv} />
            <input type="hidden" name="page" value={page} />
            <input type="hidden" name="pageSize" value={pageSize} />
            {editingItem ? <input type="hidden" name="itemId" value={editingItem.id} /> : null}

            <FormField title="input" typeLabel="String" required>
              <TextareaWithFileUpload
                name="userInput"
                placeholder="用户目标（user_input）"
                required
                defaultValue={editingItem?.user_input ?? ""}
                accept=".txt,.md,.json"
              />
            </FormField>

            <FormField title="session_jsonl" typeLabel="Optional">
              <TextareaWithFileUpload
                name="sessionJsonl"
                placeholder="会话历史 jsonl（每行一个 JSON）"
                defaultValue={editingItem?.session_jsonl ?? ""}
                accept=".jsonl,.txt,.json"
                hint="支持粘贴或上传 .jsonl 文件"
              />
            </FormField>

            <FormField title="reference_output" typeLabel="Optional">
              <TextareaWithFileUpload
                name="referenceOutput"
                placeholder='例如 {"result":"success"}'
                defaultValue={
                  editingItem?.reference_output
                    ? typeof editingItem.reference_output === "string"
                      ? editingItem.reference_output
                      : JSON.stringify(editingItem.reference_output, null, 2)
                    : "{}"
                }
                accept=".json,.txt"
              />
            </FormField>
          </form>
          <div className="drawer-actions">
            <SubmitButton
              form={itemEditorFormId}
              className="primary-btn"
              pendingText={editingItem ? "更新中..." : "添加中..."}
            >
              {editingItem ? "更新" : "添加"}
            </SubmitButton>
            {editingItem ? (
              <form action={deleteItem} className="drawer-inline-form">
                <input type="hidden" name="id" value={editingItem.id} />
                <input type="hidden" name="datasetId" value={id} />
                <SubmitButton className="danger-btn" pendingText="删除中...">
                  删除
                </SubmitButton>
              </form>
            ) : null}
            <Link href={baseHref} className="ghost-btn">
              取消
            </Link>
          </div>
        </EntityDrawer>
      ) : null}
    </>
  );
}
