# Design: custom adapter 接入外部 MCP（P1）

## 1. 为什么审批门提前到 P1

`specs/15` 原本把「Codex/custom 的审批门」列为 P2。但 custom 的 tool loop **没有 `canUseTool` 之类的钩子**，外部工具一旦接进来就会被模型直接调用；先上 P1 再补审批，等于在默认配置（`trust='ask'`）下开一条无审批的外部工具通道，UI 还会因为字段存在而暗示一层不存在的保护 —— 与 D1 把 `ask` 门提前到 P0 的理由完全相同。

现有审批设施本来就和 adapter 无关：

- `pending-mcp-tools.ts` 只管队列 + `mcp_tool.pending` / `mcp_tool.resolved`；
- `mcp-approvals.ts` 只管 per-conversation 记忆；
- 前端审批 UI 只看事件，不区分 adapter。

custom 只需要在**执行外部工具前**调用 `isToolApproved` / `waitForMcpToolApproval`，因此增量很小。**Codex 仍不接审批门**（它的审批策略与沙箱在 AgentHub 之外），本次不改。

## 2. 连接生命周期：每个 `stream()` 调用一份

```
stream(input, signal)
  ├─ connectAll(input.mcpServers)      // 并行；单个失败不影响其它
  ├─ listTools() per server            // 并行；失败 → 跳过该 server
  ├─ tool loop（最多 8 轮）
  │    └─ 每个 tool_call：内置工具 or 外部 MCP 工具
  └─ finally: closeAll() + killProcessTree
```

- custom adapter 一次 `stream()` 就是一次独立 run / 阶段；orchestrator 的 plan、子 agent、aggregate 各自是独立调用，因此各自建连。跨阶段复用属 P2 连接池，本次不做。
- 连接在 `message.start` **之前**完成；失败信息通过 `mcp_server.unavailable` 事件交给 AgentRunner，复用 F2 的持久提示。
- 连接/列工具并行（`Promise.allSettled`），总等待由最慢的 server 决定，而不是相加。

## 3. 工具暴露与命名

对模型暴露的 function name：`mcp__<serverName>__<toolName>`，与两个 SDK adapter 的既有约定一致。

但 OpenAI 兼容端的 function name 约束是 `^[A-Za-z0-9_-]{1,64}$`，而 server / tool 名是用户或第三方给的，可能含点、空格、非 ASCII 或超长。因此：

1. 对 server / tool 名做字符清洗（非法字符 → `_`）；
2. 若结果超过 64 字符，或与内置工具名 / 另一个 MCP 工具清洗后重名，追加 `_<8 位 hash>` 后缀并截断到 64；
3. **路由不反解析名字**：运行期维护 `Map<exposedName, { serverName, toolName }>`。审批事件里的 `toolName` 用暴露名，`serverName` 用原始 server 名，UI 展示与 claude-code 一致。

内置工具名优先：暴露名与 `toolRegistry` 的工具重名时，给 MCP 工具加 hash 后缀而不是覆盖内置工具。`mock` adapter 不接。

## 4. 调用与结果转换

- `tool.call` 先发出（含暴露名与参数），再执行，最后 `tool.result`；
- 调用走 `Client.callTool({ name: bareToolName, arguments }, undefined, { signal, timeout })`；
- 结果转成 JSON 可序列化的紧凑值，避免把 base64 塞进下一轮 prompt：
  - 有 `structuredContent` → 优先用它；
  - 否则拼接 `content` 里的 text block；image / audio / resource 只保留描述（mimeType、字节数、uri），**不内联 data**；
  - `isError` 原样带到 `tool.result.isError`；
  - 结果序列化后超过 50 000 字符时截断并追加 `[truncated]`；
- 工具结果按既有 custom 约定回灌为 `role: 'tool'` 消息（`JSON.stringify`），继续下一轮。

超时（可调常量，先给保守值）：connect 30s、`listTools` 30s、单次 `callTool` 120s。冷启动 `npx -y` 可能超过 15s（spec 15 D5 的教训），30s 是连接阶段的底线。

## 5. 失败处理

| 阶段 | 行为 | 用户可见性 |
|---|---|---|
| 解析（runner 已完成） | 该 server 不在 `input.mcpServers` 里 | 已有 F2 `[MCP]` 配置提示 |
| connect / `listTools` 失败 | 关闭该 transport，跳过；其它 server 继续 | adapter 发 `mcp_server.unavailable`，status 为 `failed`；OAuth 类错误（SDK `UnauthorizedError`）标 `needs-auth` |
| `callTool` 抛错 | 该次调用返回 `isError` 结果，模型可继续 | `tool.result.isError` |
| 审批被拒 | 返回「用户拒绝，请勿重试」的 `isError` 结果 | `mcp_tool.resolved` + 工具结果 |
| run 中止 | 连接与全部 stdio 子进程回收 | 沿用 run 中止语义 |

一个 server 的 `listTools` 返回空列表不算失败（合法 server 可以没有工具）。

## 6. stdio 进程树清理

MCP SDK 的 `StdioClientTransport` 用普通 `spawn`（**没有 `detached`**），`close()` 只对直接子进程发 SIGTERM。Windows 上孙进程会残留，POSIX 上也不能依赖进程组。因此新增 `killProcessTreeByPid(pid, platform)`（`src/server/child-process.ts`）：

- Windows：`taskkill /F /T /PID <pid>`；
- POSIX：`ps -Ao pid=,ppid=` 收集后代，先子后父发信号。

清理顺序：先记下 `transport.pid` → `client.close()` → `killProcessTreeByPid(pid)` 兜底。若 transport 明确报告已退出，可跳过。这样 spec 15「stdio 子进程按进程树终止」对 custom 同样成立。

## 7. stdio 环境与 cwd

- `env: { ...buildChildProcessEnv(), ...server.env }` —— 显式传入**完整进程环境**，不用 SDK 的 `getDefaultEnvironment()` 白名单。与 spec 15 §6.3 / D3 的「完整继承，不是白名单」一致。
- `cwd: input.workspacePath`（effective cwd），与两个 SDK adapter 的 workspace cwd 对齐。

## 8. 边界

- **不做**：连接池、OAuth 授权流、`listTools` 动态刷新、prompt / resource 能力、custom 的 server 级策略配置。
- **不改**：Codex 的 approval 语义、`toolRegistry` 的沙箱/黑名单路径（外部 MCP 本就在其外）、`resolveMcpServersForAgent` 的解析逻辑。
- **待实测**：OpenAI 兼容端对超长 function name 的实际容忍度、DeepSeek 在工具结果里对非 text block 的接受度；若实测更宽松，清洗规则可以放宽，但运行时映射保留。
