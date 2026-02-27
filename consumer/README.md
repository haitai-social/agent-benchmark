# Consumer (Agent Benchmark Runner)

基于 **Python** 的 RabbitMQ Consumer，实现如下能力：

1. 订阅 `experiment.run.requested` 消息。
2. 解析 Dataset + Agent + RunCases。
3. 按并发限制调度 Docker，逐条执行 case。
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

- `CONSUMER_CONCURRENT_CASES`：case 并发数（default `4`）
- `CONSUMER_MAX_RETRIES`：单消息最大重试次数（default `3`）
- `CONSUMER_CASE_TIMEOUT_SECONDS`：单 case 超时秒数（default `180`）
- `CONSUMER_DOCKER_NETWORK`：容器网络（可选）
- `CONSUMER_AGENT_EXEC_COMMAND`：覆盖镜像默认命令（可选）

## MockSideCar（Testcontainers）

当 run case 携带 `mock_config` 时，Consumer 会用 testcontainers 启动 WireMock sidecar：

- 启动 mock 容器并等待 ready
- 将路由规则写入 WireMock admin API
- 将 sidecar 地址注入 Agent 容器环境变量
- case 结束后自动销毁 sidecar

## 运行

```bash
cd consumer
pip install -r requirements.txt
PYTHONPATH=src python -m consumer.main
```

## 测试

```bash
cd consumer
PYTHONPATH=src python -m pytest tests -q
```
