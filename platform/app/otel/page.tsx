import { revalidatePath } from "next/cache";
import { dbQuery } from "@/lib/db";
import { formatDateTime } from "@/lib/datetime";
import { PaginationControls } from "@/app/components/pagination-controls";
import { BulkSelectionControls } from "@/app/components/bulk-selection-controls";
import { ingestLogPayload, ingestTracePayload } from "@/lib/otel";
import { clampPage, getOffset, parsePage, parsePageSize } from "@/lib/pagination";
import { parseSelectedIds } from "@/lib/form-ids";
import { parseJsonOrWrap } from "@/lib/safe-json";
import { requireUser } from "@/lib/supabase-auth";
import Link from "next/link";
import { redirect } from "next/navigation";
import { FilterIcon, PlusIcon, RefreshIcon, SearchIcon, TraceIcon } from "../components/icons";
import { SubmitButton } from "../components/submit-button";
import { TextareaWithFileUpload } from "../components/textarea-with-file-upload";

type OTelTab = "traces" | "logs";

function buildListHref(
  tab: OTelTab,
  q: string,
  service: string,
  severity: string,
  page: number,
  pageSize: number,
  extras?: Record<string, string>
) {
  const params = new URLSearchParams();
  params.set("tab", tab);
  if (q) params.set("q", q);
  if (service !== "all") params.set("service", service);
  if (tab === "logs" && severity !== "all") params.set("severity", severity);
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 10) params.set("pageSize", String(pageSize));
  for (const [key, value] of Object.entries(extras ?? {})) {
    if (value) params.set(key, value);
  }
  return `/otel?${params.toString()}`;
}

function toDatetimeLocal(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function parseOptionalInt(raw: string) {
  const value = raw.trim();
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

async function ingestManualTrace(formData: FormData) {
  "use server";
  await requireUser();

  const payloadRaw = String(formData.get("payload") ?? "{}");
  const q = String(formData.get("q") ?? "").trim();
  const service = String(formData.get("service") ?? "all").trim() || "all";
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));
  const nextParams = new URLSearchParams();
  nextParams.set("tab", "traces");
  if (q) nextParams.set("q", q);
  if (service !== "all") nextParams.set("service", service);
  if (page > 1) nextParams.set("page", String(page));
  if (pageSize !== 10) nextParams.set("pageSize", String(pageSize));
  nextParams.set("panel", "ingest");

  try {
    const payload = JSON.parse(payloadRaw) as Record<string, unknown>;
    const inserted = await ingestTracePayload(payload);
    nextParams.set("result", "ok");
    nextParams.set("inserted", String(inserted));
  } catch (error) {
    nextParams.set("result", "error");
    nextParams.set("message", error instanceof Error ? error.message : "invalid payload");
  }

  revalidatePath("/otel");
  redirect(`/otel?${nextParams.toString()}`);
}

async function ingestManualLog(formData: FormData) {
  "use server";
  await requireUser();

  const payloadRaw = String(formData.get("payload") ?? "{}");
  const q = String(formData.get("q") ?? "").trim();
  const service = String(formData.get("service") ?? "all").trim() || "all";
  const severity = String(formData.get("severity") ?? "all").trim() || "all";
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));
  const nextParams = new URLSearchParams();
  nextParams.set("tab", "logs");
  if (q) nextParams.set("q", q);
  if (service !== "all") nextParams.set("service", service);
  if (severity !== "all") nextParams.set("severity", severity);
  if (page > 1) nextParams.set("page", String(page));
  if (pageSize !== 10) nextParams.set("pageSize", String(pageSize));
  nextParams.set("panel", "ingest");

  try {
    const payload = JSON.parse(payloadRaw) as Record<string, unknown>;
    const inserted = await ingestLogPayload(payload);
    nextParams.set("result", "ok");
    nextParams.set("inserted", String(inserted));
  } catch (error) {
    nextParams.set("result", "error");
    nextParams.set("message", error instanceof Error ? error.message : "invalid payload");
  }

  revalidatePath("/otel");
  redirect(`/otel?${nextParams.toString()}`);
}

async function updateTrace(formData: FormData) {
  "use server";
  await requireUser();

  const id = Number(String(formData.get("id") ?? "").trim());
  const name = String(formData.get("name") ?? "").trim();
  if (!Number.isInteger(id) || id <= 0 || !name) return;

  const q = String(formData.get("q") ?? "").trim();
  const service = String(formData.get("service") ?? "all").trim() || "all";
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));

  await dbQuery(
    `UPDATE otel_traces
     SET trace_id = NULLIF($2, ''),
         span_id = NULLIF($3, ''),
         parent_span_id = NULLIF($4, ''),
         name = $5,
         service_name = NULLIF($6, ''),
         status = NULLIF($7, ''),
         attributes = $8,
         resource_attributes = $9,
         scope_attributes = $10,
         scope_name = NULLIF($11, ''),
         scope_version = NULLIF($12, ''),
         start_time = $13,
         end_time = $14,
         run_case_id = $15,
         experiment_id = $16,
         raw = $17
     WHERE id = $1 AND deleted_at IS NULL`,
    [
      id,
      String(formData.get("traceId") ?? "").trim(),
      String(formData.get("spanId") ?? "").trim(),
      String(formData.get("parentSpanId") ?? "").trim(),
      name,
      String(formData.get("serviceName") ?? "").trim(),
      String(formData.get("status") ?? "").trim(),
      JSON.stringify(parseJsonOrWrap(String(formData.get("attributes") ?? "{}"))),
      JSON.stringify(parseJsonOrWrap(String(formData.get("resourceAttributes") ?? "{}"))),
      JSON.stringify(parseJsonOrWrap(String(formData.get("scopeAttributes") ?? "{}"))),
      String(formData.get("scopeName") ?? "").trim(),
      String(formData.get("scopeVersion") ?? "").trim(),
      (() => {
        const raw = String(formData.get("startTime") ?? "").trim();
        return raw ? new Date(raw).toISOString() : null;
      })(),
      (() => {
        const raw = String(formData.get("endTime") ?? "").trim();
        return raw ? new Date(raw).toISOString() : null;
      })(),
      parseOptionalInt(String(formData.get("runCaseId") ?? "")),
      parseOptionalInt(String(formData.get("experimentId") ?? "")),
      JSON.stringify(parseJsonOrWrap(String(formData.get("raw") ?? "{}")))
    ]
  );

  revalidatePath("/otel");
  redirect(buildListHref("traces", q, service, "all", page, pageSize));
}

