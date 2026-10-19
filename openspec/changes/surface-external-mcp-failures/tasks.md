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

## 4. Live verification（2026-10-20 补跑完成）

环境（2026-10-20）：Windows 11，dev server，claude-code adapter，`claude-sonnet-4-6`（经 relay）。测试 server 为自建 stdio MCP server（`echo` 一个工具）。判据均为持久化消息与进程事实。

- [x] 4.1 坏 server 格：`command` 不存在的 stdio server，启用并在 claude-code agent 上勾选。预期 run `complete`，出现 `[MCP]` 系统消息点名该 server，且其工具不出现。**同时记录 SDK init 实际给出的 status 值**（若是「整个省略」，按 proposal 的兜底扩 `not-listed`）。
  - 同时勾选坏 server `f2bad` 与健康 server `f2ok`：健康的 `mcp__f2ok__echo` 正常调用（`tool_result` 为 `f2-ok`）；会话内一条系统消息：`[MCP] 外部 MCP server 未能连接，本次运行不会提供它们的工具：\n- f2bad（failed）`；run `complete`。
  - **SDK init 实际给出 `failed`**（不是整个省略）。原 proposal 里「省略 → `not-listed`」的兜底**不需要**实现。
- [x] 4.2 健康 server 格：最小 stdio echo server。预期**没有** `[MCP]` 消息（无假阳性）。
  - 只勾选 `f2ok`：工具调用成功，系统消息数 **0**。
- [x] 4.3 解析失败格：env 引用不存在的 `${VAR}`。预期 run 开始前出现解析警告消息。
  - `f2env` 的 `TOKEN` 引用 `${AGENTHUB_LIVE_MISSING_VAR_2026}`：run 前出现一条系统消息：`[MCP] 外部 MCP server 配置有问题，本次运行已跳过：\n- MCP server "f2env" could not be resolved: MCP env placeholder ${AGENTHUB_LIVE_MISSING_VAR_2026} is not set in the environment`；run `complete`。
- [x] 4.4 持久化：刷新后警告仍在（系统消息落库）。
  - 重启 dev server 后重新 GET 上述两个会话：4.1 与 4.3 的系统消息仍在（各 1 条），确认是 DB 持久化而非进程内状态。
- [x] 4.5 无 MCP 格：普通 run 不出现 `[MCP]` 消息。
  - 未勾选任何 server：agent 回复 `done`，系统消息数 **0**。
- [x] 4.6 记录结果到本文件，格式同 `fix-sdk-shell-tool-gate/tasks.md §4`。

> 这一步要起 dev server 并跑真实模型。dev server 曾多次被系统因内存终止，**动手前先问**，不自行启动。
