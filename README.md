# Agent Benchmark 管理/运行平台

基于 Next.js + Postgres/MySQL 的 benchmark 平台，包含：
- 评测集/数据项管理（case: `session_jsonl + user_input + reference_output + trace_id/reference_trajectory`）
- Agent 实体管理（`agent_key + version` 版本化，绑定 `docker_image + openapi_spec`）
- LLM as Judge 评估器管理
- OpenTelemetry Trace 上报与查看
- 实验管理与运行（选择 dataset + agent 后运行）

## 1. 环境变量

项目直接读取 `.env`：

- `POSTGRES_SERVER`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_PORT`
- `POSTGRES_DB`

MySQL 模式使用：
- `MYSQL_SERVER`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `MYSQL_PORT`
- `MYSQL_DB`

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
- `/agents` Agent 管理
- `/evaluators` 评估器
- `/traces` Trace
- `/experiments` 实验管理与运行

## 3. 数据库

首次访问数据库时会根据 `db/init.postgres.sql` 或 `db/init.mysql.sql` 初始化。

核心表：
- `datasets`
- `data_items`
- `agents`
- `evaluators`
- `traces`
- `experiments`
- `experiment_runs`
- `run_item_results`

## 4. OpenTelemetry 上报

上报地址：

```bash
POST /api/otel/v1/traces
```

支持 OTLP JSON（`resourceSpans`）与简化 spans JSON。

## 5. 实验运行语义

当前默认 `replay` 模式：
1. 读取实验绑定的 `agent`（记录 `agent_key/version/docker_image`）
2. 读取 case 的 `session_jsonl + user_input`
3. 使用 `reference_trajectory + reference_output` 作为当前阶段运行产物
4. 使用评估器打分并写入 `run_item_results`

后续可将第 3 步替换为真实 docker + `/run` 调用。
