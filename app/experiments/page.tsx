import { revalidatePath } from "next/cache";
import { dbQuery } from "@/lib/db";
import { requireUser } from "@/lib/supabase-auth";
import Link from "next/link";
import { FilterIcon, FlaskIcon, PlusIcon, RefreshIcon, SearchIcon } from "../components/icons";
import { SubmitButton } from "../components/submit-button";

async function createExperiment(formData: FormData) {
  "use server";
  const user = await requireUser();

  const name = String(formData.get("name") ?? "").trim();
  const datasetIdRaw = String(formData.get("datasetId") ?? "").trim();
  const datasetId = Number(datasetIdRaw);
  const agentVersion = String(formData.get("agentVersion") ?? "v1").trim();
  if (!name || !datasetIdRaw || !Number.isInteger(datasetId) || datasetId <= 0) return;

  await dbQuery(`INSERT INTO experiments (name, dataset_id, agent_version, status, created_by, updated_by) VALUES ($1,$2,$3,'ready',$4,$4)`, [
    name,
    datasetId,
    agentVersion,
    user.id
  ]);
  revalidatePath("/experiments");
}

export default async function ExperimentsPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; dataset?: string; status?: string; panel?: string }>;
}) {
  await requireUser();

  const { q = "", dataset = "all", status = "all", panel = "none" } = await searchParams;
  const qv = q.trim();
  const parsedDatasetFilter = dataset === "all" ? null : Number(dataset);
  const datasetFilter =
    typeof parsedDatasetFilter === "number" && Number.isInteger(parsedDatasetFilter) && parsedDatasetFilter > 0
      ? parsedDatasetFilter
      : null;
  const creating = panel === "create";
  const listHref = `/experiments${qv || dataset !== "all" || status !== "all" ? `?${new URLSearchParams({ ...(qv ? { q: qv } : {}), ...(dataset !== "all" ? { dataset } : {}), ...(status !== "all" ? { status } : {}) }).toString()}` : ""}`;
  const createHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=create`;

  const [datasets, experiments] = await Promise.all([
    dbQuery<{ id: number; name: string }>(`SELECT id, name FROM datasets ORDER BY created_at DESC`),
    dbQuery<{
      id: number;
      name: string;
      dataset_id: number;
      dataset_name: string;
      agent_version: string;
      status: string;
      created_at: string;
    }>(
      `SELECT e.id, e.name, d.id AS dataset_id, d.name AS dataset_name, e.agent_version, e.status, e.created_at
       FROM experiments e
       JOIN datasets d ON d.id = e.dataset_id
       WHERE ($1 = '' OR LOWER(e.name) LIKE CONCAT('%', LOWER($2), '%') OR LOWER(e.agent_version) LIKE CONCAT('%', LOWER($3), '%'))
         AND ($4 IS NULL OR e.dataset_id = $5)
         AND ($6 = 'all' OR e.status = $7)
       ORDER BY e.created_at DESC`
      ,
      [qv, qv, qv, datasetFilter, datasetFilter, status, status]
    )
  ]);

  return (
    <div className="grid">
      <section className="page-hero">
        <div className="breadcrumb">评测 &nbsp;/&nbsp; 实验</div>
        <h1>实验</h1>
        <p className="muted">绑定评测集与 Agent 版本，发起完整评估运行。</p>
      </section>

      <section className="toolbar-row">
        <form action="/experiments" className="search-form">
          <label className="input-icon-wrap">
            <SearchIcon width={16} height={16} />
            <input name="q" defaultValue={qv} placeholder="搜索实验名称或版本" />
          </label>
          <label className="input-icon-wrap">
            <FilterIcon width={16} height={16} />
            <select name="dataset" defaultValue={dataset}>
              <option value="all">全部评测集</option>
              {datasets.rows.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="input-icon-wrap">
            <FilterIcon width={16} height={16} />
            <select name="status" defaultValue={status}>
              <option value="all">全部状态</option>
              <option value="ready">ready</option>
              <option value="running">running</option>
              <option value="completed">completed</option>
              <option value="failed">failed</option>
            </select>
          </label>
          <button type="submit" className="ghost-btn">
            <FilterIcon width={16} height={16} /> 筛选
          </button>
        </form>

        <div className="action-group">
          <a href={listHref || "/experiments"} className="icon-btn" aria-label="刷新">
            <RefreshIcon width={16} height={16} />
          </a>
          <Link href={createHref} className="primary-btn">
            <PlusIcon width={16} height={16} /> 新建实验
          </Link>
        </div>
      </section>

      <section className="card table-card">
        <div className="section-title-row">
          <h2>
            <FlaskIcon width={16} height={16} />
            实验列表
          </h2>
        </div>
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>评测集</th>
              <th>版本</th>
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
                  <code>{e.agent_version}</code>
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

      {creating ? (
        <div className="action-overlay">
          <Link href={listHref || "/experiments"} className="action-overlay-dismiss" aria-label="关闭抽屉蒙层" />
          <aside className="action-drawer">
            <div className="action-drawer-header">
              <h3>新建实验</h3>
              <Link href={listHref || "/experiments"} className="icon-btn" aria-label="关闭">
                <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
              </Link>
            </div>
            <div className="action-drawer-body">
              <p className="muted">选择评测集与 Agent 版本，创建一个可直接运行的实验。</p>
              <form action={createExperiment} className="menu-form">
                <input name="name" placeholder="实验名称" required />
                <select name="datasetId" required defaultValue="">
                  <option value="" disabled>
                    选择评测集
                  </option>
                  {datasets.rows.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <input name="agentVersion" placeholder="Agent 版本，例如 v2026.02.24" defaultValue="v1" />
                <SubmitButton pendingText="创建中...">创建</SubmitButton>
              </form>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
