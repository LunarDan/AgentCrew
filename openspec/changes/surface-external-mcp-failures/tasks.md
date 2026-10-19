## 0. Decisions (2026-10-19)

- [x] 0.1 用户可见面用**持久系统消息**（`role: 'system'`，每 run 一条 `msg_mcp_<runId>`），不新增 UI 组件、不引入 toast 依赖。
- [x] 0.2 adapter → runner 之间新增 **`mcp_server.unavailable`** 生命周期事件；它是透传事件，不落库，客户端 store 忽略。不是「调用上报」，不违反 `openspec/specs/external-mcp/spec.md` 的既有约束。
- [x] 0.3 只对 `failed` / `needs-auth` / `disabled` 告警；`pending` 与未知状态不告警，避免连接尚未就绪时误报。
- [x] 0.4 两类失败（解析阶段 + SDK spawn 阶段）都走同一条系统消息；同一 run 内追加 part，不刷屏。

## 1. Spec（commit 1，先落）

- [x] 1.1 `openspec/specs/external-mcp/spec.md` — MODIFY「External MCP failure SHALL be isolated per server」：补「MUST be surfaced as a persistent conversation-visible warning」，加解析失败 / spawn 失败 / 全健康三个 Scenario。
- [x] 1.2 `openspec/specs/stream-events/spec.md` — ADD「MCP server unavailability SHALL be reported as a lifecycle event」+ 两个 Scenario。
- [x] 1.3 `openspec/changes/surface-external-mcp-failures/` — `proposal.md`、`design.md`、本文件、两份 delta。

## 2. Docs（commit 2）

- [x] 2.1 `specs/02-stream-events.md` — 事件 union + payload + 持久化表（❌ 透传）+ 新事件 checklist。
- [x] 2.2 `specs/05-adapter-interface.md` — SDK init 行补「读取 `mcp_servers` 状态」。
- [x] 2.3 `specs/15-external-mcp.md` — §5 事件清单、§6.4（console.warn → 用户可见）、§9 影响面、§12 F2 追加带日期的已修说明（保留原文）。
- [x] 2.4 `openspec/changes/add-external-mcp/tasks.md` — 9.7 与 F2 各追加一条带日期的后续引用，不改原文。
- [x] 2.5 `OVERVIEW.md` — 近期完成 + footer。

## 3. Implementation（commit 3）

- [x] 3.1 `src/shared/types.ts` — `McpServerRunStatus` + `mcp_server.unavailable`。
- [x] 3.2 新增 `src/server/adapters/mcp-status.ts` — `collectUnavailableServers(statuses, expectedNames)`，纯函数。
- [x] 3.3 新增 `src/server/adapters/mcp-status.test.ts` — 三种不可用状态、`connected`/`pending`/未知、`agenthub` 与未传入名字过滤、去重、空输入。
- [x] 3.4 `src/server/adapters/claude-code-adapter.ts` — init 分支加 `subtype === 'init'` 守卫，读 `mcp_servers`，非空时 yield 事件。
- [x] 3.5 新增 `src/server/mcp-notices.ts` + `.test.ts` — 解析 / 不可用两类文案；空输入返回 `null`。
- [x] 3.6 `src/server/agent-runner.ts` — `buildAdapterInput` 返回 `{ input, mcpWarnings }`；`appendMcpNotice`；`consumeStream` 处理事件；三个调用点接入。
- [x] 3.7 `pnpm typecheck`、`pnpm lint`、`pnpm test`（37 个测试文件、288 通过 / 1 跳过）。

## 4. Live verification（暂缓，2026-10-19 决定）

> 用户选择「暂不启动 dev server，先推送」。以下五格**均未执行**；实现依赖的 SDK 行为（init 的 `mcp_servers` 状态取值、失败 server 是否被整个省略）目前只有 `.d.ts` 依据。恢复验证时从这里开始。

- [ ] 4.1 坏 server 格：`command` 不存在的 stdio server，启用并在 claude-code agent 上勾选。预期 run `complete`，出现 `[MCP]` 系统消息点名该 server，且其工具不出现。**同时记录 SDK init 实际给出的 status 值**（若是「整个省略」，按 proposal 的兜底扩 `not-listed`）。
- [ ] 4.2 健康 server 格：最小 stdio echo server。预期**没有** `[MCP]` 消息（无假阳性）。
- [ ] 4.3 解析失败格：env 引用不存在的 `${VAR}`。预期 run 开始前出现解析警告消息。
- [ ] 4.4 持久化：刷新后警告仍在（系统消息落库）。
- [ ] 4.5 无 MCP 格：普通 run 不出现 `[MCP]` 消息。
- [ ] 4.6 记录结果到本文件，格式同 `fix-sdk-shell-tool-gate/tasks.md §4`。

> 这一步要起 dev server 并跑真实模型。dev server 曾多次被系统因内存终止，**动手前先问**，不自行启动。
