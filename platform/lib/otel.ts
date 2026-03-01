import { dbQuery, engine } from "./db";

type AttrMap = Record<string, unknown>;

type NormalizedSpan = {
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
  name: string;
  serviceName: string | null;
  status: string | null;
  attributes: AttrMap;
  resourceAttributes: AttrMap;
  scopeAttributes: AttrMap;
  scopeName: string | null;
  scopeVersion: string | null;
  startTime: string | null;
  endTime: string | null;
  runCaseId: number | null;
  experimentId: number | null;
  raw: unknown;
};

type NormalizedLog = {
  traceId: string | null;
  spanId: string | null;
  serviceName: string | null;
  severityText: string | null;
  severityNumber: number | null;
  bodyText: string | null;
  bodyJson: unknown;
  attributes: AttrMap;
  resourceAttributes: AttrMap;
  scopeAttributes: AttrMap;
  scopeName: string | null;
  scopeVersion: string | null;
  flags: number | null;
  droppedAttributesCount: number | null;
  eventTime: string | null;
  observedTime: string | null;
  runCaseId: number | null;
  experimentId: number | null;
  raw: unknown;
};

const RUN_CASE_KEYS = ["run_case_id", "runCaseId", "benchmark.run_case_id"];
const EXPERIMENT_KEYS = ["experiment_id", "experimentId", "benchmark.experiment_id"];

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

function pickNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function coercePositiveInt(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.trunc(value);
    return n > 0 ? n : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      const n = Math.trunc(parsed);
      return n > 0 ? n : null;
    }
  }
  return null;
}

function extractCorrelationId(attrs: AttrMap, keys: string[]) {
  for (const key of keys) {
    const parsed = coercePositiveInt(attrs[key]);
    if (parsed != null) return parsed;
  }
  return null;
}

