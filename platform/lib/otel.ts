import { dbQuery, engine } from "./db";

type NormalizedSpan = {
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
  name: string;
  serviceName: string | null;
  attributes: Record<string, unknown>;
  startTime: string | null;
  endTime: string | null;
  status: string | null;
  raw: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  }
  return [];
}

function pickString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return null;
}

function attrValueToAny(value: Record<string, unknown> | undefined) {
  if (!value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("string_value" in value) return value.string_value;
  if ("intValue" in value) return Number(value.intValue);
  if ("int_value" in value) return Number(value.int_value);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("double_value" in value) return Number(value.double_value);
  if ("boolValue" in value) return Boolean(value.boolValue);
  if ("bool_value" in value) return Boolean(value.bool_value);
  return value;
}

function toTimestamp(nanoString?: string) {
  if (!nanoString) return null;
  const asNum = Number(nanoString);
  if (!Number.isFinite(asNum) || asNum <= 0) return null;
  return new Date(asNum / 1_000_000).toISOString();
}

function normalizeStatus(status: unknown) {
  if (typeof status === "string") {
    return status.slice(0, 100);
  }
  const statusObj = asRecord(status);
  const maybeCode = statusObj.code;
  if (typeof maybeCode === "number") return `code:${maybeCode}`.slice(0, 100);
  if (typeof maybeCode === "string") return maybeCode.slice(0, 100);
  return null;
}

function toMySqlDateTime(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function normalizeOtlpJson(payload: Record<string, unknown>): NormalizedSpan[] {
  const normalized: NormalizedSpan[] = [];
  const resourceSpans = asRecordArray(payload.resourceSpans ?? payload.resource_spans);

  for (const rs of resourceSpans) {
    const resources = asRecord(rs.resource);
    const resourceAttrs = asRecordArray(resources.attributes);
    let serviceName: string | null = null;
    for (const attr of resourceAttrs) {
      const key = attr.key as string;
      if (key === "service.name") {
        const value = attrValueToAny(asRecord(attr.value));
        serviceName = value ? String(value) : null;
      }
    }

    const scopeSpans = asRecordArray(rs.scopeSpans ?? rs.scope_spans ?? rs.instrumentationLibrarySpans);
    for (const ss of scopeSpans) {
      const spans = asRecordArray(ss.spans);
      for (const span of spans) {
        const attrs: Record<string, unknown> = {};
        const spanAttrs = asRecordArray(span.attributes);
        for (const attr of spanAttrs) {
          attrs[String(attr.key)] = attrValueToAny(asRecord(attr.value));
        }
        normalized.push({
          traceId: pickString(span, ["traceId", "trace_id"]) ?? null,
          spanId: pickString(span, ["spanId", "span_id"]) ?? null,
          parentSpanId: pickString(span, ["parentSpanId", "parent_span_id"]) ?? null,
          name: String(span.name ?? "unnamed-span"),
          serviceName: serviceName ?? pickString(span, ["serviceName", "service_name"]),
          attributes: attrs,
          startTime: toTimestamp(pickString(span, ["startTimeUnixNano", "start_time_unix_nano"]) ?? undefined),
          endTime: toTimestamp(pickString(span, ["endTimeUnixNano", "end_time_unix_nano"]) ?? undefined),
          status: normalizeStatus(span.status),
          raw: span
        });
      }
    }
  }

  return normalized;
}

function normalizeSimple(payload: Record<string, unknown>): NormalizedSpan[] {
  const spans = asRecordArray(payload.spans);
  if (spans.length === 0) {
    const single =
      pickString(payload, ["traceId", "trace_id"]) ||
      pickString(payload, ["spanId", "span_id"]) ||
      typeof payload.name === "string";
    if (single) {
      spans.push(payload);
    }
  }

  return spans.map((s) => ({
    traceId: pickString(s, ["traceId", "trace_id"]) ?? null,
    spanId: pickString(s, ["spanId", "span_id"]) ?? null,
    parentSpanId: pickString(s, ["parentSpanId", "parent_span_id"]) ?? null,
    name: String(s.name ?? "unnamed-span"),
    serviceName: pickString(s, ["serviceName", "service_name"]),
    attributes: asRecord(s.attributes),
    startTime: pickString(s, ["startTime", "start_time"]),
    endTime: pickString(s, ["endTime", "end_time"]),
    status: normalizeStatus(s.status),
    raw: s
  }));
}

export async function ingestTracePayload(payload: Record<string, unknown>) {
  const spans = payload.resourceSpans || payload.resource_spans ? normalizeOtlpJson(payload) : normalizeSimple(payload);
  if (spans.length === 0) {
    throw new Error("No spans found in payload. Use OTLP JSON(resourceSpans) or { spans: [...] }");
  }

  for (const span of spans) {
    const startTime = engine === "mysql" ? toMySqlDateTime(span.startTime) : span.startTime;
    const endTime = engine === "mysql" ? toMySqlDateTime(span.endTime) : span.endTime;
    await dbQuery(
      `INSERT INTO traces (
        trace_id, span_id, parent_span_id, name, service_name, attributes,
        start_time, end_time, status, raw
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        span.traceId,
        span.spanId,
        span.parentSpanId,
        span.name,
        span.serviceName,
        JSON.stringify(span.attributes),
        startTime,
        endTime,
        span.status,
        JSON.stringify(span.raw)
      ]
    );
  }

  return spans.length;
}
