## 0. Decisions (2026-10-19)

- [x] 0.1 `custom` 的 transport 矩阵支持 `stdio` / `sse` / `http`，与 claude-code 对齐。
- [x] 0.2 `trust='ask'` 审批门并入 P1（原 P2 提前），复用 `pending-mcp-tools` / `mcp-approvals`；Codex 仍不受此门约束（用户 2026-10-19 选定）。
- [x] 0.3 连接生命周期 = 每次 `stream()` 一份；跨阶段连接池留 P2。
- [x] 0.4 工具名清洗到 OpenAI function name 约束，路由用运行期 `Map`，不反解析。
- [x] 0.5 connect / `listTools` 失败 → `mcp_server.unavailable`（`failed`，OAuth 错误 `needs-auth`），run 继续。
- [x] 0.6 stdio 子进程按进程树清理：新增 `killProcessTreeByPid`。
- [x] 0.7 MCP 结果转紧凑值（优先 `structuredContent`，不内联 base64，50k 截断）。

## 1. Spec（commit 1）

- [x] 1.1 `openspec/changes/add-custom-mcp-client/` — `proposal.md`、`design.md`、本文件、两份 delta。
- [x] 1.2 `openspec/specs/external-mcp/spec.md` — transport 矩阵、trust 门适用范围、custom 连接要求、D3 环境继承场景。
- [x] 1.3 `openspec/specs/adapters/spec.md` — custom tool loop 的外部 MCP 路由要求。

## 2. Docs（commit 2）

- [x] 2.1 `specs/15-external-mcp.md` — §4 adapter 接入、§6.2 trust 门范围、§7 生命周期、§9 影响面、§10 P1 状态、§12 追加带日期的实现记录（保留原文）。
- [x] 2.2 `specs/05-adapter-interface.md` — CustomAgentAdapter 高层流程补 MCP 建连/路由/清理；transport 矩阵行加 custom。
- [x] 2.3 `CLAUDE.md §5.5` — `trust='ask'` 的适用范围改为 Claude Code + custom；Codex 仍不受约束（§6.2 已讨论）。
- [x] 2.4 `OVERVIEW.md` — 功能矩阵与「近期完成」+ footer。

## 3. Implementation（commit 3）

- [x] 3.1 `src/shared/mcp.ts` — `ADAPTER_TRANSPORTS.custom = ['stdio', 'sse', 'http']`；`agent-runner.ts:2099` 与 `agent-service.ts:72` 的注释同步。
- [x] 3.2 新增 `src/server/adapters/custom-mcp-tools.ts` — 名字清洗 / 冲突后缀 / 运行期映射 / 结果转紧凑值 / 50k 截断（纯函数）。
- [x] 3.3 新增 `src/server/adapters/custom-mcp-client.ts` — `McpClients`：并行 connect + `listTools`、失败收集、`callTool`、`closeAll`；stdio 传 `buildChildProcessEnv()` 与 workspace cwd。
- [x] 3.4 `src/server/child-process.ts` — `killProcessTreeByPid(pid, platform)`。
- [x] 3.5 `src/server/adapters/custom-agent-adapter.ts` — 建连 → 合并工具表 → 路由执行（内置优先）→ 审批门 → 失败发 `mcp_server.unavailable` → `finally` 清理。
- [x] 3.6 `pnpm typecheck`、`pnpm lint`、`pnpm test`。

## 4. Tests（commit 4）

- [x] 4.1 `custom-mcp-tools.test.ts` — 合法名不变；非法字符清洗；64 字符截断；与内置/彼此冲突时加 hash；映射路由取回原始 server/tool；结果转换（text / structuredContent / image 不内联 / isError / 截断）。
- [x] 4.2 `custom-mcp-client.test.ts` — 用 `@modelcontextprotocol/sdk` 起一个进程内 stdio echo server：connect → listTools → callTool → close；坏 `command` 返回失败名单而不抛；close 后无残留子进程。
- [x] 4.3 `agent-runner` / `mcp-notices` 已有用例回归；确认无 server 时 custom 行为不变。（2026-10-19：全量 39 文件 / 308 passed / 1 skipped）

## 5. Live verification（动手前问）

环境（2026-10-19）：Windows 11，dev server，custom adapter，`deepseek-v4-pro`。测试 server 是一个自建 stdio MCP server（`echo` / `slow` 两个工具，启动时把 pid 写入文件）。所有「执行与否」的判据都是持久化的 `tool_use` / `tool_result` 与进程事实，不是模型自述。

- [x] 5.1 健康 stdio server + `trust='always'`：模型看到 `mcp__*` 工具，调用成功。
  - 模型工具表中出现 `mcp__liveecho__echo`；`tool_use.args = {"text":"hello-mcp-live"}`，`tool_result = "hello-mcp-live"`、`isError: false`；会话内无 `[MCP]` 系统提示。
- [x] 5.2 `trust='ask'`：首次弹卡 → 批准 → 执行；同会话同工具不再弹；新会话重新弹；拒绝 → `isError`，run 继续且模型不重试。
  - 首次调用等待审批（`toolName: mcp__liveecho__echo`、`serverName: liveecho`、`args: {"text":"first-ask"}`），批准 200 后执行成功。
  - 同会话第二次调用：审批队列**未**出现新条目，直接执行成功。
  - 新会话：重新弹审批；拒绝 200 后 `tool_result.isError = true`，内容为拒绝文案；全程只有 **1** 条 `tool_use`（模型未重试），run `complete`。
- [x] 5.3 坏 `command`：run `complete`，出现 `[MCP]` 系统提示，点名该 server。
  - 同时挂健康 server 与坏 server（缺失可执行文件）：健康的 echo 正常调用；会话内恰好一条系统消息：`[MCP] 外部 MCP server 未能连接，本次运行不会提供它们的工具：\n- livebroken（failed）`；run `complete`。
- [x] 5.4 中止：stdio 子进程树无残留。
  - 在 `slow` 工具调用进行中中止：子进程 pid 中止前存活，`POST /api/runs/{id}/abort` 返回 200 后进程退出（< 20s 轮询窗口内，实测数秒）；agent 消息 `complete`；事后 `Get-CimInstance` 未发现任何 `agenthub-live-mcp` 残留进程。
- [x] 5.5 无 MCP 的 custom run 行为不变；Codex run 不受影响。
  - 无 MCP：agent 消息只有文本 `ok`，无 tool part，0 条系统消息。
  - Codex：本次改动未触碰 `codex-adapter` / Codex 配置翻译路径，transport 矩阵中 Codex 行未变；回归由全量单测覆盖（39 文件 / 308 passed / 1 skipped）。
- [x] 5.6 记录结果到本文件，格式同 `fix-sdk-shell-tool-gate/tasks.md §4`。

> 现场发现并处理的非代码问题：上一轮 dev server 的 `.next` 编译缓存损坏，嵌套动态 API 路由（`pending-mcp-tools/[callId]`、`pending-writes/[pwId]`）被当成页面返回 404 HTML。清空 `.next` 重启后恢复，与应用代码无关。

> dev server 曾多次被系统因内存终止，**动手前先问**，不自行启动。
