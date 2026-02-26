import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { dbQuery, engine, withTransaction } from "@/lib/db";
import { requireUser } from "@/lib/supabase-auth";
import Link from "next/link";
import { FilterIcon, FlaskIcon, OpenInNewIcon, PlusIcon, SearchIcon } from "../components/icons";
import { SubmitButton } from "../components/submit-button";
import { EntityDrawer } from "../components/entity-drawer";
import { FormField } from "../components/form-field";

function buildListHref(q: string, status: string, datasetLike: string, agentLike: string) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (status !== "all") params.set("status", status);
  if (datasetLike) params.set("datasetLike", datasetLike);
  if (agentLike) params.set("agentLike", agentLike);
  return params.size > 0 ? `/experiments?${params.toString()}` : "/experiments";
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

  if (!name || !datasetIdRaw || !agentIdRaw || !Number.isInteger(datasetId) || datasetId <= 0 || !Number.isInteger(agentId) || agentId <= 0 || evaluatorIds.length === 0) {
    return;
  }

  await withTransaction(async (tx) => {
    let experimentId = 0;
    if (engine === "mysql") {
      const inserted = await tx.query(
        `INSERT INTO experiments (name, dataset_id, agent_id, status, run_locked, created_by, updated_by)
         SELECT $1, $2, $3, 'ready', FALSE, $4, $4
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
        `INSERT INTO experiments (name, dataset_id, agent_id, status, run_locked, created_by, updated_by)
         SELECT $1, $2, $3, 'ready', FALSE, $4, $4
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
  redirect(buildListHref(q, status, datasetLike, agentLike));
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
  const expStatus = String(formData.get("expStatus") ?? "ready").trim() || "ready";
  const evaluatorIds = parseEvaluatorIds(formData);
  const normalizedStatus = ["ready", "running", "finished", "partial_failed", "failed"].includes(expStatus) ? expStatus : "ready";

  const q = String(formData.get("q") ?? "").trim();
  const status = String(formData.get("statusFilter") ?? "all").trim() || "all";
  const datasetLike = String(formData.get("datasetLike") ?? "").trim();
  const agentLike = String(formData.get("agentLike") ?? "").trim();

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
         AND e.run_locked = FALSE
       LIMIT 1`,
      [id, datasetId, agentId]
    );

    if (editable.rowCount === 0) {
      return;
    }

    await tx.query(
      `UPDATE experiments
       SET name = $2, dataset_id = $3, agent_id = $4, status = $5, updated_by = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND deleted_at IS NULL
         AND run_locked = FALSE`,
      [id, name, datasetId, agentId, normalizedStatus, user.id]
    );

    await attachExperimentEvaluators(tx, id, evaluatorIds);
  });

  revalidatePath("/experiments");
  revalidatePath(`/experiments/${id}`);
  redirect(buildListHref(q, status, datasetLike, agentLike));
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
  if (!idRaw || !Number.isInteger(id) || id <= 0) return;
  await dbQuery(
    `UPDATE experiments
     SET is_deleted = TRUE,
         deleted_at = CURRENT_TIMESTAMP,
         updated_by = $2,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND deleted_at IS NULL`,
    [id, user.id]
  );
  revalidatePath("/experiments");
  redirect(buildListHref(q, status, datasetLike, agentLike));
}

export default async function ExperimentsPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; status?: string; datasetLike?: string; agentLike?: string; panel?: string; id?: string }>;
}) {
  await requireUser();

  const { q = "", status = "all", datasetLike = "", agentLike = "", panel = "none", id = "" } = await searchParams;
  const filters = {
    q: q.trim(),
    status: status.trim() || "all",
    datasetLike: datasetLike.trim(),
    agentLike: agentLike.trim()
  };
  const editingId = Number(id.trim());
  const creating = panel === "create";
  const filtering = panel === "filter";

  const listHref = buildListHref(filters.q, filters.status, filters.datasetLike, filters.agentLike);
  const createHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=create`;
  const filterHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=filter`;
  const hasFilter = filters.status !== "all" || !!filters.datasetLike || !!filters.agentLike;

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
      status: string;
      created_at: string;
      evaluator_count: number | string;
    }>(
      `SELECT e.id, e.name, d.id AS dataset_id, d.name AS dataset_name,
              a.id AS agent_id, a.agent_key, a.version AS agent_version,
              e.status, e.created_at,
              COUNT(ee.id) AS evaluator_count
       FROM experiments e
       JOIN datasets d ON d.id = e.dataset_id AND d.deleted_at IS NULL
       JOIN agents a ON a.id = e.agent_id AND a.deleted_at IS NULL
       LEFT JOIN experiment_evaluators ee ON ee.experiment_id = e.id
       WHERE ($1 = '' OR LOWER(e.name) LIKE CONCAT('%', LOWER($2), '%') OR LOWER(a.agent_key) LIKE CONCAT('%', LOWER($3), '%') OR LOWER(a.version) LIKE CONCAT('%', LOWER($4), '%'))
         AND e.deleted_at IS NULL
         AND ($5 = 'all' OR e.status = $6)
         AND ($7 = '' OR LOWER(d.name) LIKE CONCAT('%', LOWER($8), '%'))
         AND ($9 = '' OR LOWER(a.agent_key) LIKE CONCAT('%', LOWER($10), '%'))
       GROUP BY e.id, e.name, d.id, d.name, a.id, a.agent_key, a.version, e.status, e.created_at
       ORDER BY e.created_at DESC`,
      [
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
      ]
    ),
    Number.isInteger(editingId) && editingId > 0
      ? dbQuery<{ id: number; name: string; dataset_id: number; agent_id: number; status: string; run_locked: boolean }>(
          `SELECT id, name, dataset_id, agent_id, status, run_locked FROM experiments WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
          [editingId]
        )
      : Promise.resolve({ rows: [], rowCount: 0 } as { rows: Array<{ id: number; name: string; dataset_id: number; agent_id: number; status: string; run_locked: boolean }>; rowCount: number }),
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
        </div>
      </section>

      {hasFilter ? (
        <section className="active-filters">
          <span className="muted">当前筛选:</span>
          {filters.status !== "all" ? <span className="filter-pill">{`状态: ${filters.status}`}</span> : null}
          {filters.datasetLike ? <span className="filter-pill">{`Dataset: ${filters.datasetLike}`}</span> : null}
          {filters.agentLike ? <span className="filter-pill">{`Agent: ${filters.agentLike}`}</span> : null}
          <Link href={filters.q ? `/experiments?q=${encodeURIComponent(filters.q)}` : "/experiments"} className="text-btn">
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
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>评测集</th>
              <th>Agent</th>
              <th>Evaluators</th>
              <th>状态</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {experiments.rows.map((e) => (
              <tr key={e.id}>
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
                  <span className={`status-pill ${e.status}`}>{e.status}</span>
                </td>
                <td>{new Date(e.created_at).toLocaleString()}</td>
                <td>
                  <div className="row-actions">
                    <Link href={`${listHref}${listHref.includes("?") ? "&" : "?"}id=${e.id}`} className="text-btn">
                      详情
                    </Link>
                    <form action={deleteExperiment}>
                      <input type="hidden" name="id" value={e.id} />
                      <input type="hidden" name="q" value={filters.q} />
                      <input type="hidden" name="statusFilter" value={filters.status} />
                      <input type="hidden" name="datasetLike" value={filters.datasetLike} />
                      <input type="hidden" name="agentLike" value={filters.agentLike} />
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
                <label className="field-label">状态</label>
                <div className="chip-row">
                  {[
                    { value: "all", label: "全部" },
                    { value: "ready", label: "ready" },
                    { value: "running", label: "running" },
                    { value: "finished", label: "finished" },
                    { value: "partial_failed", label: "partial_failed" },
                    { value: "failed", label: "failed" }
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
                <Link href={filters.q ? `/experiments?q=${encodeURIComponent(filters.q)}` : "/experiments"} className="ghost-btn">
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
            <FormField title="状态" typeLabel="Enum">
              <select name="expStatus" defaultValue={editingRow?.status ?? "ready"} disabled={Boolean(editingRow?.run_locked)}>
                {["ready", "running", "finished", "partial_failed", "failed"].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
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
