import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { dbQuery } from "@/lib/db";
import { parseJsonOrWrap } from "@/lib/safe-json";
import { requireUser } from "@/lib/supabase-auth";
import {
  ArrowLeftIcon,
  DatasetIcon,
  FilterIcon,
  PlusIcon,
  RefreshIcon,
  TraceIcon,
  UserIcon
} from "@/app/components/icons";
import { SubmitButton } from "@/app/components/submit-button";

async function createItem(formData: FormData) {
  "use server";
  const user = await requireUser();

  const datasetIdRaw = String(formData.get("datasetId") ?? "").trim();
  const snapshotIdRaw = String(formData.get("snapshotId") ?? "").trim();
  const datasetId = Number(datasetIdRaw);
  const snapshotId = Number(snapshotIdRaw);
  const userInput = String(formData.get("userInput") ?? "").trim();
  const traceId = String(formData.get("traceId") ?? "").trim();
  const agentOutput = String(formData.get("agentOutput") ?? "{}");
  const q = String(formData.get("q") ?? "").trim();

  if (!datasetIdRaw || !snapshotIdRaw || !Number.isInteger(datasetId) || datasetId <= 0 || !userInput || !Number.isInteger(snapshotId) || snapshotId <= 0) return;

  let finalTrajectory: unknown = null;
  if (traceId) {
    const traceRows = await dbQuery<{ raw: unknown }>(
      `SELECT raw FROM traces WHERE trace_id = $1 ORDER BY id ASC LIMIT 500`,
      [traceId]
    );
    finalTrajectory = traceRows.rows.length > 0 ? traceRows.rows.map((r) => r.raw) : [{ trace_id: traceId }];
  }

  const snapshot = await dbQuery<{ payload: unknown }>(`SELECT payload FROM snapshot_presets WHERE id = $1`, [snapshotId]);
  const finalEnvironmentSnapshot = snapshot.rows.length > 0 ? snapshot.rows[0].payload : {};

  await dbQuery(
    `INSERT INTO data_items (
      dataset_id, environment_snapshot, user_input, agent_trajectory, agent_output, trace_id, snapshot_id, created_by, updated_by, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,CURRENT_TIMESTAMP)`,
    [
      datasetId,
      JSON.stringify(finalEnvironmentSnapshot),
      userInput,
      JSON.stringify(finalTrajectory),
      JSON.stringify(parseJsonOrWrap(agentOutput)),
      traceId || null,
      snapshotId,
      user.id
    ]
  );

  await dbQuery(`UPDATE datasets SET updated_at = CURRENT_TIMESTAMP, updated_by = $2 WHERE id = $1`, [datasetId, user.id]);

  revalidatePath(`/datasets/${datasetId}`);
  revalidatePath("/datasets");

  redirect(q ? `/datasets/${datasetId}?q=${encodeURIComponent(q)}` : `/datasets/${datasetId}`);
}

async function deleteItem(formData: FormData) {
  "use server";
  const user = await requireUser();

  const idRaw = String(formData.get("id") ?? "").trim();
  const datasetIdRaw = String(formData.get("datasetId") ?? "").trim();
  const id = Number(idRaw);
  const datasetId = Number(datasetIdRaw);
  if (!idRaw || !datasetIdRaw || !Number.isInteger(id) || id <= 0 || !Number.isInteger(datasetId) || datasetId <= 0) return;
  await dbQuery(`DELETE FROM data_items WHERE id = $1`, [id]);
  await dbQuery(`UPDATE datasets SET updated_at = CURRENT_TIMESTAMP, updated_by = $2 WHERE id = $1`, [datasetId, user.id]);
  revalidatePath(`/datasets/${datasetId}`);
  revalidatePath("/datasets");
}

