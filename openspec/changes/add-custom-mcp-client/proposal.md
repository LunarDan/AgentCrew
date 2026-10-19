# Proposal: custom adapter 接入外部 MCP（P1）

## Why

外部 MCP 在 P0 只接进了 claude-code 与 codex。custom adapter（DeepSeek / OpenAI / 火山方舟 / OpenAI-compatible）自跑 Chat Completions tool loop，目前对 `agents.mcp_server_ids` 完全不消费：

- `ADAPTER_TRANSPORTS.custom` 为空（`src/shared/mcp.ts:15`），`resolveMcpServersForAgent` 直接返回空（`src/server/mcp-server-service.ts:258-260`）；
- 即使 agent builder 里勾选了 server，custom run 也看不到任何工具，且没有任何提示。

结果是「同一个 server，SDK agent 能用、custom agent 不能」，而 custom 是自建 provider / 本地模型的主路径。`specs/15-external-mcp.md` §10 把这一步列为 **P1**，P0 的接线（数据模型、解析、UI、`AdapterInput.mcpServers`）已经为此准备好。

## What Changes

1. **传输矩阵**：`custom` 支持 `stdio` / `sse` / `http`，与 claude-code 对齐（MCP 官方客户端三种传输都支持）。
2. **per-run MCP 客户端层**（`@modelcontextprotocol/sdk` 已在依赖中）：连接 → `listTools` → 工具命名空间化 → 在 custom tool loop 中路由调用 → run 结束/中止时关闭连接并清理 stdio 进程树。
3. **工具命名**：对模型暴露 `mcp__<server>__<tool>`；按 OpenAI function name 约束（`[A-Za-z0-9_-]{1,64}`）清洗，路由用运行期映射而不是反解析名字。
4. **审批门一并落地（原 P2 提前）**：custom 调用 `trust='ask'` 的外部工具时复用现有 `pending-mcp-tools` / `mcp-approvals`，粒度 per-tool-per-conversation，与 Claude Code 一致。拒绝返回 `isError` 结果、run 继续。
5. **失败可见**：连接或 `listTools` 失败时跳过该 server、run 继续，并通过 F2 的 `mcp_server.unavailable` 事件在会话里留下 `[MCP]` 系统提示。

## Impact

- **行为**：勾选了 server 的 custom / orchestrator agent（orchestrator 也是 custom）会多出 MCP 连接与外部工具；没有勾选时行为不变。
- **Spec**：`openspec/specs/external-mcp/spec.md` 的 transport 矩阵、trust 门适用范围、P1/P2 分期要更新；`openspec/specs/adapters/spec.md` 增加 custom 的 MCP 路由要求；`specs/15-external-mcp.md`、`specs/05-adapter-interface.md` 同步。
- **安全约束**：`CLAUDE.md §5.5` 的「`trust='ask'` 只在 Claude Code 生效」改为「Claude Code 与 custom 生效，Codex 仍不受此门约束」。这条已在 2026-10-19 与用户讨论并选定「一并做审批门」。
- **不变**：Codex 的传输与审批边界、mock adapter、连接池 / OAuth（仍属 P2）、DB schema、StreamEvent 集合（复用 `tool.call` / `tool.result` / `mcp_tool.*` / `mcp_server.unavailable`）。
- **依赖**：无新增（`@modelcontextprotocol/sdk ^1.29.0` 已在 dependencies）。
