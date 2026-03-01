import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { dbQuery } from "@/lib/db";
import { formatDateTime } from "@/lib/datetime";
import { PaginationControls } from "@/app/components/pagination-controls";
import { clampPage, getOffset, parsePage, parsePageSize } from "@/lib/pagination";
import { requireUser } from "@/lib/supabase-auth";
import { retryFailedRunCases, terminateExperiment } from "@/lib/runner";
import { ArrowLeftIcon, FilterIcon, FlaskIcon, SearchIcon } from "@/app/components/icons";
import { SubmitButton } from "@/app/components/submit-button";
import { EntityDrawer } from "@/app/components/entity-drawer";
import { DevToastButton } from "@/app/components/dev-toast-button";
import { ExpandableTextCell } from "@/app/components/expandable-text-cell";

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

function buildDetailHref(id: number, tab: string, q: string, status: string, scoreMin: string, scoreMax: string, page: number, pageSize: number) {
  const params = new URLSearchParams();
  if (tab !== "details") params.set("tab", tab);
  if (q) params.set("q", q);
  if (status !== "all") params.set("status", status);
  if (scoreMin) params.set("scoreMin", scoreMin);
  if (scoreMax) params.set("scoreMax", scoreMax);
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 10) params.set("pageSize", String(pageSize));
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

async function terminate(formData: FormData) {
  "use server";
  const user = await requireUser();
  const id = Number(String(formData.get("id") ?? "0"));
  if (!Number.isInteger(id) || id <= 0) return;
  await terminateExperiment(id, user.id);
  revalidatePath(`/experiments/${id}`);
  revalidatePath("/experiments");
  redirect(`/experiments/${id}`);
}

