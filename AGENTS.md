# Monorepo AGENTS

本文件是根目录入口规则，具体实现规范在子目录内：
- `platform/AGENTS.md`
- `consumer/AGENTS.md`

优先级：离代码更近的 `AGENTS.md` 优先。

## Cross-Module Schema Rule
- 任何涉及数据库字段/类型/消息契约的改动，必须同批更新：
- `platform/lib/**/*.ts`（或相关业务代码）
- `platform/db/init.mysql.sql`
- `platform/db/init.postgres.sql`
- 若环境为已存在数据库，必须执行对应 ALTER/MIGRATION，同步线上与初始化 SQL。
