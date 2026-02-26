# Agent Benchmark 管理/运行平台

当前仓库已调整为 monorepo：
- `platform/`：Next.js 管理平台（Vercel 部署目标）
- `consumer/`：RabbitMQ Consumer 服务（待实现）

## 本地运行

```bash
npm install
npm run dev
```

默认会启动 `platform` 工作区。

常用命令：
- `npm run dev`
- `npm run build`
- `npm run typecheck`
- `npm run dev:platform`

## Vercel 部署说明

此仓库保留 root 脚本作为统一入口，Vercel 可直接以仓库根目录构建。

## 平台能力（platform）

- Datasets / DataItems 管理
- Agents 管理
- Evaluators 管理
- Experiments 管理与运行
- RabbitMQ Producer（实验启动时发送消息）
- OpenTelemetry Trace 上报与查看

## 环境变量

平台服务读取 `.env`（或运行环境变量）：

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
