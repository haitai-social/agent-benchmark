import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { dbQuery } from "@/lib/db";
import { requireUser } from "@/lib/supabase-auth";
import { retryFailedRunCases } from "@/lib/runner";
import { ArrowLeftIcon, FilterIcon, FlaskIcon, SearchIcon } from "@/app/components/icons";
import { SubmitButton } from "@/app/components/submit-button";
import { EntityDrawer } from "@/app/components/entity-drawer";
import { DevToastButton } from "@/app/components/dev-toast-button";

function buildDetailHref(id: number, tab: string, q: string, status: string, scoreMin: string, scoreMax: string) {
  const params = new URLSearchParams();
  if (tab !== "details") params.set("tab", tab);
  if (q) params.set("q", q);
  if (status !== "all") params.set("status", status);
  if (scoreMin) params.set("scoreMin", scoreMin);
  if (scoreMax) params.set("scoreMax", scoreMax);
  const query = params.toString();
  return query ? `/experiments/${id}?${query}` : `/experiments/${id}`;
}

async function retryFailed(formData: FormData) {
  "use server";
  const user = await requireUser();
  const id = Number(String(formData.get("id") ?? "0"));
  if (!Number.isInteger(id) || id <= 0) return;
  await retryFailedRunCases(id, user.id);
  revalidatePath(`/experiments/${id}`);
  revalidatePath("/experiments");
  redirect(`/experiments/${id}`);
}