export default async function ExperimentDetailPage({
  params,
  searchParams
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; q?: string; status?: string; scoreMin?: string; scoreMax?: string; panel?: string; caseId?: string; page?: string; pageSize?: string }>;
}) {
  await requireUser();

  const { id: idParam } = await params;
  const id = Number(idParam.trim());
  if (!Number.isInteger(id) || id <= 0) {
    return <section className="card">实验不存在</section>;
  }

  const { tab = "details", q = "", status = "all", scoreMin = "", scoreMax = "", panel = "none", caseId = "", page: pageRaw, pageSize: pageSizeRaw } = await searchParams;
  const activeTab = ["details", "metrics", "config"].includes(tab) ? tab : "details";
  const filters = {
    q: q.trim(),
    status: status.trim() || "all",
    scoreMin: scoreMin.trim(),
    scoreMax: scoreMax.trim()
  };
  const pageSize = parsePageSize(pageSizeRaw);
  const requestedPage = parsePage(pageRaw);

  const scoreMinNum = filters.scoreMin ? Number(filters.scoreMin) : null;
  const scoreMaxNum = filters.scoreMax ? Number(filters.scoreMax) : null;

  const caseFilterParams = [id, filters.q, filters.status, filters.status, scoreMinNum, scoreMinNum, scoreMaxNum, scoreMaxNum];
  const caseCountResult = await dbQuery<{ total_count: number | string }>(
    `SELECT COUNT(*) AS total_count
     FROM run_cases rc
     JOIN data_items di ON di.id = rc.data_item_id
     WHERE rc.experiment_id = $1
       AND rc.is_latest = TRUE
       AND ($2 = '' OR LOWER(di.user_input) LIKE CONCAT('%', LOWER($2), '%'))
       AND ($3 = 'all' OR rc.status = $4)
       AND ($5 IS NULL OR rc.final_score >= $6)
       AND ($7 IS NULL OR rc.final_score <= $8)`,
    caseFilterParams
  );
  const caseTotal = Number(caseCountResult.rows[0]?.total_count ?? 0);
  const page = clampPage(requestedPage, caseTotal, pageSize);
  const offset = getOffset(page, pageSize);

  const baseHref = buildDetailHref(id, activeTab, filters.q, filters.status, filters.scoreMin, filters.scoreMax, page, pageSize);
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
      queue_status: string;
      queue_message_id: string | null;
      queued_at: string | null;
      started_at: string | null;
      finished_at: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT e.id, e.name, e.dataset_id, d.name AS dataset_name,
              e.agent_id, a.agent_key, a.version AS agent_version, a.docker_image,
              e.queue_status, e.queue_message_id, e.queued_at, e.started_at, e.finished_at,
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
          SUM(CASE WHEN status IN ('failed','timeout') THEN 1 ELSE 0 END) AS failed_count,
          SUM(CASE WHEN status IN ('running','trajectory','scoring') THEN 1 ELSE 0 END) AS running_count,
          SUM(CASE WHEN status IN ('pending','queued') THEN 1 ELSE 0 END) AS pending_count
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
      usage_json: unknown;
      error_message: string | null;
      user_input: string;
      reference_output: unknown;
      updated_at: string;
      attempt_no: number;
    }>(
      `SELECT rc.id, rc.data_item_id, rc.status, rc.final_score, rc.agent_trajectory, rc.agent_output, rc.usage_json,
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
       LIMIT $9 OFFSET $10`,
      [...caseFilterParams, pageSize, offset]
    ),
    dbQuery<{
      avg_score: number | null;
      avg_latency: number | null;
      max_latency: number | null;
      input_tokens: number | string | null;
      output_tokens: number | string | null;
    }>(
      `SELECT
          AVG(final_score) AS avg_score,
          AVG(latency_ms) AS avg_latency,
          MAX(latency_ms) AS max_latency,
          SUM(COALESCE(input_tokens, 0)) AS input_tokens,
          SUM(COALESCE(output_tokens, 0)) AS output_tokens
       FROM run_cases
       WHERE experiment_id = $1 AND is_latest = TRUE`,
      [id]
    ),
    dbQuery<{ evaluator_name: string; avg_score: number | null; count_num: number | string }>(
      `SELECT rcs.scorer_key AS evaluator_name,
              AVG(rcs.score) AS avg_score,
              COUNT(*) AS count_num
       FROM run_case_scores rcs
       JOIN run_cases rc ON rc.id = rcs.run_case_id
       WHERE rc.experiment_id = $1 AND rc.is_latest = TRUE
       GROUP BY rcs.scorer_key
       ORDER BY rcs.scorer_key ASC`,
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
          usage_json: unknown;
          started_at: string | null;
          finished_at: string | null;
          user_input: string;
          reference_output: unknown;
          reference_trajectory: unknown;
        }>(
          `SELECT rc.id, rc.data_item_id, rc.attempt_no, rc.status, rc.final_score,
                  rc.latency_ms, rc.input_tokens, rc.output_tokens, rc.error_message, rc.logs,
                  rc.agent_trajectory, rc.agent_output, rc.usage_json, rc.started_at, rc.finished_at,
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
          `SELECT rcs.scorer_key AS evaluator_name, rcs.score, rcs.reason
           FROM run_case_scores rcs
           WHERE rcs.run_case_id = $1
           ORDER BY rcs.scorer_key ASC`,
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
  const doneCount = Math.max(0, totalCount - runningCount - pendingCount);
  const hasFailedCases = failedCount > 0;
  const canTerminate = e.queue_status === "queued" || e.queue_status === "consuming" || e.queue_status === "test_case";
  const canStart = e.queue_status === "idle" || e.queue_status === "manual_terminated";

  const summary = metrics.rows[0] ?? { avg_score: null, avg_latency: null, max_latency: null, input_tokens: 0, output_tokens: 0 };
  const inputTokens = Number(summary.input_tokens ?? 0);
  const outputTokens = Number(summary.output_tokens ?? 0);
  const totalTokens = inputTokens + outputTokens;

  const hasFilter = filters.status !== "all" || !!filters.scoreMin || !!filters.scoreMax;
  const casePaginationQuery = {
    tab: activeTab === "details" ? "" : activeTab,
    q: filters.q,
    status: filters.status === "all" ? "" : filters.status,
    scoreMin: filters.scoreMin,
    scoreMax: filters.scoreMax
  };

  const timingRows = caseRows.rows
    .map((row) => {
      const usage = row.usage_json && typeof row.usage_json === "object" ? (row.usage_json as Record<string, unknown>) : null;
      const timings = usage?.timings_ms && typeof usage.timings_ms === "object" ? (usage.timings_ms as Record<string, unknown>) : null;
      if (!timings) return null;
      return {
        sandboxConnect: Number(timings.sandbox_connect ?? 0),
        caseExec: Number(timings.case_exec ?? 0),
        otelQuery: Number(timings.otel_query ?? 0),
        scorerTotal: Number(timings.scorer_total ?? 0),
        total: Number(timings.total ?? 0)
      };
    })
    .filter((item): item is { sandboxConnect: number; caseExec: number; otelQuery: number; scorerTotal: number; total: number } => {
      return !!item && Number.isFinite(item.total);
    });
  const avgTiming = timingRows.length
    ? timingRows.reduce(
        (acc, item) => ({
          sandboxConnect: acc.sandboxConnect + item.sandboxConnect,
          caseExec: acc.caseExec + item.caseExec,
          otelQuery: acc.otelQuery + item.otelQuery,
          scorerTotal: acc.scorerTotal + item.scorerTotal,
          total: acc.total + item.total
        }),
        { sandboxConnect: 0, caseExec: 0, otelQuery: 0, scorerTotal: 0, total: 0 }
      )
    : { sandboxConnect: 0, caseExec: 0, otelQuery: 0, scorerTotal: 0, total: 0 };
  const avgTimingDivisor = timingRows.length > 0 ? timingRows.length : 1;

  return (
    <div className="grid">
      <section className="detail-head refined exp-header-strip">
        <div className="exp-header-main">
          <div className="exp-title-row">
            <Link href="/experiments" className="icon-btn" aria-label="返回 Experiments">
              <ArrowLeftIcon width={16} height={16} />
            </Link>
            <h1>{e.name}</h1>
            <span className={`status-pill ${e.queue_status}`}>{e.queue_status}</span>
          </div>
          <div className="exp-kpi-chip-row">
            <span className="exp-kpi-chip">总条数 {totalCount}</span>
            <span className="exp-kpi-chip">成功 {successCount}</span>
            <span className="exp-kpi-chip">失败 {failedCount}</span>
            <span className="exp-kpi-chip">执行中 {runningCount}</span>
            <span className="exp-kpi-chip">待执行 {pendingCount}</span>
            <span className="exp-kpi-chip">实验时长 {formatDuration(e.started_at, e.finished_at)}</span>
          </div>
        </div>
        <div className="exp-header-actions">
          <DevToastButton
            experimentId={id}
            label={e.queue_status === "manual_terminated" ? "重新启动" : "启动实验"}
            blockedReason={!canStart ? "实验已启动过，请使用“重试失败”继续执行失败项" : null}
          />
          <form action={retryFailed}>
            <input type="hidden" name="id" value={id} />
            <SubmitButton className="ghost-btn" pendingText="重试中..." disabled={!hasFailedCases}>
              重试失败
            </SubmitButton>
          </form>
          <form action={terminate}>
            <input type="hidden" name="id" value={id} />
            <SubmitButton className="ghost-btn" pendingText="终止中..." disabled={!canTerminate}>
              终止
            </SubmitButton>
          </form>
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
            href={buildDetailHref(id, item.key, filters.q, filters.status, filters.scoreMin, filters.scoreMax, page, pageSize)}
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
              <input type="hidden" name="pageSize" value={pageSize} />
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
              <PaginationControls basePath={`/experiments/${id}`} query={casePaginationQuery} total={caseTotal} page={page} pageSize={pageSize} position="top" variant="compact" />
            </div>
          </section>

          {hasFilter ? (
            <section className="active-filters">
              <span className="muted">当前筛选:</span>
              {filters.status !== "all" ? <span className="filter-pill">{`状态: ${filters.status}`}</span> : null}
              {filters.scoreMin ? <span className="filter-pill">{`最小分: ${filters.scoreMin}`}</span> : null}
              {filters.scoreMax ? <span className="filter-pill">{`最大分: ${filters.scoreMax}`}</span> : null}
              <Link href={buildDetailHref(id, activeTab, filters.q, "all", "", "", 1, pageSize)} className="text-btn">
                清空筛选
              </Link>
            </section>
          ) : null}

          <section className="card table-card">
            <table className="exp-runcase-table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>数据库主键</th>
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
                      <code>#{row.id}</code>
                    </td>
                    <td>
                      <ExpandableTextCell value={row.user_input} previewLength={120} className="exp-table-cell-truncate" />
                    </td>
                    <td>
                      <ExpandableTextCell value={row.reference_output ?? {}} previewLength={120} className="exp-table-cell-truncate" />
                    </td>
                    <td>
                      <ExpandableTextCell value={row.agent_trajectory ?? []} previewLength={120} className="exp-table-cell-truncate" />
                    </td>
                    <td>
                      <ExpandableTextCell value={row.agent_output ?? {}} previewLength={120} className="exp-table-cell-truncate" />
                    </td>
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
            <PaginationControls basePath={`/experiments/${id}`} query={casePaginationQuery} total={caseTotal} page={page} pageSize={pageSize} position="bottom" />
          </section>
        </>
      ) : null}

      {activeTab === "metrics" ? (
        <section className="grid">
          <div className="exp-metric-grid refined">
            <section className="card exp-metric-card">
              <p className="exp-metric-label">评估器聚合得分</p>
              <div className="exp-metric-value">{summary.avg_score != null ? Number(summary.avg_score).toFixed(3) : "-"}</div>
              <p className="exp-metric-meta">全量 RunCase 平均分</p>
            </section>
            <section className="card exp-metric-card">
              <p className="exp-metric-label">执行进度</p>
              <div className="exp-metric-value">{`${Math.round(totalCount > 0 ? (doneCount / totalCount) * 100 : 0)}%`}</div>
              <p className="exp-metric-meta">{`完成 ${doneCount}/${totalCount} · 失败 ${failedCount}`}</p>
            </section>
            <section className="card exp-metric-card">
              <p className="exp-metric-label">Case 平均耗时</p>
              <div className="exp-metric-value">{formatLatencyMs(summary.avg_latency)}</div>
              <p className="exp-metric-meta">{`最大 ${formatLatencyMs(summary.max_latency)}`}</p>
            </section>
            <section className="card exp-metric-card">
              <p className="exp-metric-label">Token 消耗</p>
              <div className="exp-metric-value">{totalTokens.toLocaleString()}</div>
              <p className="exp-metric-meta">{`Input ${inputTokens.toLocaleString()} · Output ${outputTokens.toLocaleString()}`}</p>
            </section>
          </div>

          <section className="card exp-stage-card">
            <div className="section-title-row">
              <h2>阶段耗时（平均）</h2>
            </div>
            <div className="exp-stage-grid">
              {[
                { label: "Docker 启动", value: formatLatencyMs(avgTiming.sandboxConnect / avgTimingDivisor) },
                { label: "Case 执行", value: formatLatencyMs(avgTiming.caseExec / avgTimingDivisor) },
                { label: "OTel 查询", value: formatLatencyMs(avgTiming.otelQuery / avgTimingDivisor) },
                { label: "Scoring", value: formatLatencyMs(avgTiming.scorerTotal / avgTimingDivisor) },
                { label: "总耗时", value: formatLatencyMs(avgTiming.total / avgTimingDivisor) }
              ].map((item) => (
                <div key={item.label} className="exp-stage-item">
                  <span className="exp-stage-label">{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </div>
          </section>

          <section className="card table-card">
            <div className="section-title-row">
              <h2>Evaluator 得分分布</h2>
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
        <section className="grid">
          <section className="card exp-config-card">
            <div className="section-title-row">
              <h2>实验基础配置</h2>
            </div>
            <dl className="exp-config-list">
              <div className="exp-config-item">
                <dt>Experiment ID</dt>
                <dd>
                  <code>#{e.id}</code>
                </dd>
              </div>
              <div className="exp-config-item">
                <dt>Experiment 名称</dt>
                <dd>{e.name}</dd>
              </div>
              <div className="exp-config-item">
                <dt>Dataset</dt>
                <dd>{e.dataset_name}</dd>
              </div>
              <div className="exp-config-item">
                <dt>Agent</dt>
                <dd>
                  <code>{`${e.agent_key}@${e.agent_version}`}</code>
                </dd>
              </div>
              <div className="exp-config-item">
                <dt>Docker Image</dt>
                <dd>
                  <code>{e.docker_image}</code>
                </dd>
              </div>
            </dl>
          </section>

          <section className="card exp-config-card">
            <div className="section-title-row">
              <h2>Evaluators</h2>
            </div>
            <div className="tag-row">
              {evaluatorRows.rows.map((row) => (
                <span key={row.evaluator_id} className="tag">
                  {row.evaluator_name}
                </span>
              ))}
            </div>
          </section>

          <section className="card exp-config-card">
            <div className="section-title-row">
              <h2>运行与队列信息</h2>
            </div>
            <dl className="exp-config-list">
              <div className="exp-config-item">
                <dt>MQ 状态</dt>
                <dd>
                  <span className={`status-pill ${e.queue_status}`}>{e.queue_status}</span>
                </dd>
              </div>
              <div className="exp-config-item">
                <dt>创建时间</dt>
                <dd>{formatDateTime(e.created_at)}</dd>
              </div>
              <div className="exp-config-item">
                <dt>开始时间</dt>
                <dd>{formatDateTime(e.started_at)}</dd>
              </div>
              <div className="exp-config-item">
                <dt>结束时间</dt>
                <dd>{formatDateTime(e.finished_at)}</dd>
              </div>
              <div className="exp-config-item">
                <dt>实验时长</dt>
                <dd>{formatDuration(e.started_at, e.finished_at)}</dd>
              </div>
              <div className="exp-config-item">
                <dt>入队时间</dt>
                <dd>{formatDateTime(e.queued_at)}</dd>
              </div>
              <div className="exp-config-item">
                <dt>Message ID</dt>
                <dd>
                  <code>{e.queue_message_id ?? "-"}</code>
                </dd>
              </div>
            </dl>
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
                <input type="hidden" name="pageSize" value={pageSize} />
                <label className="field-label">状态</label>
                <div className="chip-row">
                  {[
                    { value: "all", label: "全部" },
                    { value: "success", label: "success" },
                    { value: "failed", label: "failed" },
                    { value: "running", label: "running" },
                    { value: "pending", label: "pending" },
                    { value: "canceled", label: "canceled" }
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
                <Link href={buildDetailHref(id, "details", filters.q, "all", "", "", 1, pageSize)} className="ghost-btn">
                  重置筛选
                </Link>
              </form>
            </div>
          </aside>
        </div>
      ) : null}

      {panel === "case" && selectedCase.rowCount > 0 ? (
        <EntityDrawer
          closeHref={baseHref}
          title={`RunCase #${selectedCase.rows[0].id}`}
          drawerClassName="case-detail-drawer"
          bodyClassName="case-detail-body"
        >
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
              <p className="muted">
                阶段耗时:
                {" "}
                {(() => {
                  const usage = selectedCase.rows[0].usage_json && typeof selectedCase.rows[0].usage_json === "object"
                    ? (selectedCase.rows[0].usage_json as Record<string, unknown>)
                    : null;
                  const timings = usage?.timings_ms && typeof usage.timings_ms === "object"
                    ? (usage.timings_ms as Record<string, unknown>)
                    : null;
                  if (!timings) return "-";
                  return [
                    `Docker ${formatLatencyMs(Number(timings.sandbox_connect ?? 0))}`,
                    `Run ${formatLatencyMs(Number(timings.case_exec ?? 0))}`,
                    `OTel ${formatLatencyMs(Number(timings.otel_query ?? 0))}`,
                    `Score ${formatLatencyMs(Number(timings.scorer_total ?? 0))}`,
                    `Total ${formatLatencyMs(Number(timings.total ?? 0))}`
                  ].join(" | ");
                })()}
              </p>
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
                      <td>
                        <ExpandableTextCell value={row.reason || "-"} previewLength={220} className="exp-eval-reason-cell" />
                      </td>
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
                    <span className="muted">{formatDateTime(row.updated_at)}</span>
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
