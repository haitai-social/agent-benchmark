# Platform AGENTS

## 1) Purpose
- 统一本项目的实现风格与协作标准，保证功能改动具备：
- 可运行（runnable）
- 可评测（evaluable）
- 可复现（reproducible）

## 2) Scope And Priority
- 本文件作用于 `platform/` 子目录：`app/`、`lib/`、`db/`。
- 若未来子目录存在更细粒度 `AGENTS.md`，子目录规则优先。
- 未覆盖事项遵循当前代码库既有模式和最小改动原则。

## 3) Repository Facts
- Framework: Next.js App Router + Server Actions
- Database: MySQL / Postgres dual init SQL
- Core entities:
- `Datasets`
- `DataItems`
- `Agents`
- `Evaluators`
- `Experiments`
- `RunCases`

## 4) Design System Contract (Frontend)
- 必须优先复用现有通用组件与样式语义，避免页面内重复造轮子：
- `EntityDrawer`
- `FormField`
- `SubmitButton`
- `primary-btn` / `ghost-btn` / `text-btn` / `icon-btn`
- 列表页顶部统一保留：`搜索` + `筛选`。
- 侧边栏抽屉规则：
- 创建/更新成功后必须收起。
- 顶部不放冗余说明性描述文案。
- 可点击元素必须有明确 hover 反馈：
- 鼠标 `pointer`
- 可见状态变化（边框/底色/位移/下划线至少一种）
- 表单必填字段统一使用红星；optional 字段不做强制标识。

## 5) Entity UX Contract
- 所有实体默认支持 CRUD（除业务明确禁止）。
- 带二级页的实体（如 `Datasets`、`Experiments`）：
- 列表行中保留“详情（抽屉）”能力。
- 同时提供跳转二级页 icon，保证管理与浏览兼顾。
- 行内操作按钮（更新/删除/取消）必须保持一致：
- 宽度、边框、背景、对齐风格一致。

## 6) Data Modeling And DB Rules
- 删除策略默认采用软删除：
- `is_deleted`
- `deleted_at`
- 列表查询与关联查询必须显式过滤未删除数据。
- 所有 schema 变更必须同时更新：
- `db/init.mysql.sql`
- `db/init.postgres.sql`
- 若已有线上/本地存量库，提供对应 SQL 迁移命令（ALTER/MIGRATION）。
- 禁止只改代码不改 init SQL，避免重建数据库后结构不一致。

## 7) Experiment And Run Semantics
- 一个 `Experiment` 只允许一次主运行（single primary run）。
- `RunCase` 是评测最小单元：
- 一条 `RunCase` = 一个 `DataItem` + 一个 `Agent` 的一次执行结果。
- `RunCase` 支持重试。
- “实验重试”的语义固定为：只重试失败的 `RunCase`，不重跑成功项。
- 每个 `RunCase` 必须可持久化：
- trajectory
- output
- logs
- evaluator scores / final score

## 8) API And Contract Rules
- Agent 运行接口统一契约：
- 输入：`session_jsonl` + `user_input`
- 输出：`trajectory` + `output` + `logs` + `usage`
- 状态枚举、字段命名、时间字段语义必须统一定义，禁止页面或模块各自发明。
- 面向 UI 的 optional/required 标识必须与真实业务约束一致，不得仅凭展示层臆断。

## 9) Coding Rules
- 优先复用现有组件和 SQL 访问模式。
- 改动涉及数据库字段时，必须同步更新 TypeScript 类型。
- 允许破坏性调整，但必须“代码 + schema + 页面行为”同批落地。
- 禁止引入临时分叉逻辑作为长期方案。

## 10) Verification Checklist
- 页面交互：
- 搜索、筛选、抽屉开闭、hover 可点击态正常。
- 创建/更新后抽屉自动收起。
- 实体管理：
- 详情、更新、删除链路完整。
- 有二级页的实体保留跳转入口。
- 数据一致性：
- 软删除过滤正确。
- 重建数据库后页面查询无缺列错误。
- 实验运行：
- 可发起运行。
- 可查看 run 明细。
- 可重试失败 `RunCase`。
- 轨迹与输出可取回用于评测。

## 11) PR / Commit Template
- What changed
- Why
- Schema impact
- UX impact
- Validation performed

## 12) Defaults
- 默认沿用当前项目视觉主题与交互语言，不做全量重设计。
- 默认继续使用软删除策略。