async function updateItem(formData: FormData) {
  "use server";
  const user = await requireUser();

  const datasetIdRaw = String(formData.get("datasetId") ?? "").trim();
  const itemIdRaw = String(formData.get("itemId") ?? "").trim();
  const snapshotIdRaw = String(formData.get("snapshotId") ?? "").trim();
  const datasetId = Number(datasetIdRaw);
  const itemId = Number(itemIdRaw);
  const snapshotId = Number(snapshotIdRaw);
  const userInput = String(formData.get("userInput") ?? "").trim();
  const traceId = String(formData.get("traceId") ?? "").trim();
  const agentOutput = String(formData.get("agentOutput") ?? "{}");
  const q = String(formData.get("q") ?? "").trim();

  if (!datasetIdRaw || !itemIdRaw || !snapshotIdRaw || !Number.isInteger(datasetId) || datasetId <= 0 || !Number.isInteger(itemId) || itemId <= 0 || !userInput || !Number.isInteger(snapshotId) || snapshotId <= 0) return;

  let finalTrajectory: unknown = null;
  if (traceId) {
    const traceRows = await dbQuery<{ raw: unknown }>(
      `SELECT raw FROM traces WHERE trace_id = $1 ORDER BY id ASC LIMIT 500`,
      [traceId]
    );
    finalTrajectory = traceRows.rows.length > 0 ? traceRows.rows.map((r) => r.raw) : [{ trace_id: traceId }];
  }

  const snapshot = await dbQuery<{ payload: unknown }>(`SELECT payload FROM snapshot_presets WHERE id = $1`, [snapshotId]);
  const finalEnvironmentSnapshot = snapshot.rows.length > 0 ? snapshot.rows[0].payload : {};

  await dbQuery(
    `UPDATE data_items
     SET environment_snapshot = $3,
         user_input = $4,
         agent_trajectory = $5,
         agent_output = $6,
         trace_id = $7,
         snapshot_id = $8,
         updated_by = $9,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND dataset_id = $2`,
    [
      itemId,
      datasetId,
      JSON.stringify(finalEnvironmentSnapshot),
      userInput,
      JSON.stringify(finalTrajectory),
      JSON.stringify(parseJsonOrWrap(agentOutput)),
      traceId || null,
      snapshotId,
      user.id
    ]
  );

  await dbQuery(`UPDATE datasets SET updated_at = CURRENT_TIMESTAMP, updated_by = $2 WHERE id = $1`, [datasetId, user.id]);

  revalidatePath(`/datasets/${datasetId}`);
  revalidatePath("/datasets");

  redirect(q ? `/datasets/${datasetId}?q=${encodeURIComponent(q)}` : `/datasets/${datasetId}`);
}

