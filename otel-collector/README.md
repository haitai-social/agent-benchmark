# otel-collector

独立于 `platform/` 与 `consumer/` 的 OTEL Access Layer。

## 接口

- `POST /v1/traces`：上报 Trace（支持 OTLP JSON `resourceSpans`）
- `POST /v1/traces/query`：按 `run_case_id + time window` 查询 spans
- `POST /v1/traces/query-window`：按 `time window + service_name` 查询 spans

## 启动

```bash
cd otel-collector
python src/server.py
```

默认监听：`0.0.0.0:14318`。