async function softDeleteTraceById(id: number) {
  await dbQuery(
    `UPDATE otel_traces
     SET is_deleted = TRUE,
         deleted_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
}

async function deleteTrace(formData: FormData) {
  "use server";
  await requireUser();

  const id = Number(String(formData.get("id") ?? "").trim());
  if (!Number.isInteger(id) || id <= 0) return;

  const q = String(formData.get("q") ?? "").trim();
  const service = String(formData.get("service") ?? "all").trim() || "all";
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));

  await softDeleteTraceById(id);
  revalidatePath("/otel");
  redirect(buildListHref("traces", q, service, "all", page, pageSize));
}

async function bulkDeleteTrace(formData: FormData) {
  "use server";
  await requireUser();

  const ids = parseSelectedIds(formData);
  if (ids.length <= 0) return;

  const q = String(formData.get("q") ?? "").trim();
  const service = String(formData.get("service") ?? "all").trim() || "all";
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));

  for (const id of ids) {
    await softDeleteTraceById(id);
  }
  revalidatePath("/otel");
  redirect(buildListHref("traces", q, service, "all", page, pageSize));
}

async function updateLog(formData: FormData) {
  "use server";
  await requireUser();

  const id = Number(String(formData.get("id") ?? "").trim());
  if (!Number.isInteger(id) || id <= 0) return;

  const q = String(formData.get("q") ?? "").trim();
  const service = String(formData.get("service") ?? "all").trim() || "all";
  const severity = String(formData.get("severity") ?? "all").trim() || "all";
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));

  await dbQuery(
    `UPDATE otel_logs
     SET trace_id = NULLIF($2, ''),
         span_id = NULLIF($3, ''),
         service_name = NULLIF($4, ''),
         severity_text = NULLIF($5, ''),
         severity_number = $6,
         body_text = NULLIF($7, ''),
         body_json = $8,
         attributes = $9,
         resource_attributes = $10,
         scope_attributes = $11,
         scope_name = NULLIF($12, ''),
         scope_version = NULLIF($13, ''),
         flags = $14,
         dropped_attributes_count = $15,
         event_time = $16,
         observed_time = $17,
         run_case_id = $18,
         experiment_id = $19,
         raw = $20
     WHERE id = $1 AND deleted_at IS NULL`,
    [
      id,
      String(formData.get("traceId") ?? "").trim(),
      String(formData.get("spanId") ?? "").trim(),
      String(formData.get("serviceName") ?? "").trim(),
      String(formData.get("severityText") ?? "").trim(),
      (() => {
        const raw = String(formData.get("severityNumber") ?? "").trim();
        if (!raw) return null;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
      })(),
      String(formData.get("bodyText") ?? "").trim(),
      (() => {
        const raw = String(formData.get("bodyJson") ?? "").trim();
        if (!raw) return null;
        return JSON.stringify(parseJsonOrWrap(raw));
      })(),
      JSON.stringify(parseJsonOrWrap(String(formData.get("attributes") ?? "{}"))),
      JSON.stringify(parseJsonOrWrap(String(formData.get("resourceAttributes") ?? "{}"))),
      JSON.stringify(parseJsonOrWrap(String(formData.get("scopeAttributes") ?? "{}"))),
      String(formData.get("scopeName") ?? "").trim(),
      String(formData.get("scopeVersion") ?? "").trim(),
      (() => {
        const raw = String(formData.get("flags") ?? "").trim();
        if (!raw) return null;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
      })(),
      (() => {
        const raw = String(formData.get("droppedAttributesCount") ?? "").trim();
        if (!raw) return null;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
      })(),
      (() => {
        const raw = String(formData.get("eventTime") ?? "").trim();
        return raw ? new Date(raw).toISOString() : null;
      })(),
      (() => {
        const raw = String(formData.get("observedTime") ?? "").trim();
        return raw ? new Date(raw).toISOString() : null;
      })(),
      parseOptionalInt(String(formData.get("runCaseId") ?? "")),
      parseOptionalInt(String(formData.get("experimentId") ?? "")),
      JSON.stringify(parseJsonOrWrap(String(formData.get("raw") ?? "{}")))
    ]
  );

  revalidatePath("/otel");
  redirect(buildListHref("logs", q, service, severity, page, pageSize));
}

async function softDeleteLogById(id: number) {
  await dbQuery(
    `UPDATE otel_logs
     SET is_deleted = TRUE,
         deleted_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
}

async function deleteLog(formData: FormData) {
  "use server";
  await requireUser();

  const id = Number(String(formData.get("id") ?? "").trim());
  if (!Number.isInteger(id) || id <= 0) return;

  const q = String(formData.get("q") ?? "").trim();
  const service = String(formData.get("service") ?? "all").trim() || "all";
  const severity = String(formData.get("severity") ?? "all").trim() || "all";
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));

  await softDeleteLogById(id);
  revalidatePath("/otel");
  redirect(buildListHref("logs", q, service, severity, page, pageSize));
}

async function bulkDeleteLog(formData: FormData) {
  "use server";
  await requireUser();

  const ids = parseSelectedIds(formData);
  if (ids.length <= 0) return;

  const q = String(formData.get("q") ?? "").trim();
  const service = String(formData.get("service") ?? "all").trim() || "all";
  const severity = String(formData.get("severity") ?? "all").trim() || "all";
  const page = parsePage(String(formData.get("page") ?? "1"));
  const pageSize = parsePageSize(String(formData.get("pageSize") ?? "10"));

  for (const id of ids) {
    await softDeleteLogById(id);
  }
  revalidatePath("/otel");
  redirect(buildListHref("logs", q, service, severity, page, pageSize));
}

