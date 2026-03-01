import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { dbQuery, engine, withTransaction } from "@/lib/db";
import { formatDateTime } from "@/lib/datetime";
import { PaginationControls } from "@/app/components/pagination-controls";
import { BulkSelectionControls } from "@/app/components/bulk-selection-controls";
import { clampPage, getOffset, parsePage, parsePageSize } from "@/lib/pagination";
import { parseSelectedIds } from "@/lib/form-ids";
import { requireUser } from "@/lib/supabase-auth";
import Link from "next/link";
import { FilterIcon, FlaskIcon, OpenInNewIcon, PlusIcon, SearchIcon } from "../components/icons";
import { SubmitButton } from "../components/submit-button";
import { EntityDrawer } from "../components/entity-drawer";
import { FormField } from "../components/form-field";

function buildListHref(q: string, status: string, datasetLike: string, agentLike: string, page: number, pageSize: number) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (status !== "all") params.set("status", status);
  if (datasetLike) params.set("datasetLike", datasetLike);
  if (agentLike) params.set("agentLike", agentLike);
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 10) params.set("pageSize", String(pageSize));
  return params.size > 0 ? `/experiments?${params.toString()}` : "/experiments";
}

function formatDuration(startedAt: string | null, finishedAt: string | null) {
  if (!startedAt || !finishedAt) return "-";
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "-";
  const seconds = Math.floor((end - start) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatLatencyMs(value: number | string | null) {
  if (value == null) return "-";
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

function parseEvaluatorIds(formData: FormData) {
  return Array.from(
    new Set(
      formData
        .getAll("evaluatorIds")
        .map((value) => Number(String(value).trim()))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

async function attachExperimentEvaluators(
  tx: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  experimentId: number,
  evaluatorIds: number[]
) {
  await tx.query(`DELETE FROM experiment_evaluators WHERE experiment_id = $1`, [experimentId]);
  for (const evaluatorId of evaluatorIds) {
    await tx.query(
      `INSERT INTO experiment_evaluators (experiment_id, evaluator_id, created_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)`,
      [experimentId, evaluatorId]
    );
  }
}

async function createExperiment(formData: FormData) {
  "use server";
  const user = await requireUser();

  const name = String(formData.get("name") ?? "").trim();
  const datasetIdRaw = String(formData.get("datasetId") ?? "").trim();
  const agentIdRaw = String(formData.get("agentId") ?? "").trim();
  const datasetId = Number(datasetIdRaw);
  const agentId = Number(agentIdRaw);
  const evaluatorIds = parseEvaluatorIds(formData);
  const q = String(formData.get("q") ?? "").trim();
  const status = String(formData.get("statusFilter") ?? "all").trim() || "all";
  const datasetLike = String(formData.get("datasetLike") ?? "").trim();
  const agentLike = String(formData.get("agentLike") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));

  if (!name || !datasetIdRaw || !agentIdRaw || !Number.isInteger(datasetId) || datasetId <= 0 || !Number.isInteger(agentId) || agentId <= 0 || evaluatorIds.length === 0) {
    return;
  }

  await withTransaction(async (tx) => {
    let experimentId = 0;
    if (engine === "mysql") {
      const inserted = await tx.query(
        `INSERT INTO experiments (name, dataset_id, agent_id, queue_status, created_by, updated_by)
         SELECT $1, $2, $3, 'idle', $4, $4
         FROM datasets d
         JOIN agents a ON a.id = $3
         WHERE d.id = $2
           AND d.deleted_at IS NULL
           AND a.deleted_at IS NULL`,
        [name, datasetId, agentId, user.id]
      );
      experimentId = Number((inserted as { insertId?: number }).insertId ?? 0);
    } else {
      const inserted = await tx.query<{ id: number }>(
        `INSERT INTO experiments (name, dataset_id, agent_id, queue_status, created_by, updated_by)
         SELECT $1, $2, $3, 'idle', $4, $4
         FROM datasets d
         JOIN agents a ON a.id = $3
         WHERE d.id = $2
           AND d.deleted_at IS NULL
           AND a.deleted_at IS NULL
         RETURNING id`,
        [name, datasetId, agentId, user.id]
      );
      experimentId = inserted.rows[0]?.id ?? 0;
    }

    if (!experimentId) {
      throw new Error("Failed to create experiment");
    }

    await attachExperimentEvaluators(tx, experimentId, evaluatorIds);
  });

  revalidatePath("/experiments");
  redirect(buildListHref(q, status, datasetLike, agentLike, page, pageSize));
}

async function updateExperiment(formData: FormData) {
  "use server";
  const user = await requireUser();

  const idRaw = String(formData.get("id") ?? "").trim();
  const id = Number(idRaw);
  const name = String(formData.get("name") ?? "").trim();
  const datasetIdRaw = String(formData.get("datasetId") ?? "").trim();
  const datasetId = Number(datasetIdRaw);
  const agentIdRaw = String(formData.get("agentId") ?? "").trim();
  const agentId = Number(agentIdRaw);
  const evaluatorIds = parseEvaluatorIds(formData);

  const q = String(formData.get("q") ?? "").trim();
  const status = String(formData.get("statusFilter") ?? "all").trim() || "all";
  const datasetLike = String(formData.get("datasetLike") ?? "").trim();
  const agentLike = String(formData.get("agentLike") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));

  if (!idRaw || !name || !datasetIdRaw || !agentIdRaw || !Number.isInteger(id) || id <= 0 || !Number.isInteger(datasetId) || datasetId <= 0 || !Number.isInteger(agentId) || agentId <= 0 || evaluatorIds.length === 0) {
    return;
  }

  await withTransaction(async (tx) => {
    const editable = await tx.query<{ id: number }>(
      `SELECT e.id
       FROM experiments e
       JOIN datasets d ON d.id = $2 AND d.deleted_at IS NULL
       JOIN agents a ON a.id = $3 AND a.deleted_at IS NULL
       WHERE e.id = $1
         AND e.deleted_at IS NULL
         AND e.queue_status = 'idle'
       LIMIT 1`,
      [id, datasetId, agentId]
    );

    if (editable.rowCount === 0) {
      return;
    }

    await tx.query(
      `UPDATE experiments
       SET name = $2, dataset_id = $3, agent_id = $4, updated_by = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND deleted_at IS NULL
         AND queue_status = 'idle'`,
      [id, name, datasetId, agentId, user.id]
    );

    await attachExperimentEvaluators(tx, id, evaluatorIds);
  });

  revalidatePath("/experiments");
  revalidatePath(`/experiments/${id}`);
  redirect(buildListHref(q, status, datasetLike, agentLike, page, pageSize));
}

async function deleteExperiment(formData: FormData) {
  "use server";
  const user = await requireUser();

  const idRaw = String(formData.get("id") ?? "").trim();
  const id = Number(idRaw);
  const q = String(formData.get("q") ?? "").trim();
  const status = String(formData.get("statusFilter") ?? "all").trim() || "all";
  const datasetLike = String(formData.get("datasetLike") ?? "").trim();
  const agentLike = String(formData.get("agentLike") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));
  if (!idRaw || !Number.isInteger(id) || id <= 0) return;
  await softDeleteExperimentById(id, user.id);
  revalidatePath("/experiments");
  redirect(buildListHref(q, status, datasetLike, agentLike, page, pageSize));
}

async function softDeleteExperimentById(id: number, userId: string) {
  await dbQuery(
    `UPDATE experiments
     SET is_deleted = TRUE,
         deleted_at = CURRENT_TIMESTAMP,
         updated_by = $2,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND deleted_at IS NULL`,
    [id, userId]
  );
}

async function bulkDeleteExperiment(formData: FormData) {
  "use server";
  const user = await requireUser();

  const ids = parseSelectedIds(formData);
  const q = String(formData.get("q") ?? "").trim();
  const status = String(formData.get("statusFilter") ?? "all").trim() || "all";
  const datasetLike = String(formData.get("datasetLike") ?? "").trim();
  const agentLike = String(formData.get("agentLike") ?? "").trim();
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));
  if (ids.length <= 0) return;

  for (const id of ids) {
    await softDeleteExperimentById(id, user.id);
  }
  revalidatePath("/experiments");
  redirect(buildListHref(q, status, datasetLike, agentLike, page, pageSize));
}

export default async function ExperimentsPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; status?: string; datasetLike?: string; agentLike?: string; panel?: string; id?: string; page?: string; pageSize?: string }>;
}) {
  await requireUser();

  const { q = "", status = "all", datasetLike = "", agentLike = "", panel = "none", id = "", page: pageRaw, pageSize: pageSizeRaw } = await searchParams;
  const filters = {
    q: q.trim(),
    status: status.trim() || "all",
    datasetLike: datasetLike.trim(),
    agentLike: agentLike.trim()
  };
  const pageSize = parsePageSize(pageSizeRaw);
  const requestedPage = parsePage(pageRaw);
  const editingId = Number(id.trim());
  const creating = panel === "create";
  const filtering = panel === "filter";

  const filterParams = [
    filters.q,
    filters.q,
    filters.q,
    filters.q,
    filters.status,
    filters.status,
    filters.datasetLike,
    filters.datasetLike,
    filters.agentLike,
    filters.agentLike
  ];
  const countResult = await dbQuery<{ total_count: number | string }>(
    `SELECT COUNT(*) AS total_count
     FROM experiments e
     JOIN datasets d ON d.id = e.dataset_id AND d.deleted_at IS NULL
     JOIN agents a ON a.id = e.agent_id AND a.deleted_at IS NULL
     WHERE ($1 = '' OR LOWER(e.name) LIKE CONCAT('%', LOWER($2), '%') OR LOWER(a.agent_key) LIKE CONCAT('%', LOWER($3), '%') OR LOWER(a.version) LIKE CONCAT('%', LOWER($4), '%'))
       AND e.deleted_at IS NULL
       AND ($5 = 'all' OR e.queue_status = $6)
       AND ($7 = '' OR LOWER(d.name) LIKE CONCAT('%', LOWER($8), '%'))
       AND ($9 = '' OR LOWER(a.agent_key) LIKE CONCAT('%', LOWER($10), '%'))`,
    filterParams
  );
  const total = Number(countResult.rows[0]?.total_count ?? 0);
  const page = clampPage(requestedPage, total, pageSize);
  const offset = getOffset(page, pageSize);

  const listHref = buildListHref(filters.q, filters.status, filters.datasetLike, filters.agentLike, page, pageSize);
  const createHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=create`;
  const filterHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=filter`;
  const hasFilter = filters.status !== "all" || !!filters.datasetLike || !!filters.agentLike;
  const paginationQuery = {
    q: filters.q,
    status: filters.status === "all" ? "" : filters.status,
    datasetLike: filters.datasetLike,
    agentLike: filters.agentLike
  };
  const resetHref = buildListHref(filters.q, "all", "", "", 1, pageSize);
  const bulkDeleteFormId = "experiment-bulk-delete-form";

  const [datasets, agents, evaluators, experiments, editing, editingEvaluators] = await Promise.all([
    dbQuery<{ id: number; name: string }>(`SELECT id, name FROM datasets WHERE deleted_at IS NULL ORDER BY created_at DESC`),
    dbQuery<{ id: number; name: string; agent_key: string; version: string }>(
      `SELECT id, name, agent_key, version
       FROM agents
       WHERE deleted_at IS NULL AND status = 'active'
       ORDER BY updated_at DESC`
    ),
    dbQuery<{ id: number; name: string; evaluator_key: string }>(
      `SELECT id, name, evaluator_key
       FROM evaluators
       WHERE deleted_at IS NULL
       ORDER BY created_at ASC`
    ),
    dbQuery<{
      id: number;
      name: string;
      dataset_id: number;
      dataset_name: string;
      agent_id: number;
      agent_key: string;
      agent_version: string;
      queue_status: string;
      queue_message_id: string | null;
      started_at: string | null;
      finished_at: string | null;
      created_at: string;
      evaluator_count: number | string;
      case_total: number | string;
      case_done: number | string;
      case_failed: number | string;
      avg_latency_ms: number | string | null;
    }>(
      `SELECT e.id, e.name, d.id AS dataset_id, d.name AS dataset_name,
              a.id AS agent_id, a.agent_key, a.version AS agent_version,
              e.queue_status, e.queue_message_id, e.started_at, e.finished_at, e.created_at,
              (SELECT COUNT(*) FROM experiment_evaluators ee WHERE ee.experiment_id = e.id) AS evaluator_count,
              (SELECT COUNT(*) FROM run_cases rc WHERE rc.experiment_id = e.id AND rc.is_latest = TRUE) AS case_total,
              (SELECT COALESCE(SUM(CASE WHEN rc.status IN ('success','failed','timeout') THEN 1 ELSE 0 END), 0)
                 FROM run_cases rc WHERE rc.experiment_id = e.id AND rc.is_latest = TRUE) AS case_done,
              (SELECT COALESCE(SUM(CASE WHEN rc.status IN ('failed','timeout') THEN 1 ELSE 0 END), 0)
                 FROM run_cases rc WHERE rc.experiment_id = e.id AND rc.is_latest = TRUE) AS case_failed,
              (SELECT ROUND(AVG(rc.latency_ms), 0) FROM run_cases rc WHERE rc.experiment_id = e.id AND rc.is_latest = TRUE AND rc.latency_ms IS NOT NULL) AS avg_latency_ms
       FROM experiments e
       JOIN datasets d ON d.id = e.dataset_id AND d.deleted_at IS NULL
       JOIN agents a ON a.id = e.agent_id AND a.deleted_at IS NULL
       WHERE ($1 = '' OR LOWER(e.name) LIKE CONCAT('%', LOWER($2), '%') OR LOWER(a.agent_key) LIKE CONCAT('%', LOWER($3), '%') OR LOWER(a.version) LIKE CONCAT('%', LOWER($4), '%'))
         AND e.deleted_at IS NULL
         AND ($5 = 'all' OR e.queue_status = $6)
         AND ($7 = '' OR LOWER(d.name) LIKE CONCAT('%', LOWER($8), '%'))
         AND ($9 = '' OR LOWER(a.agent_key) LIKE CONCAT('%', LOWER($10), '%'))
       ORDER BY e.created_at DESC
       LIMIT $11 OFFSET $12`,
      [...filterParams, pageSize, offset]
    ),
    Number.isInteger(editingId) && editingId > 0
      ? dbQuery<{ id: number; name: string; dataset_id: number; agent_id: number; queue_status: string }>(
          `SELECT id, name, dataset_id, agent_id, queue_status FROM experiments WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
          [editingId]
        )
      : Promise.resolve({ rows: [], rowCount: 0 } as { rows: Array<{ id: number; name: string; dataset_id: number; agent_id: number; queue_status: string }>; rowCount: number }),
    Number.isInteger(editingId) && editingId > 0
      ? dbQuery<{ evaluator_id: number }>(`SELECT evaluator_id FROM experiment_evaluators WHERE experiment_id = $1`, [editingId])
      : Promise.resolve({ rows: [], rowCount: 0 } as { rows: Array<{ evaluator_id: number }>; rowCount: number })
  ]);

  const editingRow = editing.rowCount > 0 ? editing.rows[0] : null;
  const selectedEvaluatorIds = new Set(editingEvaluators.rows.map((row) => row.evaluator_id));
  const showEditor = creating || Boolean(editingRow);

  return (
    <div className="grid">
      <section className="page-hero">
        <div className="breadcrumb">评测 &nbsp;/&nbsp; Experiments</div>
        <h1>Experiments</h1>
      </section>

      <section className="toolbar-row">
        <form action="/experiments" className="search-form">
          <input type="hidden" name="status" value={filters.status} />
          <input type="hidden" name="datasetLike" value={filters.datasetLike} />
          <input type="hidden" name="agentLike" value={filters.agentLike} />
          <input type="hidden" name="pageSize" value={pageSize} />
          <label className="input-icon-wrap">
            <SearchIcon width={16} height={16} />
            <input name="q" defaultValue={filters.q} placeholder="搜索实验名称或 Agent" />
          </label>
          <button type="submit" className="ghost-btn">
            搜索
          </button>
        </form>

        <div className="action-group">
          <Link href={filterHref} className="ghost-btn">
            <FilterIcon width={16} height={16} /> 筛选
          </Link>
          <BulkSelectionControls formId={bulkDeleteFormId} variant="compact" confirmText="确认批量删除已选 {count} 条 Experiment 吗？" />
          <PaginationControls basePath="/experiments" query={paginationQuery} total={total} page={page} pageSize={pageSize} position="top" variant="compact" />
        </div>
      </section>

      {hasFilter ? (
        <section className="active-filters">
          <span className="muted">当前筛选:</span>
          {filters.status !== "all" ? <span className="filter-pill">{`MQ状态: ${filters.status}`}</span> : null}
          {filters.datasetLike ? <span className="filter-pill">{`Dataset: ${filters.datasetLike}`}</span> : null}
          {filters.agentLike ? <span className="filter-pill">{`Agent: ${filters.agentLike}`}</span> : null}
          <Link href={resetHref} className="text-btn">
            清空筛选
          </Link>
        </section>
      ) : null}

      <section className="card table-card">
        <div className="section-title-row">
          <h2>
            <FlaskIcon width={16} height={16} />
            Experiments
          </h2>
          <Link href={createHref} className="primary-btn">
            <PlusIcon width={16} height={16} /> 新建 Experiment
          </Link>
        </div>
        <form id={bulkDeleteFormId} action={bulkDeleteExperiment}>
          <input type="hidden" name="q" value={filters.q} />
          <input type="hidden" name="statusFilter" value={filters.status} />
          <input type="hidden" name="datasetLike" value={filters.datasetLike} />
          <input type="hidden" name="agentLike" value={filters.agentLike} />
          <input type="hidden" name="page" value={page} />
          <input type="hidden" name="pageSize" value={pageSize} />
        </form>
        <table>
          <thead>
            <tr>
              <th className="bulk-select-cell">选</th>
              <th>ID</th>
              <th>名称</th>
              <th>评测集</th>
              <th>Agent</th>
              <th>Evaluators</th>
              <th>MQ状态</th>
              <th>进度</th>
              <th>平均耗时</th>
              <th>实验时长</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {experiments.rows.map((e) => (
              <tr key={e.id}>
                <td className="bulk-select-cell">
                  <input type="checkbox" name="selectedIds" value={e.id} form={bulkDeleteFormId} aria-label={`选择 Experiment ${e.id}`} />
                </td>
                <td>
                  <code>#{e.id}</code>
                </td>
                <td>
                  <Link href={`/experiments/${e.id}`} className="link-strong">
                    {e.name}
                  </Link>
                </td>
                <td>{e.dataset_name}</td>
                <td>
                  <code>{`${e.agent_key}@${e.agent_version}`}</code>
                </td>
                <td>{Number(e.evaluator_count)}</td>
                <td>
                  <span className={`status-pill ${e.queue_status}`}>{e.queue_status}</span>
                </td>
                <td>{`${Number(e.case_done)}/${Number(e.case_total)} (fail:${Number(e.case_failed)})`}</td>
                <td>{formatLatencyMs(e.avg_latency_ms)}</td>
                <td>{formatDuration(e.started_at, e.finished_at)}</td>
                <td>{formatDateTime(e.created_at)}</td>
                <td>
                  <div className="row-actions">
                    <Link href={`/experiments/${e.id}`} className="text-btn">
                      详情
                    </Link>
                    <Link href={`${listHref}${listHref.includes("?") ? "&" : "?"}id=${e.id}`} className="text-btn">
                      更新
                    </Link>
                    <form action={deleteExperiment}>
                      <input type="hidden" name="id" value={e.id} />
                      <input type="hidden" name="q" value={filters.q} />
                      <input type="hidden" name="statusFilter" value={filters.status} />
                      <input type="hidden" name="datasetLike" value={filters.datasetLike} />
                      <input type="hidden" name="agentLike" value={filters.agentLike} />
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
        <BulkSelectionControls formId={bulkDeleteFormId} variant="full" confirmText="确认批量删除已选 {count} 条 Experiment 吗？" />
        <PaginationControls basePath="/experiments" query={paginationQuery} total={total} page={page} pageSize={pageSize} position="bottom" />
      </section>

      {filtering ? (
        <div className="action-overlay">
          <Link href={listHref || "/experiments"} className="action-overlay-dismiss" aria-label="关闭筛选" />
          <aside className="action-drawer">
            <div className="action-drawer-header">
              <h3>筛选 Experiments</h3>
              <Link href={listHref || "/experiments"} className="icon-btn" aria-label="关闭">
                <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
              </Link>
            </div>
            <div className="action-drawer-body">
              <form action="/experiments" className="menu-form">
                <input type="hidden" name="q" value={filters.q} />
                <input type="hidden" name="panel" value="none" />
                <input type="hidden" name="pageSize" value={pageSize} />
                <label className="field-label">MQ状态</label>
                <div className="chip-row">
                  {[
                    { value: "all", label: "全部" },
                    { value: "queued", label: "queued" },
                    { value: "consuming", label: "consuming" },
                    { value: "done", label: "done" },
                    { value: "failed", label: "failed" },
                    { value: "manual_terminated", label: "manual_terminated" },
                    { value: "test_case", label: "test_case" }
                  ].map((item) => (
                    <label key={item.value} className="chip">
                      <input type="radio" name="status" value={item.value} defaultChecked={filters.status === item.value} />
                      {item.label}
                    </label>
                  ))}
                </div>
                <label className="field-label">评测集名包含</label>
                <input name="datasetLike" placeholder="例如 web-bench" defaultValue={filters.datasetLike} />
                <label className="field-label">Agent Key 包含</label>
                <input name="agentLike" placeholder="例如 openclaw" defaultValue={filters.agentLike} />
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
          closeHref={listHref || "/experiments"}
          title={editingRow ? "Experiment 详情" : "新建 Experiment"}
          headerActions={
            editingRow ? (
              <Link href={`/experiments/${editingRow.id}`} className="icon-btn" aria-label="打开 Experiment 详情页">
                <OpenInNewIcon width={16} height={16} />
              </Link>
            ) : null
          }
        >
          <form
            id={editingRow ? `experiment-form-${editingRow.id}` : "experiment-form-create"}
            action={editingRow ? updateExperiment : createExperiment}
            className="menu-form form-tone-green"
          >
            {editingRow ? <input type="hidden" name="id" value={editingRow.id} /> : null}
            <input type="hidden" name="q" value={filters.q} />
            <input type="hidden" name="statusFilter" value={filters.status} />
            <input type="hidden" name="datasetLike" value={filters.datasetLike} />
            <input type="hidden" name="agentLike" value={filters.agentLike} />
            <input type="hidden" name="page" value={page} />
            <input type="hidden" name="pageSize" value={pageSize} />

            <FormField title="Experiment 名称" typeLabel="String" required>
              <input name="name" placeholder="Experiment 名称" required defaultValue={editingRow?.name ?? ""} />
            </FormField>
            <FormField title="选择 Dataset" typeLabel="FK" required>
              <select name="datasetId" required defaultValue={editingRow ? String(editingRow.dataset_id) : ""}>
                <option value="" disabled>
                  选择 Dataset
                </option>
                {datasets.rows.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField title="选择 Agent 版本" typeLabel="FK" required>
              <select name="agentId" required defaultValue={editingRow ? String(editingRow.agent_id) : ""}>
                <option value="" disabled>
                  选择 Agent 版本
                </option>
                {agents.rows.map((a) => (
                  <option key={a.id} value={a.id}>
                    {`${a.name} (${a.agent_key}@${a.version})`}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField title="选择 Evaluators" typeLabel="M:N" required>
              <div className="chip-row">
                {evaluators.rows.map((ev) => {
                  const checked = editingRow ? selectedEvaluatorIds.has(ev.id) : false;
                  return (
                    <label key={ev.id} className="chip">
                      <input type="checkbox" name="evaluatorIds" value={ev.id} defaultChecked={checked} />
                      {ev.name}
                    </label>
                  );
                })}
              </div>
            </FormField>
            <FormField title="MQ状态" typeLabel="Enum">
              <input value={editingRow?.queue_status ?? "idle"} readOnly disabled />
            </FormField>
          </form>
          <div className="drawer-actions">
            <SubmitButton
              form={editingRow ? `experiment-form-${editingRow.id}` : "experiment-form-create"}
              className="primary-btn"
              pendingText={editingRow ? "更新中..." : "创建中..."}
            >
              {editingRow ? "更新" : "创建"}
            </SubmitButton>
            {editingRow ? (
              <form action={deleteExperiment} className="drawer-inline-form">
                <input type="hidden" name="id" value={editingRow.id} />
                <input type="hidden" name="q" value={filters.q} />
                <input type="hidden" name="statusFilter" value={filters.status} />
                <input type="hidden" name="datasetLike" value={filters.datasetLike} />
                <input type="hidden" name="agentLike" value={filters.agentLike} />
                <input type="hidden" name="page" value={page} />
                <input type="hidden" name="pageSize" value={pageSize} />
                <SubmitButton className="danger-btn" pendingText="删除中...">
                  删除
                </SubmitButton>
              </form>
            ) : null}
            <Link href={listHref || "/experiments"} className="ghost-btn">
              取消
            </Link>
          </div>
        </EntityDrawer>
      ) : null}
    </div>
  );
}
