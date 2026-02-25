import { revalidatePath } from "next/cache";
import { dbQuery } from "@/lib/db";
import { ingestTracePayload } from "@/lib/otel";
import { parseJsonOrWrap } from "@/lib/safe-json";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  FilterIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  TraceIcon
} from "../components/icons";

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
  const id = String(formData.get("id") ?? "").trim();
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

  if (!id || !name) return;

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
     WHERE id = $1`,
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
  const id = String(formData.get("id") ?? "").trim();
  const q = String(formData.get("q") ?? "").trim();
  const service = String(formData.get("service") ?? "all").trim() || "all";
  if (!id) return;

  await dbQuery(`DELETE FROM traces WHERE id = $1`, [id]);

  revalidatePath("/traces");
  redirect(buildListHref(q, service));
}

export default async function TracesPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; service?: string; panel?: string; id?: string; result?: string; inserted?: string; message?: string }>;
}) {
  const { q = "", service = "all", panel = "none", id = "", result = "", inserted = "", message = "" } = await searchParams;
  const qv = q.trim();
  const ingesting = panel === "ingest";
  const detailId = id.trim();
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
         AND ($4 = 'all' OR COALESCE(service_name, '-') = $5)
       ORDER BY id DESC LIMIT 100`,
      [qv, qv, qv, service, service]
    ),
    dbQuery<{ service_name: string }>(
      `SELECT COALESCE(service_name, '-') AS service_name FROM traces GROUP BY COALESCE(service_name, '-') ORDER BY service_name ASC`
    ),
    detailId
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
           WHERE id = $1 LIMIT 1`,
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
                      详情
                    </Link>
                    <form action={deleteTrace}>
                      <input type="hidden" name="id" value={row.id} />
                      <input type="hidden" name="q" value={qv} />
                      <input type="hidden" name="service" value={service} />
                      <button type="submit" className="text-btn danger">
                        删除
                      </button>
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
              <p className="muted">可在此更新 trace 元数据与原始载荷。</p>
              <form action={updateTrace} className="menu-form">
                <input type="hidden" name="id" value={editing.id} />
                <input type="hidden" name="q" value={qv} />
                <input type="hidden" name="service" value={service} />
                <label className="field-label">Span Name</label>
                <input name="name" required defaultValue={editing.name} placeholder="Span Name" />
                <label className="field-label">Trace ID</label>
                <input name="traceId" defaultValue={editing.trace_id ?? ""} placeholder="Trace ID" />
                <label className="field-label">Span ID</label>
                <input name="spanId" defaultValue={editing.span_id ?? ""} placeholder="Span ID" />
                <label className="field-label">Parent Span ID</label>
                <input name="parentSpanId" defaultValue={editing.parent_span_id ?? ""} placeholder="Parent Span ID" />
                <label className="field-label">Service Name</label>
                <input name="serviceName" defaultValue={editing.service_name ?? ""} placeholder="Service Name" />
                <label className="field-label">Status</label>
                <input name="status" defaultValue={editing.status ?? ""} placeholder="Status" />
                <label className="field-label">Start Time</label>
                <input type="datetime-local" name="startTime" defaultValue={toDatetimeLocal(editing.start_time)} />
                <label className="field-label">End Time</label>
                <input type="datetime-local" name="endTime" defaultValue={toDatetimeLocal(editing.end_time)} />
                <label className="field-label">Attributes JSON</label>
                <textarea name="attributes" defaultValue={JSON.stringify(editing.attributes, null, 2)} />
                <label className="field-label">Raw JSON</label>
                <textarea name="raw" defaultValue={JSON.stringify(editing.raw, null, 2)} />
                <button type="submit">更新</button>
              </form>
              <form action={deleteTrace} className="menu-form">
                <input type="hidden" name="id" value={editing.id} />
                <input type="hidden" name="q" value={qv} />
                <input type="hidden" name="service" value={service} />
                <button type="submit" className="text-btn danger">
                  删除
                </button>
              </form>
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
              <p className="muted">
                Endpoint: <code>POST /api/otel/v1/traces</code>
              </p>
              <p className="muted">支持 OTLP JSON(resourceSpans) 与简化 spans JSON。</p>
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
              <form action={ingestManualTrace} className="menu-form">
                <input type="hidden" name="q" value={qv} />
                <input type="hidden" name="service" value={service} />
                <textarea
                  name="payload"
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
                <button type="submit">写入 Trace</button>
              </form>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