function attrValueToUnknown(value: Record<string, unknown> | undefined): unknown {
  if (!value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("string_value" in value) return value.string_value;
  if ("intValue" in value) return Number(value.intValue);
  if ("int_value" in value) return Number(value.int_value);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("double_value" in value) return Number(value.double_value);
  if ("boolValue" in value) return Boolean(value.boolValue);
  if ("bool_value" in value) return Boolean(value.bool_value);
  if ("bytesValue" in value) return value.bytesValue;
  if ("bytes_value" in value) return value.bytes_value;
  if ("arrayValue" in value || "array_value" in value) {
    const arr = asRecord((value.arrayValue ?? value.array_value) as unknown).values;
    return asRecordArray(arr).map((item) => attrValueToUnknown(asRecord(item)));
  }
  if ("kvlistValue" in value || "kvlist_value" in value) {
    const kv = asRecord((value.kvlistValue ?? value.kvlist_value) as unknown);
    return attrsToMap(kv.attributes);
  }
  return value;
}

function attrsToMap(value: unknown): AttrMap {
  const out: AttrMap = {};
  for (const attr of asRecordArray(value)) {
    const key = typeof attr.key === "string" ? attr.key : "";
    if (!key) continue;
    out[key] = attrValueToUnknown(asRecord(attr.value));
  }
  return out;
}

function toTimestampFromNanos(nanoString?: string | null) {
  if (!nanoString) return null;
  const asNum = Number(nanoString);
  if (!Number.isFinite(asNum) || asNum <= 0) return null;
  return new Date(asNum / 1_000_000).toISOString();
}

function toIso(value: unknown) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
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
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function toDbDateTime(value: string | null) {
  return engine === "mysql" ? toMySqlDateTime(value) : value;
}

function normalizeOtlpSpans(payload: Record<string, unknown>): NormalizedSpan[] {
  const normalized: NormalizedSpan[] = [];
  const resourceSpans = asRecordArray(payload.resourceSpans ?? payload.resource_spans);

  for (const resourceSpan of resourceSpans) {
    const resourceAttrs = attrsToMap(asRecord(resourceSpan.resource).attributes);
    const scopeSpans = asRecordArray(resourceSpan.scopeSpans ?? resourceSpan.scope_spans ?? resourceSpan.instrumentationLibrarySpans);

    for (const scopeSpan of scopeSpans) {
      const scope = asRecord(scopeSpan.scope ?? scopeSpan.instrumentationLibrary);
      const scopeAttrs = attrsToMap(scope.attributes);
      const spans = asRecordArray(scopeSpan.spans);

      for (const span of spans) {
        const spanAttrs = attrsToMap(span.attributes);
        const merged = { ...resourceAttrs, ...scopeAttrs, ...spanAttrs };
        normalized.push({
          traceId: pickString(span, ["traceId", "trace_id"]),
          spanId: pickString(span, ["spanId", "span_id"]),
          parentSpanId: pickString(span, ["parentSpanId", "parent_span_id"]),
          name: String(span.name ?? "unnamed-span"),
          serviceName:
            (resourceAttrs["service.name"] != null ? String(resourceAttrs["service.name"]) : null) ??
            pickString(span, ["serviceName", "service_name"]),
          status: normalizeStatus(span.status),
          attributes: spanAttrs,
          resourceAttributes: resourceAttrs,
          scopeAttributes: scopeAttrs,
          scopeName: pickString(scope, ["name"]),
          scopeVersion: pickString(scope, ["version"]),
          startTime: toTimestampFromNanos(pickString(span, ["startTimeUnixNano", "start_time_unix_nano"])),
          endTime: toTimestampFromNanos(pickString(span, ["endTimeUnixNano", "end_time_unix_nano"])),
          runCaseId: extractCorrelationId(merged, RUN_CASE_KEYS),
          experimentId: extractCorrelationId(merged, EXPERIMENT_KEYS),
          raw: span
        });
      }
    }
  }

  return normalized;
}

function normalizeSimpleSpans(payload: Record<string, unknown>): NormalizedSpan[] {
  const spans = asRecordArray(payload.spans);
  if (spans.length === 0) {
    const single =
      pickString(payload, ["traceId", "trace_id"]) ||
      pickString(payload, ["spanId", "span_id"]) ||
      typeof payload.name === "string";
    if (single) spans.push(payload);
  }

  return spans.map((span) => {
    const spanAttrs = asRecord(span.attributes);
    const resourceAttrs = asRecord(span.resourceAttributes ?? span.resource_attributes);
    const scopeAttrs = asRecord(span.scopeAttributes ?? span.scope_attributes);
    const merged = { ...resourceAttrs, ...scopeAttrs, ...spanAttrs };
    return {
      traceId: pickString(span, ["traceId", "trace_id"]),
      spanId: pickString(span, ["spanId", "span_id"]),
      parentSpanId: pickString(span, ["parentSpanId", "parent_span_id"]),
      name: String(span.name ?? "unnamed-span"),
      serviceName: pickString(span, ["serviceName", "service_name"]),
      status: normalizeStatus(span.status),
      attributes: spanAttrs,
      resourceAttributes: resourceAttrs,
      scopeAttributes: scopeAttrs,
      scopeName: pickString(span, ["scopeName", "scope_name"]),
      scopeVersion: pickString(span, ["scopeVersion", "scope_version"]),
      startTime: toIso(span.startTime ?? span.start_time),
      endTime: toIso(span.endTime ?? span.end_time),
      runCaseId: extractCorrelationId(merged, RUN_CASE_KEYS),
      experimentId: extractCorrelationId(merged, EXPERIMENT_KEYS),
      raw: span
    } satisfies NormalizedSpan;
  });
}

function bodyToFields(value: unknown): { bodyText: string | null; bodyJson: unknown } {
  if (value == null) return { bodyText: null, bodyJson: null };
  if (typeof value === "string") return { bodyText: value, bodyJson: null };
  if (typeof value === "number" || typeof value === "boolean") return { bodyText: String(value), bodyJson: value };
  try {
    return { bodyText: JSON.stringify(value), bodyJson: value };
  } catch {
    return { bodyText: String(value), bodyJson: null };
  }
}

function normalizeOtlpLogs(payload: Record<string, unknown>): NormalizedLog[] {
  const normalized: NormalizedLog[] = [];
  const resourceLogs = asRecordArray(payload.resourceLogs ?? payload.resource_logs);

  for (const resourceLog of resourceLogs) {
    const resourceAttrs = attrsToMap(asRecord(resourceLog.resource).attributes);
    const scopeLogs = asRecordArray(resourceLog.scopeLogs ?? resourceLog.scope_logs ?? resourceLog.instrumentationLibraryLogs);

    for (const scopeLog of scopeLogs) {
      const scope = asRecord(scopeLog.scope ?? scopeLog.instrumentationLibrary);
      const scopeAttrs = attrsToMap(scope.attributes);
      const logRecords = asRecordArray(scopeLog.logRecords ?? scopeLog.log_records);

      for (const logRecord of logRecords) {
        const logAttrs = attrsToMap(logRecord.attributes);
        const merged = { ...resourceAttrs, ...scopeAttrs, ...logAttrs };
        const bodyValue = attrValueToUnknown(asRecord(logRecord.body));
        const body = bodyToFields(bodyValue);
        normalized.push({
          traceId: pickString(logRecord, ["traceId", "trace_id"]),
          spanId: pickString(logRecord, ["spanId", "span_id"]),
          serviceName: resourceAttrs["service.name"] != null ? String(resourceAttrs["service.name"]) : null,
          severityText: pickString(logRecord, ["severityText", "severity_text"]),
          severityNumber: pickNumber(logRecord, ["severityNumber", "severity_number"]),
          bodyText: body.bodyText,
          bodyJson: body.bodyJson,
          attributes: logAttrs,
          resourceAttributes: resourceAttrs,
          scopeAttributes: scopeAttrs,
          scopeName: pickString(scope, ["name"]),
          scopeVersion: pickString(scope, ["version"]),
          flags: pickNumber(logRecord, ["flags"]),
          droppedAttributesCount: pickNumber(logRecord, ["droppedAttributesCount", "dropped_attributes_count"]),
          eventTime: toTimestampFromNanos(pickString(logRecord, ["timeUnixNano", "time_unix_nano"])),
          observedTime: toTimestampFromNanos(pickString(logRecord, ["observedTimeUnixNano", "observed_time_unix_nano"])),
          runCaseId: extractCorrelationId(merged, RUN_CASE_KEYS),
          experimentId: extractCorrelationId(merged, EXPERIMENT_KEYS),
          raw: logRecord
        });
      }
    }
  }

  return normalized;
}

function normalizeSimpleLogs(payload: Record<string, unknown>): NormalizedLog[] {
  const logs = asRecordArray(payload.logs);
  if (logs.length === 0) {
    const single =
      pickString(payload, ["traceId", "trace_id"]) ||
      pickString(payload, ["spanId", "span_id"]) ||
      payload.severityText != null ||
      payload.body != null;
    if (single) logs.push(payload);
  }

  return logs.map((logRecord) => {
    const logAttrs = asRecord(logRecord.attributes);
    const resourceAttrs = asRecord(logRecord.resourceAttributes ?? logRecord.resource_attributes);
    const scopeAttrs = asRecord(logRecord.scopeAttributes ?? logRecord.scope_attributes);
    const merged = { ...resourceAttrs, ...scopeAttrs, ...logAttrs };
    const body = bodyToFields(logRecord.body);

    return {
      traceId: pickString(logRecord, ["traceId", "trace_id"]),
      spanId: pickString(logRecord, ["spanId", "span_id"]),
      serviceName:
        pickString(logRecord, ["serviceName", "service_name"]) ??
        (resourceAttrs["service.name"] != null ? String(resourceAttrs["service.name"]) : null),
      severityText: pickString(logRecord, ["severityText", "severity_text"]),
      severityNumber: pickNumber(logRecord, ["severityNumber", "severity_number"]),
      bodyText: body.bodyText,
      bodyJson: body.bodyJson,
      attributes: logAttrs,
      resourceAttributes: resourceAttrs,
      scopeAttributes: scopeAttrs,
      scopeName: pickString(logRecord, ["scopeName", "scope_name"]),
      scopeVersion: pickString(logRecord, ["scopeVersion", "scope_version"]),
      flags: pickNumber(logRecord, ["flags"]),
      droppedAttributesCount: pickNumber(logRecord, ["droppedAttributesCount", "dropped_attributes_count"]),
      eventTime: toIso(logRecord.eventTime ?? logRecord.event_time),
      observedTime: toIso(logRecord.observedTime ?? logRecord.observed_time),
      runCaseId: extractCorrelationId(merged, RUN_CASE_KEYS),
      experimentId: extractCorrelationId(merged, EXPERIMENT_KEYS),
      raw: logRecord
    } satisfies NormalizedLog;
  });
}

export async function ingestTracePayload(payload: Record<string, unknown>) {
  const spans = payload.resourceSpans || payload.resource_spans ? normalizeOtlpSpans(payload) : normalizeSimpleSpans(payload);
  if (spans.length === 0) {
    throw new Error("No spans found in payload. Use OTLP JSON(resourceSpans) or { spans: [...] }");
  }

  for (const span of spans) {
    await dbQuery(
      `INSERT INTO otel_traces (
        trace_id, span_id, parent_span_id, name, service_name, status,
        attributes, resource_attributes, scope_attributes, scope_name, scope_version,
        start_time, end_time, run_case_id, experiment_id, raw
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        span.traceId,
        span.spanId,
        span.parentSpanId,
        span.name,
        span.serviceName,
        span.status,
        JSON.stringify(span.attributes),
        JSON.stringify(span.resourceAttributes),
        JSON.stringify(span.scopeAttributes),
        span.scopeName,
        span.scopeVersion,
        toDbDateTime(span.startTime),
        toDbDateTime(span.endTime),
        span.runCaseId,
        span.experimentId,
        JSON.stringify(span.raw)
      ]
    );
  }

  return spans.length;
}

export async function ingestLogPayload(payload: Record<string, unknown>) {
  const logs = payload.resourceLogs || payload.resource_logs ? normalizeOtlpLogs(payload) : normalizeSimpleLogs(payload);
  if (logs.length === 0) {
    throw new Error("No logs found in payload. Use OTLP JSON(resourceLogs) or { logs: [...] }");
  }

  for (const log of logs) {
    await dbQuery(
      `INSERT INTO otel_logs (
        trace_id, span_id, service_name, severity_text, severity_number,
        body_text, body_json, attributes, resource_attributes, scope_attributes,
        scope_name, scope_version, flags, dropped_attributes_count,
        event_time, observed_time, run_case_id, experiment_id, raw
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        log.traceId,
        log.spanId,
        log.serviceName,
        log.severityText,
        log.severityNumber,
        log.bodyText,
        log.bodyJson == null ? null : JSON.stringify(log.bodyJson),
        JSON.stringify(log.attributes),
        JSON.stringify(log.resourceAttributes),
        JSON.stringify(log.scopeAttributes),
        log.scopeName,
        log.scopeVersion,
        log.flags,
        log.droppedAttributesCount,
        toDbDateTime(log.eventTime),
        toDbDateTime(log.observedTime),
        log.runCaseId,
        log.experimentId,
        JSON.stringify(log.raw)
      ]
    );
  }

  return logs.length;
}
