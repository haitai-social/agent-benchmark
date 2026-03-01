# Contracts AGENTS

## Scope
- 本文件作用于 `contracts/` 目录。
- 当前核心文件：`template_variables.json`。

## Purpose
- `contracts/` 用于存放跨模块（`platform/` 与 `consumer/`）共享的契约定义。
- 这里的契约应保持“单一来源（single source of truth）”。

## Template Variables Contract
- `template_variables.json` 定义所有可用模板变量及其说明。
- 变量按 `groups` 分组管理（例如：
  - `evaluator_prompt`
  - `agent_runtime_commands`
 ）。
- 新增或修改模板变量时，应只改这一处，并由各模块消费该文件，不要在业务代码里再写硬编码副本。

## Change Rules
- 修改模板变量时，必须保证：
  1. `path` 稳定、可解析。
  2. `description` 清晰可读。
  3. 如有示例，`example` 与真实使用场景一致。
- 若变量影响运行时渲染行为（如 command template），需同步验证：
  - `platform` 页面提示是否正确展示。
  - `consumer` 渲染与校验是否一致。

## Compatibility
- 允许 breaking change，但必须在同一批改动中同步更新所有消费者。
- 避免“改了变量定义但未更新消费侧”的半完成状态。