export default async function OTelPage({
  searchParams
}: {
  searchParams: Promise<{
    tab?: string;
    q?: string;
    service?: string;
    severity?: string;
    panel?: string;
    id?: string;
    result?: string;
    inserted?: string;
    message?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  await requireUser();

  const {
    tab = "traces",
    q = "",
    service = "all",
    severity = "all",
    panel = "none",
    id = "",
    result = "",
    inserted = "",
    message = "",
    page: pageRaw,
    pageSize: pageSizeRaw
  } = await searchParams;

  const activeTab: OTelTab = tab === "logs" ? "logs" : "traces";
  const qv = q.trim();
  const serviceFilter = service.trim() || "all";
  const severityFilter = severity.trim() || "all";
  const pageSize = parsePageSize(pageSizeRaw);
  const requestedPage = parsePage(pageRaw);
  const ingesting = panel === "ingest";
  const detailId = Number(id.trim());
  const listHref = buildListHref(activeTab, qv, serviceFilter, severityFilter, requestedPage, pageSize);
  const ingestHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=ingest`;

  if (activeTab === "traces") {
    const countResult = await dbQuery<{ total_count: number | string }>(
      `SELECT COUNT(*) AS total_count
       FROM otel_traces
       WHERE ($1 = '' OR LOWER(COALESCE(trace_id, '')) LIKE CONCAT('%', LOWER($2), '%') OR LOWER(name) LIKE CONCAT('%', LOWER($3), '%'))
         AND deleted_at IS NULL
         AND ($4 = 'all' OR COALESCE(service_name, '-') = $5)`,
      [qv, qv, qv, serviceFilter, serviceFilter]
    );
    const total = Number(countResult.rows[0]?.total_count ?? 0);
    const page = clampPage(requestedPage, total, pageSize);
    const offset = getOffset(page, pageSize);
    const listHrefCurrent = buildListHref(activeTab, qv, serviceFilter, severityFilter, page, pageSize);

    const [rowsResult, serviceRows, detailRows] = await Promise.all([
      dbQuery<{
        id: number;
        trace_id: string | null;
        span_id: string | null;
        name: string;
        service_name: string | null;
        status: string | null;
        created_at: string;
      }>(
        `SELECT id, trace_id, span_id, name, service_name, status, created_at
         FROM otel_traces
         WHERE ($1 = '' OR LOWER(COALESCE(trace_id, '')) LIKE CONCAT('%', LOWER($2), '%') OR LOWER(name) LIKE CONCAT('%', LOWER($3), '%'))
           AND deleted_at IS NULL
           AND ($4 = 'all' OR COALESCE(service_name, '-') = $5)
         ORDER BY id DESC
         LIMIT $6 OFFSET $7`,
        [qv, qv, qv, serviceFilter, serviceFilter, pageSize, offset]
      ),
      dbQuery<{ service_name: string }>(
        `SELECT COALESCE(service_name, '-') AS service_name
         FROM otel_traces
         WHERE deleted_at IS NULL
         GROUP BY COALESCE(service_name, '-')
         ORDER BY service_name ASC`
      ),
      Number.isInteger(detailId) && detailId > 0
        ? dbQuery<{
            id: number;
            trace_id: string | null;
            span_id: string | null;
            parent_span_id: string | null;
            name: string;
            service_name: string | null;
            status: string | null;
            attributes: unknown;
            resource_attributes: unknown;
            scope_attributes: unknown;
            scope_name: string | null;
            scope_version: string | null;
            start_time: string | null;
            end_time: string | null;
            run_case_id: number | null;
            experiment_id: number | null;
            raw: unknown;
          }>(
            `SELECT id, trace_id, span_id, parent_span_id, name, service_name, status,
                    attributes, resource_attributes, scope_attributes, scope_name, scope_version,
                    start_time, end_time, run_case_id, experiment_id, raw
             FROM otel_traces
             WHERE id = $1 AND deleted_at IS NULL
             LIMIT 1`,
            [detailId]
          )
        : Promise.resolve({ rows: [], rowCount: 0 })
    ]);

    const services = serviceRows.rows.map((item) => item.service_name);
    const editing = detailRows.rows[0];
    const showEditor = panel === "detail" && Boolean(editing);
    const showFilter = panel === "filter";
    const bulkDeleteFormId = "otel-trace-bulk-delete-form";
    const filterHref = `${listHrefCurrent}${listHrefCurrent.includes("?") ? "&" : "?"}panel=filter`;

    return (
      <div className="grid">
        <section className="page-hero">
          <div className="breadcrumb">评测 &nbsp;/&nbsp; OTEL</div>
          <h1>OTEL</h1>
        </section>

        <section className="otel-tab-row">
          <div className="exp-tabs">
            <Link href={buildListHref("traces", qv, serviceFilter, "all", 1, pageSize)} className="exp-tab active">
              Traces
            </Link>
            <Link href={buildListHref("logs", qv, serviceFilter, severityFilter, 1, pageSize)} className="exp-tab">
              Logs
            </Link>
          </div>
        </section>

        <section className="toolbar-row">
          <form action="/otel" className="search-form">
            <input type="hidden" name="tab" value="traces" />
            <input type="hidden" name="pageSize" value={pageSize} />
            <input type="hidden" name="service" value={serviceFilter} />
            <label className="input-icon-wrap">
              <SearchIcon width={16} height={16} />
              <input name="q" defaultValue={qv} placeholder="搜索 trace id 或 span name" />
            </label>
            <button type="submit" className="ghost-btn">
              <SearchIcon width={16} height={16} /> 搜索
            </button>
          </form>

          <div className="action-group">
            <Link href={filterHref} className="ghost-btn">
              <FilterIcon width={16} height={16} /> 筛选
            </Link>
            <BulkSelectionControls formId={bulkDeleteFormId} variant="compact" confirmText="确认批量删除已选 {count} 条 Trace 吗？" />
            <PaginationControls basePath="/otel" query={{ tab: "traces", q: qv, service: serviceFilter === "all" ? "" : serviceFilter }} total={total} page={page} pageSize={pageSize} position="top" variant="compact" />
            <a href={listHrefCurrent} className="icon-btn" aria-label="刷新">
              <RefreshIcon width={16} height={16} />
            </a>
            <Link href={ingestHref} className="primary-btn">
              <PlusIcon width={16} height={16} /> 手动上报
            </Link>
          </div>
        </section>

        <section className="card table-card">
          <div className="section-title-row">
            <h2>
              <TraceIcon width={16} height={16} />
              OTEL Traces
            </h2>
            <span className="toolbar-hint">
              Endpoint: <code>POST /api/otel/v1/traces</code>
            </span>
          </div>
          <form id={bulkDeleteFormId} action={bulkDeleteTrace}>
            <input type="hidden" name="q" value={qv} />
            <input type="hidden" name="service" value={serviceFilter} />
            <input type="hidden" name="page" value={page} />
            <input type="hidden" name="pageSize" value={pageSize} />
          </form>
          <table className="otel-traces-table">
            <thead>
              <tr>
                <th className="bulk-select-cell">选</th>
                <th>ID</th>
                <th>TraceID</th>
                <th>SpanID</th>
                <th>Name</th>
                <th>Service</th>
                <th>Status</th>
                <th>时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rowsResult.rows.map((row) => (
                <tr key={row.id}>
                  <td className="bulk-select-cell">
                    <input type="checkbox" name="selectedIds" value={row.id} form={bulkDeleteFormId} aria-label={`选择 Trace ${row.id}`} />
                  </td>
                  <td>{row.id}</td>
                  <td><code>{row.trace_id ?? "-"}</code></td>
                  <td><code>{row.span_id ?? "-"}</code></td>
                  <td>{row.name}</td>
                  <td>{row.service_name ?? "-"}</td>
                  <td>{row.status ?? "-"}</td>
                  <td>{formatDateTime(row.created_at)}</td>
                  <td>
                    <div className="row-actions">
                      <Link href={`${listHrefCurrent}&panel=detail&id=${row.id}`} className="text-btn">更新</Link>
                      <form action={deleteTrace}>
                        <input type="hidden" name="id" value={row.id} />
                        <input type="hidden" name="q" value={qv} />
                        <input type="hidden" name="service" value={serviceFilter} />
                        <input type="hidden" name="page" value={page} />
                        <input type="hidden" name="pageSize" value={pageSize} />
                        <SubmitButton className="text-btn danger" pendingText="删除中...">删除</SubmitButton>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <BulkSelectionControls formId={bulkDeleteFormId} variant="full" confirmText="确认批量删除已选 {count} 条 Trace 吗？" />
          <PaginationControls basePath="/otel" query={{ tab: "traces", q: qv, service: serviceFilter === "all" ? "" : serviceFilter }} total={total} page={page} pageSize={pageSize} position="bottom" />
        </section>

        {showEditor ? (
          <div className="action-overlay">
            <Link href={listHrefCurrent} className="action-overlay-dismiss" aria-label="关闭抽屉蒙层" />
            <aside className="action-drawer">
              <div className="action-drawer-header">
                <h3>Trace 详情</h3>
                <Link href={listHrefCurrent} className="icon-btn" aria-label="关闭">
                  <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
                </Link>
              </div>
              <div className="action-drawer-body">
                <form id={`trace-form-${editing.id}`} action={updateTrace} className="menu-form form-tone-green">
                  <input type="hidden" name="id" value={editing.id} />
                  <input type="hidden" name="q" value={qv} />
                  <input type="hidden" name="service" value={serviceFilter} />
                  <input type="hidden" name="page" value={page} />
                  <input type="hidden" name="pageSize" value={pageSize} />

                  <div className="field-group"><label className="field-head"><span className="field-title required">Name</span><span className="type-pill">String</span></label><input name="name" required defaultValue={editing.name} /></div>
                  <div className="field-group"><label className="field-head"><span className="field-title">Trace ID</span><span className="type-pill">Optional</span></label><input name="traceId" defaultValue={editing.trace_id ?? ""} /></div>
                  <div className="field-group"><label className="field-head"><span className="field-title">Span ID</span><span className="type-pill">Optional</span></label><input name="spanId" defaultValue={editing.span_id ?? ""} /></div>
                  <div className="field-group"><label className="field-head"><span className="field-title">Parent Span ID</span><span className="type-pill">Optional</span></label><input name="parentSpanId" defaultValue={editing.parent_span_id ?? ""} /></div>
                  <div className="field-group"><label className="field-head"><span className="field-title">Service</span><span className="type-pill">Optional</span></label><input name="serviceName" defaultValue={editing.service_name ?? ""} /></div>
                  <div className="field-group"><label className="field-head"><span className="field-title">Status</span><span className="type-pill">Optional</span></label><input name="status" defaultValue={editing.status ?? ""} /></div>
                  <div className="field-group"><label className="field-head"><span className="field-title">Scope Name</span><span className="type-pill">Optional</span></label><input name="scopeName" defaultValue={editing.scope_name ?? ""} /></div>
                  <div className="field-group"><label className="field-head"><span className="field-title">Scope Version</span><span className="type-pill">Optional</span></label><input name="scopeVersion" defaultValue={editing.scope_version ?? ""} /></div>
                  <div className="field-group"><label className="field-head"><span className="field-title">Run Case ID</span><span className="type-pill">Optional</span></label><input name="runCaseId" defaultValue={editing.run_case_id ?? ""} /></div>
                  <div className="field-group"><label className="field-head"><span className="field-title">Experiment ID</span><span className="type-pill">Optional</span></label><input name="experimentId" defaultValue={editing.experiment_id ?? ""} /></div>
                  <div className="field-group"><label className="field-head"><span className="field-title">Start Time</span><span className="type-pill">Datetime</span></label><input type="datetime-local" name="startTime" defaultValue={toDatetimeLocal(editing.start_time)} /></div>
                  <div className="field-group"><label className="field-head"><span className="field-title">End Time</span><span className="type-pill">Datetime</span></label><input type="datetime-local" name="endTime" defaultValue={toDatetimeLocal(editing.end_time)} /></div>
                  <div className="field-group"><label className="field-head"><span className="field-title">Attributes JSON</span><span className="type-pill">JSON</span></label><TextareaWithFileUpload name="attributes" defaultValue={JSON.stringify(editing.attributes, null, 2)} accept=".json,.txt" /></div>
                  <div className="field-group"><label className="field-head"><span className="field-title">Resource Attrs JSON</span><span className="type-pill">JSON</span></label><TextareaWithFileUpload name="resourceAttributes" defaultValue={JSON.stringify(editing.resource_attributes, null, 2)} accept=".json,.txt" /></div>
                  <div className="field-group"><label className="field-head"><span className="field-title">Scope Attrs JSON</span><span className="type-pill">JSON</span></label><TextareaWithFileUpload name="scopeAttributes" defaultValue={JSON.stringify(editing.scope_attributes, null, 2)} accept=".json,.txt" /></div>
                  <div className="field-group"><label className="field-head"><span className="field-title">Raw JSON</span><span className="type-pill">JSON</span></label><TextareaWithFileUpload name="raw" defaultValue={JSON.stringify(editing.raw, null, 2)} accept=".json,.txt" /></div>
                </form>
                <div className="drawer-actions">
                  <SubmitButton form={`trace-form-${editing.id}`} className="primary-btn" pendingText="更新中...">更新</SubmitButton>
                  <form action={deleteTrace} className="drawer-inline-form">
                    <input type="hidden" name="id" value={editing.id} />
                    <input type="hidden" name="q" value={qv} />
                    <input type="hidden" name="service" value={serviceFilter} />
                    <input type="hidden" name="page" value={page} />
                    <input type="hidden" name="pageSize" value={pageSize} />
                    <SubmitButton className="danger-btn" pendingText="删除中...">删除</SubmitButton>
                  </form>
                  <Link href={listHrefCurrent} className="ghost-btn">取消</Link>
                </div>
              </div>
            </aside>
          </div>
        ) : null}

        {showFilter ? (
          <div className="action-overlay">
            <Link href={listHrefCurrent} className="action-overlay-dismiss" aria-label="关闭抽屉蒙层" />
            <aside className="action-drawer">
              <div className="action-drawer-header">
                <h3>筛选 Traces</h3>
                <Link href={listHrefCurrent} className="icon-btn" aria-label="关闭">
                  <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
                </Link>
              </div>
              <div className="action-drawer-body">
                <form action="/otel" className="menu-form form-tone-green">
                  <input type="hidden" name="tab" value="traces" />
                  <input type="hidden" name="q" value={qv} />
                  <input type="hidden" name="pageSize" value={pageSize} />
                  <div className="field-group">
                    <label className="field-head">
                      <span className="field-title">服务</span>
                      <span className="type-pill">Optional</span>
                    </label>
                    <select name="service" defaultValue={serviceFilter}>
                      <option value="all">全部服务</option>
                      {services.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="drawer-actions">
                    <button type="submit" className="primary-btn">应用筛选</button>
                    <Link href={buildListHref("traces", qv, "all", "all", 1, pageSize)} className="ghost-btn">
                      清空筛选
                    </Link>
                  </div>
                </form>
              </div>
            </aside>
          </div>
        ) : null}

        {ingesting ? (
          <div className="action-overlay">
            <Link href={listHrefCurrent} className="action-overlay-dismiss" aria-label="关闭抽屉蒙层" />
            <aside className="action-drawer">
              <div className="action-drawer-header">
                <h3>手动上报 Trace</h3>
                <Link href={listHrefCurrent} className="icon-btn" aria-label="关闭">
                  <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
                </Link>
              </div>
              <div className="action-drawer-body">
                {result === "ok" ? <p className="muted" style={{ color: "#0f766e" }}>写入成功，新增 {inserted || "0"} 条记录。</p> : null}
                {result === "error" ? <p className="muted" style={{ color: "#b91c1c" }}>写入失败：{message || "invalid payload"}</p> : null}
                <form action={ingestManualTrace} className="menu-form form-tone-green">
                  <input type="hidden" name="q" value={qv} />
                  <input type="hidden" name="service" value={serviceFilter} />
                  <input type="hidden" name="page" value={page} />
                  <input type="hidden" name="pageSize" value={pageSize} />
                  <div className="field-group">
                    <label className="field-head"><span className="field-title required">Payload JSON</span><span className="type-pill">JSON</span></label>
                    <TextareaWithFileUpload
                      name="payload"
                      required
                      accept=".json,.txt"
                      defaultValue={JSON.stringify({ spans: [{ traceId: "demo-trace", spanId: "demo-span", name: "benchmark.run", serviceName: "benchmark-platform", attributes: { env: "test" }, status: "OK", startTime: new Date().toISOString(), endTime: new Date().toISOString() }] }, null, 2)}
                    />
                  </div>
                  <SubmitButton className="primary-btn" pendingText="写入中...">写入 Trace</SubmitButton>
                </form>
              </div>
            </aside>
          </div>
        ) : null}
      </div>
    );
  }

  const countResult = await dbQuery<{ total_count: number | string }>(
    `SELECT COUNT(*) AS total_count
     FROM otel_logs
     WHERE ($1 = '' OR LOWER(COALESCE(trace_id, '')) LIKE CONCAT('%', LOWER($2), '%') OR LOWER(COALESCE(body_text, '')) LIKE CONCAT('%', LOWER($3), '%'))
       AND deleted_at IS NULL
       AND ($4 = 'all' OR COALESCE(service_name, '-') = $5)
       AND ($6 = 'all' OR COALESCE(severity_text, '-') = $7)`,
    [qv, qv, qv, serviceFilter, serviceFilter, severityFilter, severityFilter]
  );
  const total = Number(countResult.rows[0]?.total_count ?? 0);
  const page = clampPage(requestedPage, total, pageSize);
  const offset = getOffset(page, pageSize);
  const listHrefCurrent = buildListHref(activeTab, qv, serviceFilter, severityFilter, page, pageSize);

  const [rowsResult, serviceRows, severityRows, detailRows] = await Promise.all([
    dbQuery<{
      id: number;
      trace_id: string | null;
      span_id: string | null;
      service_name: string | null;
      severity_text: string | null;
      body_text: string | null;
      created_at: string;
    }>(
      `SELECT id, trace_id, span_id, service_name, severity_text, body_text, created_at
       FROM otel_logs
       WHERE ($1 = '' OR LOWER(COALESCE(trace_id, '')) LIKE CONCAT('%', LOWER($2), '%') OR LOWER(COALESCE(body_text, '')) LIKE CONCAT('%', LOWER($3), '%'))
         AND deleted_at IS NULL
         AND ($4 = 'all' OR COALESCE(service_name, '-') = $5)
         AND ($6 = 'all' OR COALESCE(severity_text, '-') = $7)
       ORDER BY id DESC
       LIMIT $8 OFFSET $9`,
      [qv, qv, qv, serviceFilter, serviceFilter, severityFilter, severityFilter, pageSize, offset]
    ),
    dbQuery<{ service_name: string }>(
      `SELECT COALESCE(service_name, '-') AS service_name
       FROM otel_logs
       WHERE deleted_at IS NULL
       GROUP BY COALESCE(service_name, '-')
       ORDER BY service_name ASC`
    ),
    dbQuery<{ severity_text: string }>(
      `SELECT COALESCE(severity_text, '-') AS severity_text
       FROM otel_logs
       WHERE deleted_at IS NULL
       GROUP BY COALESCE(severity_text, '-')
       ORDER BY severity_text ASC`
    ),
    Number.isInteger(detailId) && detailId > 0
      ? dbQuery<{
          id: number;
          trace_id: string | null;
          span_id: string | null;
          service_name: string | null;
          severity_text: string | null;
          severity_number: number | null;
          body_text: string | null;
          body_json: unknown;
          attributes: unknown;
          resource_attributes: unknown;
          scope_attributes: unknown;
          scope_name: string | null;
          scope_version: string | null;
          flags: number | null;
          dropped_attributes_count: number | null;
          event_time: string | null;
          observed_time: string | null;
          run_case_id: number | null;
          experiment_id: number | null;
          raw: unknown;
        }>(
          `SELECT id, trace_id, span_id, service_name, severity_text, severity_number, body_text, body_json,
                  attributes, resource_attributes, scope_attributes, scope_name, scope_version,
                  flags, dropped_attributes_count, event_time, observed_time, run_case_id, experiment_id, raw
           FROM otel_logs
           WHERE id = $1 AND deleted_at IS NULL
           LIMIT 1`,
          [detailId]
        )
      : Promise.resolve({ rows: [], rowCount: 0 })
  ]);

  const services = serviceRows.rows.map((item) => item.service_name);
  const severities = severityRows.rows.map((item) => item.severity_text);
  const editing = detailRows.rows[0];
  const showEditor = panel === "detail" && Boolean(editing);
  const showFilter = panel === "filter";
  const bulkDeleteFormId = "otel-log-bulk-delete-form";
  const filterHref = `${listHrefCurrent}${listHrefCurrent.includes("?") ? "&" : "?"}panel=filter`;

  return (
    <div className="grid">
      <section className="page-hero">
        <div className="breadcrumb">评测 &nbsp;/&nbsp; OTEL</div>
        <h1>OTEL</h1>
      </section>

        <section className="otel-tab-row">
          <div className="exp-tabs">
            <Link href={buildListHref("traces", qv, serviceFilter, "all", 1, pageSize)} className="exp-tab">
              Traces
            </Link>
            <Link href={buildListHref("logs", qv, serviceFilter, severityFilter, 1, pageSize)} className="exp-tab active">
              Logs
            </Link>
          </div>
        </section>

        <section className="toolbar-row">
          <form action="/otel" className="search-form">
            <input type="hidden" name="tab" value="logs" />
            <input type="hidden" name="pageSize" value={pageSize} />
            <input type="hidden" name="service" value={serviceFilter} />
          <input type="hidden" name="severity" value={severityFilter} />
          <label className="input-icon-wrap">
            <SearchIcon width={16} height={16} />
            <input name="q" defaultValue={qv} placeholder="搜索 trace id 或 log body" />
          </label>
          <button type="submit" className="ghost-btn"><SearchIcon width={16} height={16} /> 搜索</button>
        </form>

        <div className="action-group">
          <Link href={filterHref} className="ghost-btn">
            <FilterIcon width={16} height={16} /> 筛选
          </Link>
          <BulkSelectionControls formId={bulkDeleteFormId} variant="compact" confirmText="确认批量删除已选 {count} 条 Log 吗？" />
          <PaginationControls basePath="/otel" query={{ tab: "logs", q: qv, service: serviceFilter === "all" ? "" : serviceFilter, severity: severityFilter === "all" ? "" : severityFilter }} total={total} page={page} pageSize={pageSize} position="top" variant="compact" />
          <a href={listHrefCurrent} className="icon-btn" aria-label="刷新"><RefreshIcon width={16} height={16} /></a>
          <Link href={ingestHref} className="primary-btn"><PlusIcon width={16} height={16} /> 手动上报</Link>
        </div>
      </section>

      <section className="card table-card">
        <div className="section-title-row">
          <h2><TraceIcon width={16} height={16} /> OTEL Logs</h2>
          <span className="toolbar-hint">Endpoint: <code>POST /api/otel/v1/logs</code></span>
        </div>
        <form id={bulkDeleteFormId} action={bulkDeleteLog}>
          <input type="hidden" name="q" value={qv} />
          <input type="hidden" name="service" value={serviceFilter} />
          <input type="hidden" name="severity" value={severityFilter} />
          <input type="hidden" name="page" value={page} />
          <input type="hidden" name="pageSize" value={pageSize} />
        </form>
        <table className="otel-logs-table">
          <thead>
            <tr>
              <th className="bulk-select-cell">选</th>
              <th>ID</th>
              <th>TraceID</th>
              <th>SpanID</th>
              <th>Service</th>
              <th>Severity</th>
              <th>Body</th>
              <th>时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rowsResult.rows.map((row) => (
              <tr key={row.id}>
                <td className="bulk-select-cell"><input type="checkbox" name="selectedIds" value={row.id} form={bulkDeleteFormId} aria-label={`选择 Log ${row.id}`} /></td>
                <td>{row.id}</td>
                <td><code>{row.trace_id ?? "-"}</code></td>
                <td><code>{row.span_id ?? "-"}</code></td>
                <td>{row.service_name ?? "-"}</td>
                <td>{row.severity_text ?? "-"}</td>
                <td className="exp-table-cell-truncate" title={row.body_text ?? ""}>{row.body_text ?? "-"}</td>
                <td>{formatDateTime(row.created_at)}</td>
                <td>
                  <div className="row-actions">
                    <Link href={`${listHrefCurrent}&panel=detail&id=${row.id}`} className="text-btn">更新</Link>
                    <form action={deleteLog}>
                      <input type="hidden" name="id" value={row.id} />
                      <input type="hidden" name="q" value={qv} />
                      <input type="hidden" name="service" value={serviceFilter} />
                      <input type="hidden" name="severity" value={severityFilter} />
                      <input type="hidden" name="page" value={page} />
                      <input type="hidden" name="pageSize" value={pageSize} />
                      <SubmitButton className="text-btn danger" pendingText="删除中...">删除</SubmitButton>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <BulkSelectionControls formId={bulkDeleteFormId} variant="full" confirmText="确认批量删除已选 {count} 条 Log 吗？" />
        <PaginationControls basePath="/otel" query={{ tab: "logs", q: qv, service: serviceFilter === "all" ? "" : serviceFilter, severity: severityFilter === "all" ? "" : severityFilter }} total={total} page={page} pageSize={pageSize} position="bottom" />
      </section>

      {showEditor ? (
        <div className="action-overlay">
          <Link href={listHrefCurrent} className="action-overlay-dismiss" aria-label="关闭抽屉蒙层" />
          <aside className="action-drawer">
            <div className="action-drawer-header">
              <h3>Log 详情</h3>
              <Link href={listHrefCurrent} className="icon-btn" aria-label="关闭"><span style={{ fontSize: 18, lineHeight: 1 }}>×</span></Link>
            </div>
            <div className="action-drawer-body">
              <form id={`log-form-${editing.id}`} action={updateLog} className="menu-form form-tone-green">
                <input type="hidden" name="id" value={editing.id} />
                <input type="hidden" name="q" value={qv} />
                <input type="hidden" name="service" value={serviceFilter} />
                <input type="hidden" name="severity" value={severityFilter} />
                <input type="hidden" name="page" value={page} />
                <input type="hidden" name="pageSize" value={pageSize} />

                <div className="field-group"><label className="field-head"><span className="field-title">Trace ID</span><span className="type-pill">Optional</span></label><input name="traceId" defaultValue={editing.trace_id ?? ""} /></div>
                <div className="field-group"><label className="field-head"><span className="field-title">Span ID</span><span className="type-pill">Optional</span></label><input name="spanId" defaultValue={editing.span_id ?? ""} /></div>
                <div className="field-group"><label className="field-head"><span className="field-title">Service</span><span className="type-pill">Optional</span></label><input name="serviceName" defaultValue={editing.service_name ?? ""} /></div>
                <div className="field-group"><label className="field-head"><span className="field-title">Severity Text</span><span className="type-pill">Optional</span></label><input name="severityText" defaultValue={editing.severity_text ?? ""} /></div>
                <div className="field-group"><label className="field-head"><span className="field-title">Severity Number</span><span className="type-pill">Optional</span></label><input name="severityNumber" defaultValue={editing.severity_number ?? ""} /></div>
                <div className="field-group"><label className="field-head"><span className="field-title">Body Text</span><span className="type-pill">Optional</span></label><TextareaWithFileUpload name="bodyText" defaultValue={editing.body_text ?? ""} accept=".txt,.log,.json" /></div>
                <div className="field-group"><label className="field-head"><span className="field-title">Body JSON</span><span className="type-pill">Optional JSON</span></label><TextareaWithFileUpload name="bodyJson" defaultValue={editing.body_json ? JSON.stringify(editing.body_json, null, 2) : ""} accept=".json,.txt" /></div>
                <div className="field-group"><label className="field-head"><span className="field-title">Scope Name</span><span className="type-pill">Optional</span></label><input name="scopeName" defaultValue={editing.scope_name ?? ""} /></div>
                <div className="field-group"><label className="field-head"><span className="field-title">Scope Version</span><span className="type-pill">Optional</span></label><input name="scopeVersion" defaultValue={editing.scope_version ?? ""} /></div>
                <div className="field-group"><label className="field-head"><span className="field-title">Flags</span><span className="type-pill">Optional</span></label><input name="flags" defaultValue={editing.flags ?? ""} /></div>
                <div className="field-group"><label className="field-head"><span className="field-title">Dropped Attr Count</span><span className="type-pill">Optional</span></label><input name="droppedAttributesCount" defaultValue={editing.dropped_attributes_count ?? ""} /></div>
                <div className="field-group"><label className="field-head"><span className="field-title">Run Case ID</span><span className="type-pill">Optional</span></label><input name="runCaseId" defaultValue={editing.run_case_id ?? ""} /></div>
                <div className="field-group"><label className="field-head"><span className="field-title">Experiment ID</span><span className="type-pill">Optional</span></label><input name="experimentId" defaultValue={editing.experiment_id ?? ""} /></div>
                <div className="field-group"><label className="field-head"><span className="field-title">Event Time</span><span className="type-pill">Datetime</span></label><input type="datetime-local" name="eventTime" defaultValue={toDatetimeLocal(editing.event_time)} /></div>
                <div className="field-group"><label className="field-head"><span className="field-title">Observed Time</span><span className="type-pill">Datetime</span></label><input type="datetime-local" name="observedTime" defaultValue={toDatetimeLocal(editing.observed_time)} /></div>
                <div className="field-group"><label className="field-head"><span className="field-title">Attributes JSON</span><span className="type-pill">JSON</span></label><TextareaWithFileUpload name="attributes" defaultValue={JSON.stringify(editing.attributes, null, 2)} accept=".json,.txt" /></div>
                <div className="field-group"><label className="field-head"><span className="field-title">Resource Attrs JSON</span><span className="type-pill">JSON</span></label><TextareaWithFileUpload name="resourceAttributes" defaultValue={JSON.stringify(editing.resource_attributes, null, 2)} accept=".json,.txt" /></div>
                <div className="field-group"><label className="field-head"><span className="field-title">Scope Attrs JSON</span><span className="type-pill">JSON</span></label><TextareaWithFileUpload name="scopeAttributes" defaultValue={JSON.stringify(editing.scope_attributes, null, 2)} accept=".json,.txt" /></div>
                <div className="field-group"><label className="field-head"><span className="field-title">Raw JSON</span><span className="type-pill">JSON</span></label><TextareaWithFileUpload name="raw" defaultValue={JSON.stringify(editing.raw, null, 2)} accept=".json,.txt" /></div>
              </form>
              <div className="drawer-actions">
                <SubmitButton form={`log-form-${editing.id}`} className="primary-btn" pendingText="更新中...">更新</SubmitButton>
                <form action={deleteLog} className="drawer-inline-form">
                  <input type="hidden" name="id" value={editing.id} />
                  <input type="hidden" name="q" value={qv} />
                  <input type="hidden" name="service" value={serviceFilter} />
                  <input type="hidden" name="severity" value={severityFilter} />
                  <input type="hidden" name="page" value={page} />
                  <input type="hidden" name="pageSize" value={pageSize} />
                  <SubmitButton className="danger-btn" pendingText="删除中...">删除</SubmitButton>
                </form>
                <Link href={listHrefCurrent} className="ghost-btn">取消</Link>
              </div>
            </div>
          </aside>
        </div>
      ) : null}

      {showFilter ? (
        <div className="action-overlay">
          <Link href={listHrefCurrent} className="action-overlay-dismiss" aria-label="关闭抽屉蒙层" />
          <aside className="action-drawer">
            <div className="action-drawer-header">
              <h3>筛选 Logs</h3>
              <Link href={listHrefCurrent} className="icon-btn" aria-label="关闭">
                <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
              </Link>
            </div>
            <div className="action-drawer-body">
              <form action="/otel" className="menu-form form-tone-green">
                <input type="hidden" name="tab" value="logs" />
                <input type="hidden" name="q" value={qv} />
                <input type="hidden" name="pageSize" value={pageSize} />
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title">服务</span>
                    <span className="type-pill">Optional</span>
                  </label>
                  <select name="service" defaultValue={serviceFilter}>
                    <option value="all">全部服务</option>
                    {services.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title">级别</span>
                    <span className="type-pill">Optional</span>
                  </label>
                  <select name="severity" defaultValue={severityFilter}>
                    <option value="all">全部级别</option>
                    {severities.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="drawer-actions">
                  <button type="submit" className="primary-btn">应用筛选</button>
                  <Link href={buildListHref("logs", qv, "all", "all", 1, pageSize)} className="ghost-btn">
                    清空筛选
                  </Link>
                </div>
              </form>
            </div>
          </aside>
        </div>
      ) : null}

      {ingesting ? (
        <div className="action-overlay">
          <Link href={listHrefCurrent} className="action-overlay-dismiss" aria-label="关闭抽屉蒙层" />
          <aside className="action-drawer">
            <div className="action-drawer-header">
              <h3>手动上报 Log</h3>
              <Link href={listHrefCurrent} className="icon-btn" aria-label="关闭"><span style={{ fontSize: 18, lineHeight: 1 }}>×</span></Link>
            </div>
            <div className="action-drawer-body">
              {result === "ok" ? <p className="muted" style={{ color: "#0f766e" }}>写入成功，新增 {inserted || "0"} 条记录。</p> : null}
              {result === "error" ? <p className="muted" style={{ color: "#b91c1c" }}>写入失败：{message || "invalid payload"}</p> : null}
              <form action={ingestManualLog} className="menu-form form-tone-green">
                <input type="hidden" name="q" value={qv} />
                <input type="hidden" name="service" value={serviceFilter} />
                <input type="hidden" name="severity" value={severityFilter} />
                <input type="hidden" name="page" value={page} />
                <input type="hidden" name="pageSize" value={pageSize} />
                <div className="field-group">
                  <label className="field-head"><span className="field-title required">Payload JSON</span><span className="type-pill">JSON</span></label>
                  <TextareaWithFileUpload
                    name="payload"
                    required
                    accept=".json,.txt"
                    defaultValue={JSON.stringify({ logs: [{ traceId: "demo-trace", spanId: "demo-span", serviceName: "benchmark-platform", severityText: "INFO", severityNumber: 9, body: "sample log message", attributes: { env: "test" }, eventTime: new Date().toISOString(), observedTime: new Date().toISOString() }] }, null, 2)}
                  />
                </div>
                <SubmitButton className="primary-btn" pendingText="写入中...">写入 Log</SubmitButton>
              </form>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
