# Consumer AGENTS

## Scope
- 本文件作用于 `consumer/` 子目录。

## Goals
- 负责 RabbitMQ Consumer：消费实验运行消息，拉起/调用 Agent 执行，落库 RunCase 与评估结果。

## Rules
- 与 `platform` 共享消息契约版本。
- 引入 breaking schema 时必须同步更新 `platform/db` 初始化 SQL。
- 涉及 `platform/lib/*.ts` 的 schema/契约改动，必须同批更新 `platform/db/init.mysql.sql` 与 `platform/db/init.postgres.sql`。
- 对已存在数据库执行 ALTER/MIGRATION 后，必须把同等变更回写到 init SQL，禁止只改线上不改仓库。
- 所有外部副作用操作（docker/rabbitmq/db）必须可观测（日志 + error code + retry）。
- 在 `consumer/` 目录执行 Python 命令时，统一使用本项目 `.venv`（如 `.venv/bin/python`），禁止依赖系统 Python 环境。
- 涉及较大改动（架构调整、核心执行链路、消息处理主流程、运行时配置行为变化）时，提交前必须执行并通过验收脚本：`./scripts/acceptance_mq_consume.sh`。
