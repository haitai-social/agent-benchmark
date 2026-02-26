# Agent Benchmark 管理/运行平台

当前仓库已调整为 monorepo：
- `platform/`：Next.js 管理平台（Vercel 部署目标）
- `consumer/`：RabbitMQ Consumer 服务（待实现）

## 本地运行

```bash
cd platform
npm install
npm run dev
```

常用命令（均在 `platform/` 目录执行）：
- `npm run dev`
- `npm run build`
- `npm run typecheck`

## Vercel 部署说明

本次结构调整后，请将 Vercel Project 的 **Root Directory** 设置为 `platform`。

## 平台能力（platform）

- Datasets / DataItems 管理
- Agents 管理
- Evaluators 管理
- Experiments 管理与运行
- RabbitMQ Producer（实验启动时发送消息）
- OpenTelemetry Trace 上报与查看

## 环境变量

平台服务读取 `platform/.env`（或运行环境变量）：

- `POSTGRES_SERVER`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_PORT`
- `POSTGRES_DB`

MySQL 模式：
- `MYSQL_SERVER`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `MYSQL_PORT`
- `MYSQL_DB`

RabbitMQ：
- `RABBITMQ_HOST`
- `RABBITMQ_PORT`
- `RABBITMQ_USER`
- `RABBITMQ_PASSWORD`
- `RABBITMQ_VHOST`
- `RABBITMQ_EXPERIMENT_QUEUE`（默认：`haitai.agent.benchmark.experiment`）