export default async function ExperimentDetailPage({
  params,
  searchParams
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; q?: string; status?: string; scoreMin?: string; scoreMax?: string; panel?: string; caseId?: string }>;
}) {
  await requireUser();

  const { id: idParam } = await params;
  const id = Number(idParam.trim());
  if (!Number.isInteger(id) || id <= 0) {
    return <section className="card">实验不存在</section>;
  }

  const { tab = "details", q = "", status = "all", scoreMin = "", scoreMax = "", panel = "none", caseId = "" } = await searchParams;
  const activeTab = ["details", "metrics", "config"].includes(tab) ? tab : "details";
  const filters = {
    q: q.trim(),
    status: status.trim() || "all",
    scoreMin: scoreMin.trim(),
    scoreMax: scoreMax.trim()
  };

  const scoreMinNum = filters.scoreMin ? Number(filters.scoreMin) : null;
  const scoreMaxNum = filters.scoreMax ? Number(filters.scoreMax) : null;

  const baseHref = buildDetailHref(id, activeTab, filters.q, filters.status, filters.scoreMin, filters.scoreMax);
  const filterHref = `${baseHref}${baseHref.includes("?") ? "&" : "?"}panel=filter`;
  const selectedCaseId = Number(caseId);

  const [exp, evaluatorRows, counts, caseRows, metrics, evaluatorMetrics, selectedCase, selectedCaseEvals, attempts] = await Promise.all([
    dbQuery<{
      id: number;
      name: string;
      dataset_id: number;
      dataset_name: string;
      agent_id: number;
      agent_key: string;
      agent_version: string;
      docker_image: string;
      status: string;
      run_locked: boolean;
      started_at: string | null;
      finished_at: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT e.id, e.name, e.dataset_id, d.name AS dataset_name,
              e.agent_id, a.agent_key, a.version AS agent_version, a.docker_image,
              e.status, e.run_locked, e.started_at, e.finished_at,
              e.created_at, e.updated_at
       FROM experiments e
       JOIN datasets d ON d.id = e.dataset_id AND d.deleted_at IS NULL
       JOIN agents a ON a.id = e.agent_id AND a.deleted_at IS NULL
       WHERE e.id = $1 AND e.deleted_at IS NULL
       LIMIT 1`,
      [id]
    ),
    dbQuery<{ evaluator_id: number; evaluator_name: string }>(
      `SELECT ee.evaluator_id, ev.name AS evaluator_name
       FROM experiment_evaluators ee
       JOIN evaluators ev ON ev.id = ee.evaluator_id AND ev.deleted_at IS NULL
       WHERE ee.experiment_id = $1
       ORDER BY ev.created_at ASC`,
      [id]
    ),
    dbQuery<{
      total_count: number | string;
      success_count: number | string;
      failed_count: number | string;
      running_count: number | string;
      pending_count: number | string;
    }>(
      `SELECT
          COUNT(*) AS total_count,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count
       FROM run_cases
       WHERE experiment_id = $1 AND is_latest = TRUE`,
      [id]
    ),
    dbQuery<{
      id: number;
      data_item_id: number;
      status: string;
      final_score: number | null;
      agent_trajectory: unknown;
      agent_output: unknown;
      error_message: string | null;
      user_input: string;
      reference_output: unknown;
      updated_at: string;
      attempt_no: number;
    }>(
      `SELECT rc.id, rc.data_item_id, rc.status, rc.final_score, rc.agent_trajectory, rc.agent_output,
              rc.error_message, di.user_input, di.reference_output, rc.updated_at, rc.attempt_no
       FROM run_cases rc
       JOIN data_items di ON di.id = rc.data_item_id
       WHERE rc.experiment_id = $1
         AND rc.is_latest = TRUE
         AND ($2 = '' OR LOWER(di.user_input) LIKE CONCAT('%', LOWER($2), '%'))
         AND ($3 = 'all' OR rc.status = $4)
         AND ($5 IS NULL OR rc.final_score >= $6)
         AND ($7 IS NULL OR rc.final_score <= $8)
       ORDER BY rc.updated_at DESC
       LIMIT 300`,
      [id, filters.q, filters.status, filters.status, scoreMinNum, scoreMinNum, scoreMaxNum, scoreMaxNum]
    ),
    dbQuery<{
      avg_score: number | null;
      avg_latency: number | null;
      input_tokens: number | string | null;
      output_tokens: number | string | null;
    }>(
      `SELECT
          AVG(final_score) AS avg_score,
          AVG(latency_ms) AS avg_latency,
          SUM(COALESCE(input_tokens, 0)) AS input_tokens,
          SUM(COALESCE(output_tokens, 0)) AS output_tokens
       FROM run_cases
       WHERE experiment_id = $1 AND is_latest = TRUE`,
      [id]
    ),
    dbQuery<{ evaluator_name: string; avg_score: number | null; count_num: number | string }>(
      `SELECT ev.name AS evaluator_name,
              AVG(er.score) AS avg_score,
              COUNT(*) AS count_num
       FROM evaluate_results er
       JOIN run_cases rc ON rc.id = er.run_case_id
       JOIN evaluators ev ON ev.id = er.evaluator_id
       WHERE rc.experiment_id = $1 AND rc.is_latest = TRUE
       GROUP BY ev.name
       ORDER BY ev.name ASC`,
      [id]
    ),
    Number.isInteger(selectedCaseId) && selectedCaseId > 0
      ? dbQuery<{
          id: number;
          data_item_id: number;
          attempt_no: number;
          status: string;
          final_score: number | null;
          latency_ms: number | null;
          input_tokens: number | null;
          output_tokens: number | null;
          error_message: string | null;
          logs: string | null;
          agent_trajectory: unknown;
          agent_output: unknown;
          started_at: string | null;
          finished_at: string | null;
          user_input: string;
          reference_output: unknown;
          reference_trajectory: unknown;
        }>(
          `SELECT rc.id, rc.data_item_id, rc.attempt_no, rc.status, rc.final_score,
                  rc.latency_ms, rc.input_tokens, rc.output_tokens, rc.error_message, rc.logs,
                  rc.agent_trajectory, rc.agent_output, rc.started_at, rc.finished_at,
                  di.user_input, di.reference_output, di.reference_trajectory
           FROM run_cases rc
           JOIN data_items di ON di.id = rc.data_item_id
           WHERE rc.experiment_id = $1 AND rc.id = $2
           LIMIT 1`,
          [id, selectedCaseId]
        )
      : Promise.resolve({ rows: [], rowCount: 0 } as { rows: Array<never>; rowCount: number }),
    Number.isInteger(selectedCaseId) && selectedCaseId > 0
      ? dbQuery<{ evaluator_name: string; score: number; reason: string }>(
          `SELECT ev.name AS evaluator_name, er.score, er.reason
           FROM evaluate_results er
           JOIN evaluators ev ON ev.id = er.evaluator_id
           WHERE er.run_case_id = $1
           ORDER BY ev.name ASC`,
          [selectedCaseId]
        )
      : Promise.resolve({ rows: [], rowCount: 0 } as { rows: Array<{ evaluator_name: string; score: number; reason: string }>; rowCount: number }),
    Number.isInteger(selectedCaseId) && selectedCaseId > 0
      ? dbQuery<{ id: number; attempt_no: number; status: string; final_score: number | null; updated_at: string }>(
          `SELECT id, attempt_no, status, final_score, updated_at
           FROM run_cases
           WHERE experiment_id = $1
             AND data_item_id = (
               SELECT data_item_id FROM run_cases WHERE id = $2 LIMIT 1
             )
           ORDER BY attempt_no DESC`,
          [id, selectedCaseId]
        )
      : Promise.resolve({ rows: [], rowCount: 0 } as { rows: Array<{ id: number; attempt_no: number; status: string; final_score: number | null; updated_at: string }>; rowCount: number })
  ]);

  if (exp.rowCount === 0) {
    return <section className="card">实验不存在</section>;
  }

  const e = exp.rows[0];
  const countRow = counts.rows[0] ?? {
    total_count: 0,
    success_count: 0,
    failed_count: 0,
    running_count: 0,
    pending_count: 0
  };

  const totalCount = Number(countRow.total_count ?? 0);
  const successCount = Number(countRow.success_count ?? 0);
  const failedCount = Number(countRow.failed_count ?? 0);
  const runningCount = Number(countRow.running_count ?? 0);
  const pendingCount = Number(countRow.pending_count ?? 0);
  const hasFailedCases = failedCount > 0;

  const summary = metrics.rows[0] ?? { avg_score: null, avg_latency: null, input_tokens: 0, output_tokens: 0 };
  const inputTokens = Number(summary.input_tokens ?? 0);
  const outputTokens = Number(summary.output_tokens ?? 0);
  const totalTokens = inputTokens + outputTokens;

  const hasFilter = filters.status !== "all" || !!filters.scoreMin || !!filters.scoreMax;

  return (
    <div className="grid">
      <section className="detail-head refined exp-header-strip">
        <div className="exp-header-main">
          <div className="exp-title-row">
            <Link href="/experiments" className="icon-btn" aria-label="返回 Experiments">
              <ArrowLeftIcon width={16} height={16} />
            </Link>
            <h1>{e.name}</h1>
            <span className={`status-pill ${e.status}`}>{e.status}</span>
          </div>
          <div className="exp-kpi-chip-row">
            <span className="exp-kpi-chip">总条数 {totalCount}</span>
            <span className="exp-kpi-chip">成功 {successCount}</span>
            <span className="exp-kpi-chip">失败 {failedCount}</span>
            <span className="exp-kpi-chip">执行中 {runningCount}</span>
            <span className="exp-kpi-chip">待执行 {pendingCount}</span>
          </div>
        </div>
        <div className="exp-header-actions">
          <DevToastButton label="启动实验" />
          <form action={retryFailed}>
            <input type="hidden" name="id" value={id} />
            <SubmitButton className="ghost-btn" pendingText="重试中..." disabled={!hasFailedCases}>
              重试失败
            </SubmitButton>
          </form>
          <button type="button" className="ghost-btn" disabled>
            终止
          </button>
        </div>
      </section>

      <section className="exp-tabs" role="tablist" aria-label="实验详情标签页">
        {[
          { key: "details", label: "数据明细" },
          { key: "metrics", label: "指标统计" },
          { key: "config", label: "实验配置" }
        ].map((item) => (
          <Link
            key={item.key}
            href={buildDetailHref(id, item.key, filters.q, filters.status, filters.scoreMin, filters.scoreMax)}
            className={`exp-tab ${activeTab === item.key ? "active" : ""}`}
            role="tab"
            aria-selected={activeTab === item.key}
          >
            {item.label}
          </Link>
        ))}
      </section>

      {activeTab === "details" ? (
        <>
          <section className="toolbar-row">
            <form action={`/experiments/${id}`} className="search-form">
              <input type="hidden" name="tab" value={activeTab} />
              <input type="hidden" name="status" value={filters.status} />
              <input type="hidden" name="scoreMin" value={filters.scoreMin} />
              <input type="hidden" name="scoreMax" value={filters.scoreMax} />
              <label className="input-icon-wrap">
                <SearchIcon width={16} height={16} />
                <input name="q" defaultValue={filters.q} placeholder="按输入/参考输出/实际输出搜索" />
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
              {filters.scoreMin ? <span className="filter-pill">{`最小分: ${filters.scoreMin}`}</span> : null}
              {filters.scoreMax ? <span className="filter-pill">{`最大分: ${filters.scoreMax}`}</span> : null}
              <Link href={buildDetailHref(id, activeTab, filters.q, "all", "", "")} className="text-btn">
                清空筛选
              </Link>
            </section>
          ) : null}

          <section className="card table-card">
            <table>
              <thead>
                <tr>
                  <th>状态</th>
                  <th>ID</th>
                  <th>input</th>
                  <th>reference_output</th>
                  <th>trajectory</th>
                  <th>actual_output</th>
                  <th>汇总得分</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {caseRows.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <span className={`status-pill ${row.status}`}>{row.status}</span>
                    </td>
                    <td>
                      <code>#{row.data_item_id}</code>
                    </td>
                    <td className="exp-table-cell-truncate">{row.user_input || "-"}</td>
                    <td className="exp-table-cell-truncate">{JSON.stringify(row.reference_output ?? {}).slice(0, 120) || "-"}</td>
                    <td className="exp-table-cell-truncate">{JSON.stringify(row.agent_trajectory ?? []).slice(0, 120) || "-"}</td>
                    <td className="exp-table-cell-truncate">{JSON.stringify(row.agent_output ?? {}).slice(0, 120) || "-"}</td>
                    <td>{row.final_score ?? "-"}</td>
                    <td>
                      <Link
                        href={`${baseHref}${baseHref.includes("?") ? "&" : "?"}panel=case&caseId=${row.id}`}
                        className="text-btn"
                      >
                        详情
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : null}

      {activeTab === "metrics" ? (
        <section className="grid">
          <div className="exp-metric-grid">
            <section className="card">
              <h3>评估器聚合得分</h3>
              <div className="stat">{summary.avg_score != null ? Number(summary.avg_score).toFixed(3) : "-"}</div>
            </section>
            <section className="card">
              <h3>评测对象执行耗时</h3>
              <div className="stat">{summary.avg_latency != null ? `${Math.round(Number(summary.avg_latency))}ms` : "-"}</div>
            </section>
            <section className="card">
              <h3>评测对象 Tokens 消耗</h3>
              <div className="muted">Input: {inputTokens}</div>
              <div className="muted">Output: {outputTokens}</div>
              <div className="stat">{totalTokens}</div>
            </section>
          </div>

          <section className="card table-card">
            <div className="section-title-row">
              <h2>得分明细</h2>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Evaluator</th>
                  <th>Avg</th>
                  <th>样本数</th>
                  <th>分布</th>
                </tr>
              </thead>
              <tbody>
                {evaluatorMetrics.rows.map((item) => {
                  const avg = item.avg_score != null ? Number(item.avg_score) : 0;
                  return (
                    <tr key={item.evaluator_name}>
                      <td>{item.evaluator_name}</td>
                      <td>{item.avg_score != null ? avg.toFixed(3) : "-"}</td>
                      <td>{Number(item.count_num)}</td>
                      <td>
                        <div className="exp-mini-bar-track">
                          <div className="exp-mini-bar" style={{ width: `${Math.max(4, Math.round(avg * 100))}%` }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </section>
      ) : null}

      {activeTab === "config" ? (
        <section className="grid cols-2">
          <section className="card">
            <h3>实验配置</h3>
            <p className="muted">Dataset: {e.dataset_name}</p>
            <p className="muted">
              Agent: <code>{`${e.agent_key}@${e.agent_version}`}</code>
            </p>
            <p className="muted">
              Image: <code>{e.docker_image}</code>
            </p>
          </section>
          <section className="card">
            <h3>Evaluators</h3>
            <div className="tag-row">
              {evaluatorRows.rows.map((row) => (
                <span key={row.evaluator_id} className="tag">
                  {row.evaluator_name}
                </span>
              ))}
            </div>
            <p className="muted" style={{ marginTop: 10 }}>
              创建时间: {new Date(e.created_at).toLocaleString()}
            </p>
            <p className="muted">开始时间: {e.started_at ? new Date(e.started_at).toLocaleString() : "-"}</p>
            <p className="muted">结束时间: {e.finished_at ? new Date(e.finished_at).toLocaleString() : "-"}</p>
          </section>
        </section>
      ) : null}

      {panel === "filter" ? (
        <div className="action-overlay">
          <Link href={baseHref} className="action-overlay-dismiss" aria-label="关闭筛选" />
          <aside className="action-drawer">
            <div className="action-drawer-header">
              <h3>筛选 RunCases</h3>
              <Link href={baseHref} className="icon-btn" aria-label="关闭">
                <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
              </Link>
            </div>
            <div className="action-drawer-body">
              <form action={`/experiments/${id}`} className="menu-form">
                <input type="hidden" name="tab" value="details" />
                <input type="hidden" name="q" value={filters.q} />
                <input type="hidden" name="panel" value="none" />
                <label className="field-label">状态</label>
                <div className="chip-row">
                  {[
                    { value: "all", label: "全部" },
                    { value: "success", label: "success" },
                    { value: "failed", label: "failed" },
                    { value: "running", label: "running" },
                    { value: "pending", label: "pending" }
                  ].map((item) => (
                    <label key={item.value} className="chip">
                      <input type="radio" name="status" value={item.value} defaultChecked={filters.status === item.value} />
                      {item.label}
                    </label>
                  ))}
                </div>
                <label className="field-label">最小得分</label>
                <input name="scoreMin" type="number" min="0" max="1" step="0.1" defaultValue={filters.scoreMin} />
                <label className="field-label">最大得分</label>
                <input name="scoreMax" type="number" min="0" max="1" step="0.1" defaultValue={filters.scoreMax} />
                <SubmitButton pendingText="应用中...">应用筛选</SubmitButton>
                <Link href={buildDetailHref(id, "details", filters.q, "all", "", "")} className="ghost-btn">
                  重置筛选
                </Link>
              </form>
            </div>
          </aside>
        </div>
      ) : null}

      {panel === "case" && selectedCase.rowCount > 0 ? (
        <EntityDrawer closeHref={baseHref} title={`RunCase #${selectedCase.rows[0].id}`}>
          <section className="grid">
            <div className="card">
              <div className="tag-row">
                <span className={`status-pill ${selectedCase.rows[0].status}`}>{selectedCase.rows[0].status}</span>
                <span className="tag">attempt {selectedCase.rows[0].attempt_no}</span>
                <span className="tag">score {selectedCase.rows[0].final_score ?? "-"}</span>
                <span className="tag">latency {selectedCase.rows[0].latency_ms ?? "-"}ms</span>
              </div>
              <p className="muted">input tokens: {selectedCase.rows[0].input_tokens ?? "-"}</p>
              <p className="muted">output tokens: {selectedCase.rows[0].output_tokens ?? "-"}</p>
              <p className="muted">error: {selectedCase.rows[0].error_message ?? "-"}</p>
            </div>

            <div className="card">
              <h3>Evaluator 评分</h3>
              <table>
                <thead>
                  <tr>
                    <th>Evaluator</th>
                    <th>Score</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedCaseEvals.rows.map((row) => (
                    <tr key={row.evaluator_name}>
                      <td>{row.evaluator_name}</td>
                      <td>{row.score}</td>
                      <td className="exp-table-cell-truncate">{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card">
              <h3>尝试记录</h3>
              <div className="attempt-timeline">
                {attempts.rows.map((row) => (
                  <div key={row.id} className="attempt-item">
                    <code>#{row.id}</code>
                    <span>attempt {row.attempt_no}</span>
                    <span className={`status-pill ${row.status}`}>{row.status}</span>
                    <span className="muted">score: {row.final_score ?? "-"}</span>
                    <span className="muted">{new Date(row.updated_at).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <h3>输入与结果</h3>
              <p className="muted">input</p>
              <pre>{selectedCase.rows[0].user_input || "-"}</pre>
              <p className="muted">reference_output</p>
              <pre>{JSON.stringify(selectedCase.rows[0].reference_output ?? {}, null, 2)}</pre>
              <p className="muted">agent_output</p>
              <pre>{JSON.stringify(selectedCase.rows[0].agent_output ?? {}, null, 2)}</pre>
              <p className="muted">trajectory</p>
              <pre>{JSON.stringify(selectedCase.rows[0].agent_trajectory ?? [], null, 2)}</pre>
            </div>
          </section>
        </EntityDrawer>
      ) : null}
    </div>
  );
}
