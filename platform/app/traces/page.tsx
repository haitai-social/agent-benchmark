import { revalidatePath } from "next/cache";
import { dbQuery } from "@/lib/db";
import { ingestTracePayload } from "@/lib/otel";
import { parseJsonOrWrap } from "@/lib/safe-json";
import { requireUser } from "@/lib/supabase-auth";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  FilterIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  TraceIcon
} from "../components/icons";
import { SubmitButton } from "../components/submit-button";
import { TextareaWithFileUpload } from "../components/textarea-with-file-upload";

function buildListHref(q: string, service: string, extras?: Record<string, string>) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (service !== "all") params.set("service", service);
  for (const [key, value] of Object.entries(extras ?? {})) {
    if (value) params.set(key, value);
  }
  return params.size > 0 ? `/traces?${params.toString()}` : "/traces";
}

function toDatetimeLocal(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

async function ingestManualTrace(formData: FormData) {
  "use server";
  await requireUser();

  const payloadRaw = String(formData.get("payload") ?? "{}");
  const q = String(formData.get("q") ?? "").trim();
  const service = String(formData.get("service") ?? "all").trim() || "all";
  const nextParams = new URLSearchParams();
  if (q) nextParams.set("q", q);
  if (service !== "all") nextParams.set("service", service);
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
  revalidatePath("/traces");
  redirect(`/traces?${nextParams.toString()}`);
}

async function updateTrace(formData: FormData) {
  "use server";
  await requireUser();

  const idRaw = String(formData.get("id") ?? "").trim();
  const id = Number(idRaw);
  const traceId = String(formData.get("traceId") ?? "").trim();
  const spanId = String(formData.get("spanId") ?? "").trim();
  const parentSpanId = String(formData.get("parentSpanId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const serviceName = String(formData.get("serviceName") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim();
  const startTimeRaw = String(formData.get("startTime") ?? "").trim();
  const endTimeRaw = String(formData.get("endTime") ?? "").trim();
  const attributesRaw = String(formData.get("attributes") ?? "{}");
  const rawValue = String(formData.get("raw") ?? "{}");
  const q = String(formData.get("q") ?? "").trim();
  const service = String(formData.get("service") ?? "all").trim() || "all";

  if (!idRaw || !Number.isInteger(id) || id <= 0 || !name) return;

  const startTime = startTimeRaw ? new Date(startTimeRaw).toISOString() : null;
  const endTime = endTimeRaw ? new Date(endTimeRaw).toISOString() : null;

  await dbQuery(
    `UPDATE traces
     SET trace_id = NULLIF($2, ''),
         span_id = NULLIF($3, ''),
         parent_span_id = NULLIF($4, ''),
         name = $5,
         service_name = NULLIF($6, ''),
         status = NULLIF($7, ''),
         start_time = $8,
         end_time = $9,
         attributes = $10,
         raw = $11
     WHERE id = $1 AND deleted_at IS NULL`,
    [
      id,
      traceId,
      spanId,
      parentSpanId,
      name,
      serviceName,
      status,
      startTime,
      endTime,
      JSON.stringify(parseJsonOrWrap(attributesRaw)),
      JSON.stringify(parseJsonOrWrap(rawValue))
    ]
  );

  revalidatePath("/traces");
  redirect(buildListHref(q, service));
}

async function deleteTrace(formData: FormData) {
  "use server";
  await requireUser();

  const idRaw = String(formData.get("id") ?? "").trim();
  const id = Number(idRaw);
  const q = String(formData.get("q") ?? "").trim();
  const service = String(formData.get("service") ?? "all").trim() || "all";
  if (!idRaw || !Number.isInteger(id) || id <= 0) return;

  await dbQuery(
    `UPDATE traces
     SET is_deleted = TRUE,
         deleted_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );

  revalidatePath("/traces");
  redirect(buildListHref(q, service));
}

export default async function TracesPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; service?: string; panel?: string; id?: string; result?: string; inserted?: string; message?: string }>;
}) {
  await requireUser();

  const { q = "", service = "all", panel = "none", id = "", result = "", inserted = "", message = "" } = await searchParams;
  const qv = q.trim();
  const ingesting = panel === "ingest";
  const detailIdRaw = id.trim();
  const detailId = detailIdRaw ? Number(detailIdRaw) : 0;
  const listHref = buildListHref(qv, service);
  const ingestHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=ingest`;

  const [traces, serviceRows, detailTraceRows] = await Promise.all([
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
       FROM traces
       WHERE ($1 = '' OR LOWER(COALESCE(trace_id, '')) LIKE CONCAT('%', LOWER($2), '%') OR LOWER(name) LIKE CONCAT('%', LOWER($3), '%'))
         AND deleted_at IS NULL
         AND ($4 = 'all' OR COALESCE(service_name, '-') = $5)
       ORDER BY id DESC LIMIT 100`,
      [qv, qv, qv, service, service]
    ),
    dbQuery<{ service_name: string }>(
      `SELECT COALESCE(service_name, '-') AS service_name
       FROM traces
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
          start_time: string | null;
          end_time: string | null;
          attributes: unknown;
          raw: unknown;
          created_at: string;
        }>(
          `SELECT id, trace_id, span_id, parent_span_id, name, service_name, status, start_time, end_time, attributes, raw, created_at
           FROM traces
           WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
          [detailId]
        )
      : Promise.resolve({ rows: [], rowCount: 0, affectedRows: 0, insertId: 0 })
  ]);

  const services = serviceRows.rows.map((t) => t.service_name);
  const editing = detailTraceRows.rows[0];
  const showEditor = panel === "detail" && Boolean(editing);

  return (
    <div className="grid">
      <section className="page-hero">
        <div className="breadcrumb">评测 &nbsp;/&nbsp; Trace</div>
        <h1>Trace</h1>
        <p className="muted">接收 OpenTelemetry 数据并用于 trajectory 选择与回放。</p>
      </section>

      <section className="toolbar-row">
        <form action="/traces" className="search-form">
          <label className="input-icon-wrap">
            <SearchIcon width={16} height={16} />
            <input name="q" defaultValue={qv} placeholder="搜索 trace id 或 span name" />
          </label>
          <label className="input-icon-wrap">
            <FilterIcon width={16} height={16} />
            <select name="service" defaultValue={service}>
              <option value="all">全部服务</option>
              {services.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="ghost-btn">
            <FilterIcon width={16} height={16} /> 筛选
          </button>
        </form>

        <div className="action-group">
          <a href={listHref || "/traces"} className="icon-btn" aria-label="刷新">
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
            Trace 列表
          </h2>
          <span className="toolbar-hint">
            OTel Endpoint: <code>POST /api/otel/v1/traces</code>
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>TraceID/SpanID</th>
              <th>Name</th>
              <th>Service</th>
              <th>Status</th>
              <th>时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {traces.rows.map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td>
                <td>
                  <div><code>{row.trace_id ?? "-"}</code></div>
                  <div className="muted"><code>{row.span_id ?? "-"}</code></div>
                </td>
                <td>{row.name}</td>
                <td>{row.service_name ?? "-"}</td>
                <td>{row.status ?? "-"}</td>
                <td>{new Date(row.created_at).toLocaleString()}</td>
                <td>
                  <div className="row-actions">
                    <Link
                      href={`${listHref}${listHref.includes("?") ? "&" : "?"}panel=detail&id=${row.id}`}
                      className="text-btn"
                    >
                      更新
                    </Link>
                    <form action={deleteTrace}>
                      <input type="hidden" name="id" value={row.id} />
                      <input type="hidden" name="q" value={qv} />
                      <input type="hidden" name="service" value={service} />
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

      {showEditor ? (
        <div className="action-overlay">
          <Link href={listHref || "/traces"} className="action-overlay-dismiss" aria-label="关闭抽屉蒙层" />
          <aside className="action-drawer">
            <div className="action-drawer-header">
              <h3>Trace 详情</h3>
              <Link href={listHref || "/traces"} className="icon-btn" aria-label="关闭">
                <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
              </Link>
            </div>
            <div className="action-drawer-body">
              <form id={`trace-form-${editing.id}`} action={updateTrace} className="menu-form form-tone-green">
                <input type="hidden" name="id" value={editing.id} />
                <input type="hidden" name="q" value={qv} />
                <input type="hidden" name="service" value={service} />
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title required">Span Name</span>
                    <span className="type-pill">String</span>
                  </label>
                  <input name="name" required defaultValue={editing.name} placeholder="Span Name" />
                </div>
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title">Trace ID</span>
                    <span className="type-pill">Optional</span>
                  </label>
                  <input name="traceId" defaultValue={editing.trace_id ?? ""} placeholder="Trace ID" />
                </div>
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title">Span ID</span>
                    <span className="type-pill">Optional</span>
                  </label>
                  <input name="spanId" defaultValue={editing.span_id ?? ""} placeholder="Span ID" />
                </div>
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title">Parent Span ID</span>
                    <span className="type-pill">Optional</span>
                  </label>
                  <input name="parentSpanId" defaultValue={editing.parent_span_id ?? ""} placeholder="Parent Span ID" />
                </div>
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title">Service Name</span>
                    <span className="type-pill">Optional</span>
                  </label>
                  <input name="serviceName" defaultValue={editing.service_name ?? ""} placeholder="Service Name" />
                </div>
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title">Status</span>
                    <span className="type-pill">Optional</span>
                  </label>
                  <input name="status" defaultValue={editing.status ?? ""} placeholder="Status" />
                </div>
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title">Start Time</span>
                    <span className="type-pill">Datetime</span>
                  </label>
                  <input type="datetime-local" name="startTime" defaultValue={toDatetimeLocal(editing.start_time)} />
                </div>
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title">End Time</span>
                    <span className="type-pill">Datetime</span>
                  </label>
                  <input type="datetime-local" name="endTime" defaultValue={toDatetimeLocal(editing.end_time)} />
                </div>
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title">Attributes JSON</span>
                    <span className="type-pill">JSON</span>
                  </label>
                  <TextareaWithFileUpload
                    name="attributes"
                    defaultValue={JSON.stringify(editing.attributes, null, 2)}
                    accept=".json,.txt"
                  />
                </div>
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title">Raw JSON</span>
                    <span className="type-pill">JSON</span>
                  </label>
                  <TextareaWithFileUpload
                    name="raw"
                    defaultValue={JSON.stringify(editing.raw, null, 2)}
                    accept=".json,.txt"
                  />
                </div>
              </form>
              <div className="drawer-actions">
                <SubmitButton form={`trace-form-${editing.id}`} className="primary-btn" pendingText="更新中...">
                  更新
                </SubmitButton>
                <form action={deleteTrace} className="drawer-inline-form">
                  <input type="hidden" name="id" value={editing.id} />
                  <input type="hidden" name="q" value={qv} />
                  <input type="hidden" name="service" value={service} />
                  <SubmitButton className="danger-btn" pendingText="删除中...">
                    删除
                  </SubmitButton>
                </form>
                <Link href={listHref || "/traces"} className="ghost-btn">
                  取消
                </Link>
              </div>
            </div>
          </aside>
        </div>
      ) : null}

      {ingesting ? (
        <div className="action-overlay">
          <Link href={listHref || "/traces"} className="action-overlay-dismiss" aria-label="关闭抽屉蒙层" />
          <aside className="action-drawer">
            <div className="action-drawer-header">
              <h3>手动上报 Trace</h3>
              <Link href={listHref || "/traces"} className="icon-btn" aria-label="关闭">
                <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
              </Link>
            </div>
            <div className="action-drawer-body">
              {result === "ok" ? (
                <p className="muted" style={{ color: "#0f766e" }}>
                  写入成功，新增 {inserted || "0"} 条 spans。
                </p>
              ) : null}
              {result === "error" ? (
                <p className="muted" style={{ color: "#b91c1c" }}>
                  写入失败：{message || "invalid payload"}
                </p>
              ) : null}
              <form action={ingestManualTrace} className="menu-form form-tone-green">
                <input type="hidden" name="q" value={qv} />
                <input type="hidden" name="service" value={service} />
                <div className="field-group">
                  <label className="field-head">
                    <span className="field-title required">Payload JSON</span>
                    <span className="type-pill">JSON</span>
                  </label>
                  <TextareaWithFileUpload
                    name="payload"
                    required
                    accept=".json,.txt"
                    defaultValue={JSON.stringify(
                      {
                        spans: [
                          {
                            traceId: "demo-trace",
                            spanId: "demo-span",
                            name: "benchmark.run",
                            serviceName: "benchmark-platform",
                            attributes: { env: "test" },
                            status: "OK",
                            startTime: new Date().toISOString(),
                            endTime: new Date().toISOString()
                          }
                        ]
                      },
                      null,
                      2
                    )}
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
