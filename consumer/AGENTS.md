# Consumer AGENTS

## Scope
- 本文件作用于 `consumer/` 子目录。

## Goals
- 负责 RabbitMQ Consumer：消费实验运行消息，拉起/调用 Agent 执行，落库 RunCase 与评估结果。

## Rules
- 与 `platform` 共享消息契约版本。
- 引入 breaking schema 时必须同步更新 `platform/db` 初始化 SQL。
- 所有外部副作用操作（docker/rabbitmq/db）必须可观测（日志 + error code + retry）。
