import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { dbQuery } from "@/lib/db";
import { requireUser } from "@/lib/supabase-auth";
import Link from "next/link";
import { FilterIcon, FlaskIcon, PlusIcon, SearchIcon } from "../components/icons";
import { SubmitButton } from "../components/submit-button";

function buildListHref(q: string, status: string, datasetLike: string, agentLike: string) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (status !== "all") params.set("status", status);
  if (datasetLike) params.set("datasetLike", datasetLike);
  if (agentLike) params.set("agentLike", agentLike);
  return params.size > 0 ? `/experiments?${params.toString()}` : "/experiments";
}

async function createExperiment(formData: FormData) {
  "use server";
  const user = await requireUser();

  const name = String(formData.get("name") ?? "").trim();
  const datasetIdRaw = String(formData.get("datasetId") ?? "").trim();
  const agentIdRaw = String(formData.get("agentId") ?? "").trim();
  const datasetId = Number(datasetIdRaw);
  const agentId = Number(agentIdRaw);
  const q = String(formData.get("q") ?? "").trim();
  const status = String(formData.get("statusFilter") ?? "all").trim() || "all";
  const datasetLike = String(formData.get("datasetLike") ?? "").trim();
  const agentLike = String(formData.get("agentLike") ?? "").trim();

  if (!name) {
    throw new Error("实验名称不能为空");
  }
  if (!datasetIdRaw || !Number.isInteger(datasetId) || datasetId <= 0) {
    throw new Error("评测集 ID 非法。");
  }
  if (!agentIdRaw || !Number.isInteger(agentId) || agentId <= 0) {
    throw new Error("Agent ID 非法。");
  }

  await dbQuery(
    `INSERT INTO experiments (name, dataset_id, agent_id, status, created_by, updated_by) VALUES ($1,$2,$3,'ready',$4,$4)`,
    [name, datasetId, agentId, user.id]
  );
  revalidatePath("/experiments");
  redirect(buildListHref(q, status, datasetLike, agentLike));
}

export default async function ExperimentsPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; status?: string; datasetLike?: string; agentLike?: string; panel?: string }>;
}) {
  await requireUser();

  const { q = "", status = "all", datasetLike = "", agentLike = "", panel = "none" } = await searchParams;
  const filters = {
    q: q.trim(),
    status: status.trim() || "all",
    datasetLike: datasetLike.trim(),
    agentLike: agentLike.trim()
  };
  const creating = panel === "create";
  const filtering = panel === "filter";

  const listHref = buildListHref(filters.q, filters.status, filters.datasetLike, filters.agentLike);
  const createHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=create`;
  const filterHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=filter`;
  const hasFilter = filters.status !== "all" || !!filters.datasetLike || !!filters.agentLike;

  const [datasets, agents, experiments] = await Promise.all([
    dbQuery<{ id: number; name: string }>(`SELECT id, name FROM datasets ORDER BY created_at DESC`),
    dbQuery<{ id: number; name: string; agent_key: string; version: string }>(
      `SELECT id, name, agent_key, version FROM agents WHERE status = 'active' ORDER BY updated_at DESC`
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
    }>(
      `SELECT e.id, e.name, d.id AS dataset_id, d.name AS dataset_name,
              a.id AS agent_id, a.agent_key, a.version AS agent_version,
              e.status, e.created_at
       FROM experiments e
       JOIN datasets d ON d.id = e.dataset_id
       JOIN agents a ON a.id = e.agent_id
       WHERE ($1 = '' OR LOWER(e.name) LIKE CONCAT('%', LOWER($2), '%') OR LOWER(a.agent_key) LIKE CONCAT('%', LOWER($3), '%') OR LOWER(a.version) LIKE CONCAT('%', LOWER($4), '%'))
         AND ($5 = 'all' OR e.status = $6)
         AND ($7 = '' OR LOWER(d.name) LIKE CONCAT('%', LOWER($8), '%'))
         AND ($9 = '' OR LOWER(a.agent_key) LIKE CONCAT('%', LOWER($10), '%'))
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
    )
  ]);

  return (
    <div className="grid">
      <section className="page-hero">
        <div className="breadcrumb">评测 &nbsp;/&nbsp; Experiments</div>
        <h1>Experiments</h1>
        <p className="muted">绑定评测集与 Agent 版本，发起完整评估运行。</p>
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
              <th>状态</th>
              <th>创建时间</th>
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
                <td>
                  <span className={`status-pill ${e.status}`}>{e.status}</span>
                </td>
                <td>{new Date(e.created_at).toLocaleString()}</td>
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
                    { value: "completed", label: "completed" },
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

      {creating ? (
        <div className="action-overlay">
          <Link href={listHref || "/experiments"} className="action-overlay-dismiss" aria-label="关闭抽屉蒙层" />
          <aside className="action-drawer">
            <div className="action-drawer-header">
              <h3>新建 Experiment</h3>
              <Link href={listHref || "/experiments"} className="icon-btn" aria-label="关闭">
                <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
              </Link>
            </div>
            <div className="action-drawer-body">
              <form action={createExperiment} className="menu-form">
                <input type="hidden" name="q" value={filters.q} />
                <input type="hidden" name="statusFilter" value={filters.status} />
                <input type="hidden" name="datasetLike" value={filters.datasetLike} />
                <input type="hidden" name="agentLike" value={filters.agentLike} />
                <label className="field-label">Experiment 名称</label>
                <input name="name" placeholder="Experiment 名称" required />
                <label className="field-label">选择 Dataset</label>
                <select name="datasetId" required defaultValue="">
                  <option value="" disabled>
                    选择 Dataset
                  </option>
                  {datasets.rows.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <label className="field-label">选择 Agent 版本</label>
                <select name="agentId" required defaultValue="">
                  <option value="" disabled>
                    选择 Agent 版本
                  </option>
                  {agents.rows.map((a) => (
                    <option key={a.id} value={a.id}>
                      {`${a.name} (${a.agent_key}@${a.version})`}
                    </option>
                  ))}
                </select>
                <SubmitButton pendingText="创建中...">创建</SubmitButton>
              </form>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
