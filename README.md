# Agent Benchmark 管理/运行平台

基于 Next.js + Postgres 的 benchmark 平台，包含：
- 评测集/数据项管理
- LLM as Judge 评估器管理（自动加载 `llm-as-judge-demo/` 四个预设）
- OpenTelemetry Trace 上报与查看
- 实验管理与运行（环境构建 -> 输入下发 -> 轨迹/输出评估）

## 1. 环境变量

项目直接读取 `.env`（你已提供）：

- `POSTGRES_SERVER`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_PORT`
- `POSTGRES_DB` (应为 `benchmark`)

可选：
- `OPENAI_API_KEY`（提供后使用真实 LLM Judge）
- `JUDGE_MODEL`（默认 `gpt-4.1-mini`）

## 2. 安装与运行

```bash
npm install
npm run dev
```

启动后访问：
- `/` 总览
- `/datasets` 评测集与数据项
- `/evaluators` 评估器
- `/traces` Trace
- `/experiments` 实验管理与运行

## 3. 数据库

服务端首次访问数据库时会自动：
- 创建表：
  - `datasets`
  - `data_items`
  - `evaluators`
  - `traces`
  - `experiments`
  - `experiment_runs`
  - `run_item_results`
- 从 `llm-as-judge-demo/*.txt` 自动写入/更新 4 个评估器

## 4. OpenTelemetry 上报

上报地址：

```bash
POST /api/otel/v1/traces
```

支持：
1. OTLP JSON（`resourceSpans` 结构）
2. 简化结构：

```json
{
  "spans": [
    {
      "traceId": "demo-trace",
      "spanId": "demo-span",
      "name": "benchmark.run",
      "serviceName": "benchmark-platform",
      "attributes": {"env": "test"},
      "status": "OK",
      "startTime": "2026-02-24T10:00:00.000Z",
      "endTime": "2026-02-24T10:00:01.000Z"
    }
  ]
}
```

## 5. 实验运行语义

实验运行会按数据项执行：
1. `environment-snapshot` -> 判定环境构建状态
2. `user-input` -> 判定输入下发状态
3. 使用 `agent-trajectory` + `agent-output` + 启用评估器打分
4. 写入 `run_item_results` 与 `experiment_runs.summary`

当前默认是 `replay` 模式（复用数据项里的轨迹和输出）；若配置 `OPENAI_API_KEY`，评估步骤会调用真实 LLM Judge。
