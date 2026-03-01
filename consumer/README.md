# Consumer (Agent Benchmark Runner)

基于 **Python** 的 RabbitMQ Consumer，实现如下能力：

1. 订阅 `experiment.run.requested` 消息。
2. 解析 Dataset + Agent + RunCases。
3. 基于 Inspect AI sandbox 启动 Docker sandbox，逐条执行 case。
4. 采集执行结果（trajectory/output/logs）作为 run case 结果。
5. case 结束后销毁容器，保证环境回到初始状态。

## 与 Platform 保持一致的 MQ 环境变量

- `RABBITMQ_HOST` (required)
- `RABBITMQ_PORT` (default `5672`)
- `RABBITMQ_USER` (required)
- `RABBITMQ_PASSWORD` (required)
- `RABBITMQ_VHOST` (default `/`)
- `RABBITMQ_EXPERIMENT_QUEUE` (default `haitai.agent.benchmark.experiment`)

## Consumer 额外配置

- `CONSUMER_CONCURRENT_CASES`：case 并发数（default `2`）
- `CONSUMER_MAX_RETRIES`：单消息最大重试次数（default `3`）
- `CONSUMER_CASE_TIMEOUT_SECONDS`：单 case 超时秒数（default `180`）
- `CONSUMER_DOCKER_NETWORK`：容器网络（可选）
- `CONSUMER_AGENT_EXEC_COMMAND`：覆盖镜像默认命令（可选）
- `CONSUMER_DOCKER_PULL_POLICY`：`always` / `if-not-present` / `never`（default `always`，建议 `if-not-present`）
- `CONSUMER_DOCKER_PULL_TIMEOUT_SECONDS`：pull 超时（default `120`）
- `CONSUMER_DOCKER_RUN_TIMEOUT_SECONDS`：run 超时（default `60`）
- `CONSUMER_DOCKER_INSPECT_TIMEOUT_SECONDS`：inspect 超时（default `10`）

## Redis 去重锁配置（防重复消费）

- `REDIS_HOST` (required)
- `REDIS_PORT` (default `6379`)
- `REDIS_USERNAME` (optional)
- `REDIS_PASSWORD` (optional)
- `REDIS_DB` (default `0`)
- `CONSUMER_REDIS_PROCESSING_LOCK_TTL_SECONDS` (default `300`)
- `CONSUMER_REDIS_PROCESSED_TTL_SECONDS` (default `86400`)

## Inspect Sandbox 运行模式

Consumer 使用 `inspect_ai` 的 sandbox provider（`arcloop_docker`）管理容器生命周期：

1. 每条 case 启动一个全新 sandbox（docker）
2. 在 sandbox 内执行 `case_exec_command`
3. case 完成后立即销毁该 sandbox

`agent.runtime_spec_json` 最少需要：

```json
{
  "agent_image": "your-image:tag",
  "case_exec_command": "python run_case.py",
  "sandbox_start_command": "sleep infinity",
  "pull_policy": "if-not-present"
}
```

- `sandbox_start_command`：可选，默认使用镜像 CMD
- `case_exec_command`：必填，必须是“一次执行并退出”的 case 命令

## OTel 轨迹回收（MVP）

consumer 在 case 执行时会：

1. 向 agent 容器注入 OTel 环境变量（`OTEL_SERVICE_NAME`、`OTEL_RESOURCE_ATTRIBUTES` 等）。
2. agent 将 spans 上报到固定 endpoint：`http://host.docker.internal:14318/api/otel/v1/traces`。
3. 内建 collector 会直接解析并写入数据库 `traces` 表。
4. case 完成后，consumer 按 `benchmark.run_case_id` 查询 spans。
5. 将 spans 映射为平台 trajectory 结构并写入 `run_cases.agent_trajectory`。
6. 若 OTel 查询失败或无数据，回退 stdout JSON trajectory 解析。

日志关键字：
- `OTEL_QUERY_START`
- `OTEL_QUERY_OK`
- `E_OTEL_QUERY_FAILED`
- `OTEL_FALLBACK_STDOUT`

## Mock Gateway（统一网络 Mock）

当 run case 携带 `mock_config` 时，Consumer 会启动内建 Python Mock Gateway，并自动给 agent 容器注入 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`（无需改 Agent 代码）。

`mock_config` 新结构（Breaking）：

```json
{
  "passthrough": true,
  "rules": [
    {
      "name": "news-json",
      "match": {
        "methods": ["GET"],
        "url_regex": "https://api\\.example\\.com/news.*"
      },
      "response": {
        "type": "json",
        "status": 200,
        "json": {
          "items": ["a", "b"]
        }
      }
    },
    {
      "name": "dynamic-python",
      "match": {
        "methods": ["POST"],
        "path": "/v1/rewrite"
      },
      "response": {
        "type": "python",
        "python_code": "def handle(request):\\n    return {'status': 200, 'json': {'echo': request.get('body_text', '')}}"
      }
    }
  ]
}
```

说明：
- `response.type=json`：按配置返回 JSON。
- `response.type=python`：执行 `python_code` 中的 `handle(request)`，返回动态响应。
- 内建默认 OTEL Mock：`POST /api/otel/v1/traces` 会拦截请求、解析 payload 并写入 `traces` 表，然后返回 200；日志关键字：`MOCK_GATEWAY_OTEL_DEFAULT_HIT`。

## 运行

```bash
cd consumer
./scripts/run-local.sh
```

`run-local.sh` 会自动：
- 创建 `.venv`（如果不存在）
- 安装依赖
- 加载 `.env`
- 启动 consumer

Python 版本统一为 `3.11.13`（见 `.python-version` 与 `Dockerfile`），远程部署请保持一致，避免多 Python 环境混用。

如果你使用私有镜像且本地已经提前 `docker login` + `docker pull`，建议在 `.env` 设置：

```bash
CONSUMER_DOCKER_PULL_POLICY=if-not-present
```

## Smoke 验证（分模块）

1. Docker 执行链路（实际 `docker run`）

```bash
cd consumer
PYTHONPATH=src .venv/bin/python tests/smoke/smoke_docker_run.py
```

2. RabbitMQ 接收链路（实际 `rabbitmq receive`）

```bash
cd consumer
PYTHONPATH=src .venv/bin/python tests/smoke/smoke_rabbitmq_receive.py
```

## Acceptance 验收（一键）

```bash
cd consumer
./scripts/e2e_experiments.sh
```

说明：当前 acceptance 为 `direct_runner` 模式，会直接构造 `experiment.run.requested` 消息并在本进程执行 runner，避免复用线上 RabbitMQ 队列导致的消息堆积干扰。

## 测试

```bash
cd consumer
PYTHONPATH=src .venv/bin/python -m pytest tests -q
```

## Kubernetes 部署

示例清单位于：
- `deploy/k8s/consumer-deployment.yaml`

最小流程：

```bash
cd consumer
docker build -t ghcr.io/haitai-social/agent-benchmark-consumer:latest .
docker push ghcr.io/haitai-social/agent-benchmark-consumer:latest
kubectl apply -f deploy/k8s/consumer-deployment.yaml
```