export default async function DatasetDetailPage({
  params,
  searchParams
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; add?: string; edit?: string }>;
}) {
  await requireUser();

  const { id: idParam } = await params;
  const id = Number(idParam.trim());
  const { q = "", add = "0", edit = "" } = await searchParams;
  const qv = q.trim();
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
    `SELECT id, name, description, created_at, updated_at, created_by FROM datasets WHERE id = $1`,
    [id]
  );

  if (ds.rowCount === 0) {
    return <section className="card">评测集不存在</section>;
  }

  const [items, traceIds, snapshotPresets] = await Promise.all([
    dbQuery<{
      id: number;
      user_input: string;
      trace_id: string | null;
      snapshot_id: number | null;
      agent_trajectory: unknown;
      agent_output: unknown;
      updated_at: string;
      created_at: string;
    }>(
      `SELECT id, user_input, trace_id, snapshot_id, agent_trajectory, agent_output, updated_at, created_at
       FROM data_items
       WHERE dataset_id = $1 AND ($2 = '' OR LOWER(user_input) LIKE CONCAT('%', LOWER($3), '%'))
       ORDER BY updated_at DESC`,
      [id, qv, qv]
    ),
    dbQuery<{ trace_id: string }>(
      `SELECT trace_id FROM traces WHERE trace_id IS NOT NULL AND trace_id <> '' GROUP BY trace_id ORDER BY MAX(id) DESC LIMIT 200`
    ),
    dbQuery<{ id: number; name: string }>(
      `SELECT id, name FROM snapshot_presets ORDER BY created_at ASC`
    )
  ]);

  const dataset = ds.rows[0];
  const baseHref = qv ? `/datasets/${id}?q=${encodeURIComponent(qv)}` : `/datasets/${id}`;
  const editingItem = editId ? items.rows.find((item) => item.id === editId) : undefined;
  const showingEditor = adding || Boolean(editingItem);

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
              <p className="muted">评测集详情与数据项维护</p>
            </div>
          </div>
          <div className="meta-pills">
            <span className="meta-pill">描述: {dataset.description || "-"}</span>
            <span className="meta-pill">更新时间: {new Date(dataset.updated_at).toLocaleString()}</span>
            <span className="meta-pill">创建时间: {new Date(dataset.created_at).toLocaleString()}</span>
            <span className="meta-pill">
              <UserIcon width={14} height={14} /> {dataset.created_by.slice(0, 8)}
            </span>
          </div>
        </section>

        <section className="card">
          <div className="section-title-row data-toolbar">
            <h2>
              <DatasetIcon width={16} height={16} /> 数据项
            </h2>
            <div className="action-group">
              <form action={`/datasets/${id}`} className="search-form compact">
                <label className="input-icon-wrap compact">
                  <FilterIcon width={14} height={14} />
                  <input name="q" defaultValue={qv} placeholder="搜索数据项" />
                </label>
                <button type="submit" className="ghost-btn small">
                  筛选
                </button>
              </form>
              <a href={baseHref} className="icon-btn" aria-label="刷新">
                <RefreshIcon width={16} height={16} />
              </a>
              <Link
                href={qv ? `/datasets/${id}?q=${encodeURIComponent(qv)}&add=1` : `/datasets/${id}?add=1`}
                className="primary-btn"
              >
                <PlusIcon width={16} height={16} /> 添加数据
              </Link>
            </div>
          </div>

          <div className="table-card" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>input</th>
                  <th>reference_output</th>
                  <th>trajectory</th>
                  <th>更新时间</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.rows.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <code>{item.id}</code>
                    </td>
                    <td className="muted">{item.user_input.slice(0, 80)}</td>
                    <td className="muted">{JSON.stringify(item.agent_output).slice(0, 90)}...</td>
                    <td className="muted">
                      {item.trace_id ? <span className="tag">trace: {item.trace_id}</span> : null}
                      <div>{JSON.stringify(item.agent_trajectory).slice(0, 90)}...</div>
                    </td>
                    <td>{new Date(item.updated_at).toLocaleString()}</td>
                    <td>{new Date(item.created_at).toLocaleString()}</td>
                    <td>
                      <div className="row-actions">
                        <Link
                          href={
                            qv
                              ? `/datasets/${id}?q=${encodeURIComponent(qv)}&edit=${item.id}`
                              : `/datasets/${id}?edit=${item.id}`
                          }
                          className="text-btn"
                        >
                          详情
                        </Link>
                        <form action={deleteItem}>
                          <input type="hidden" name="id" value={item.id} />
                          <input type="hidden" name="datasetId" value={id} />
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
        </section>
      </div>

      {showingEditor ? (
        <div className="add-overlay">
          <Link href={baseHref} className="add-overlay-dismiss" aria-label="关闭抽屉蒙层" />
          <div className="add-drawer">
            <div className="add-drawer-header">
              <h3>{editingItem ? "数据详情" : "添加数据"}</h3>
              <Link href={baseHref} className="icon-btn" aria-label="关闭">
                <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
              </Link>
            </div>

            <div className="add-drawer-body">
              <aside className="item-side-list">
                <div className="item-side-title active">数据项 1</div>
              </aside>

              <section className="item-editor">
                <form action={editingItem ? updateItem : createItem} className="drawer-form">
                  <input type="hidden" name="datasetId" value={id} />
                  <input type="hidden" name="q" value={qv} />
                  {editingItem ? <input type="hidden" name="itemId" value={editingItem.id} /> : null}

                  <div className="field-group">
                    <label className="field-head">
                      <span className="field-title">input</span>
                      <span className="type-pill">String</span>
                    </label>
                    <textarea
                      name="userInput"
                      placeholder="用户目标（user-input）"
                      required
                      defaultValue={editingItem?.user_input ?? ""}
                    />
                  </div>

                  <div className="field-group">
                    <label className="field-head">
                      <span className="field-title">reference_output</span>
                      <span className="type-pill">String / JSON</span>
                    </label>
                    <textarea
                      name="agentOutput"
                      placeholder='例如 {"result":"success"}'
                      required
                      defaultValue={
                        editingItem?.agent_output
                          ? typeof editingItem.agent_output === "string"
                            ? editingItem.agent_output
                            : JSON.stringify(editingItem.agent_output, null, 2)
                          : ""
                      }
                    />
                  </div>

                  <div className="field-group">
                    <label className="field-head">
                      <span className="field-title">trajectory</span>
                      <span className="type-pill">轨迹</span>
                    </label>
                    <label className="trace-import-row">
                      <TraceIcon width={14} height={14} /> 选择 Trace ID（自动导入 trajectory）
                    </label>
                    <select name="traceId" defaultValue={editingItem?.trace_id ?? ""}>
                      <option value="">
                        不选择 trajectory（可选）
                      </option>
                      {traceIds.rows.map((t) => (
                        <option key={t.trace_id} value={t.trace_id}>
                          {t.trace_id}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="field-group">
                    <label className="field-head">
                      <span className="field-title">environment-snapshot</span>
                      <span className="type-pill">JSON</span>
                    </label>
                    <label className="trace-import-row">从预设快照表选择 snapshot_id</label>
                    <select name="snapshotId" required defaultValue={editingItem?.snapshot_id ?? ""}>
                      <option value="" disabled>
                        请选择 snapshot_id
                      </option>
                      {snapshotPresets.rows.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.id})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="drawer-actions">
                    <SubmitButton className="primary-btn" pendingText={editingItem ? "更新中..." : "添加中..."}>
                      {editingItem ? "更新" : "添加"}
                    </SubmitButton>
                    <Link href={baseHref} className="ghost-btn">
                      取消
                    </Link>
                  </div>
                </form>
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
