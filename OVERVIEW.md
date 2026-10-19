# AgentHub 项目全貌（OVERVIEW）

> **这份文档是给 AI / 新对话窗口的「全貌速览」**：读完它,不翻代码也能掌握项目做了什么、怎么分层、代码在哪、当前进度。
>
> 与其它文档的分工：`OVERVIEW.md` 给**地图**（做了什么 / 代码在哪）· `CLAUDE.md` 定**规则**（怎么做 / 不做什么）· `specs/` 定**规格**（每个模块的字段与契约）· `skills/` 给**配方**（扩展任务步骤化指南）· `README.md` 面向**人类用户**（安装 / 快速开始）。
>
> ⚠️ 下篇「代码地图」相对稳定;「附录·当前现状」会随开发过时 —— **以代码为准**。最后更新见文末。

---

## 上篇 · 全局认知

### 1. 一句话定位 + 成熟度

> 把多 Agent 协作做成 IM 群聊体验 —— Agent 是「联系人」,对话是「工作空间」,Orchestrator 是「群里的项目经理」。

本地运行（`pnpm dev`,SQLite 文件库,不依赖托管服务）。五层架构完整落地,功能闭环已跑通,并已做到 **Electron 桌面打包** + **移动端伴随 App 脚手架**。当前重心是测试覆盖（Playwright E2E）与产物体验打磨（PPT 视觉、产物预览）。

### 2. 五层架构 + 数据流

```
L5 UI 组件（React / shadcn）            src/components/**, src/app/**
   ↑↓
L4 State + Transport                    src/stores/app-store.ts（Zustand+Immer）
   ├ Zustand normalized store           src/components/stream-provider.tsx（SSE 客户端）
   └ SSE 单连接（/api/stream）
   ↑↓
L3 Application Services                  src/server/*.ts
   ├ AgentRunner（per-run 生命周期）     src/server/agent-runner.ts ← 核心
   ├ ConversationService / 各 Service
   ├ ToolExecutor（工具执行）            src/server/tools/**
   └ EventBus（HMR-safe 单例）           src/server/event-bus.ts
   ↑↓
L2 Agent Platform Adapters              src/server/adapters/**
   ├ ClaudeCodeAdapter / CustomAgentAdapter / MockAdapter
   ↑↓
L1 Persistence                          src/db/**（Drizzle+SQLite） + workspace 文件系统
```

**数据流主线（一次 Agent 回复）**：
用户发消息 → API 路由 → `AgentRunner` 起 run → 选 `Adapter` 调 LLM → Adapter 吐 **`StreamEvent`** → AgentRunner 持久化 + 经 `EventBus` 推 SSE → 前端 `stream-provider` 收事件 → `app-store` reducer 应用 → UI 重渲染。

**核心契约（改动必读对应 spec）**：
- **`StreamEvent` 联合类型**是粘合全系统的事件协议（`specs/02`）。
- **Message = parts 数组**（text / thinking / tool_use / artifact_ref …），不是 markdown 字符串（`specs/03`）。
- **Artifact 独立于 Message**,有自己的生命周期与版本链（`specs/04`）。
- **Orchestrator 是特殊 Agent**,走同一个 AgentRunner,只是多了 `dispatch_to_agent`/`plan_tasks` 工具与不同 system prompt（`specs/06`）。

### 3. 功能现状矩阵

| 能力 | 状态 | 说明 |
|---|---|---|
| IM 会话（多会话/搜索/置顶/归档/未读） | ✅ | 单聊 + 群聊（@mention） |
| 消息操作（引用/撤回/编辑重发/重新生成/收藏☆/Pin） | ✅ | ☆ 书签跳转+辉光;Pin 注入 LLM 长期上下文(消息按钮 + 顶部横幅) |
| ClaudeCodeAdapter | ✅ | claude-agent-sdk + 全套工具 + Session 续接 |
| CustomAgentAdapter | ✅ | OpenAI 兼容（DeepSeek/OpenAI/火山方舟）+ 自驱 tool loop |
| MockAdapter | ✅ | 开发期不烧 token；E2E 假 agent（可演「真调 write_artifact 产产物」与 Orchestrator 三阶段） |
| CodexAdapter | ✅ | @openai/codex-sdk + 线程续接 + AgentHub MCP bridge |
| 自建 Agent | ✅ | 表单/对话式创建,自定义 prompt + 工具集 · emoji 头像 · JSON 配置导入 / 导出（不含密钥） |
| Orchestrator 编排 | ✅ | 三阶段规划 + DAG 调度 + 级联中止 + 可视化卡 + 同波次代码冲突检测（检测+上报，不自动合并） |
| 工具系统 | ✅ | write/deploy/read_artifact · read_attachment · fs_read/fs_write/bash · web_fetch（SSRF 防护） · plan_tasks · ask_user |
| Artifact 预览/编辑 | ✅ | web_app(iframe + preview URL + 本地静态发布/源码包/容器包) / document(md) / image / 版本对比 diff（历史 diff 只读兼容） / **ppt(幻灯片分页预览 + 固定逻辑画布缩放 + 溢出角标 + 完整 theme token + 导出真 .pptx)** · code_file workspace 预览/编辑 · 版本链 v1↔v2 · 选区改写 · 面板内编辑(CodeMirror)→提交新版本 · 导出 |
| Workspace 沙箱 | ✅ | sandbox/local 双模式 · fs_write 审批(Review/Auto) · 双平台 shell 黑名单（按工具身份识别，Windows 的 `PowerShell` 同样覆盖）· SDK 隔离启动（workspace 的项目设置 / hooks / `.mcp.json` 不参与 run） |
| 外部 MCP server | ✅ | P0/P1：设置面板登记（stdio/sse/http + 测试连接）+ Agent 勾选 · claude-code/codex 接线 · custom 自建 MCP client（per-run 连接 + loop 路由）· `ask` 审批门（Claude Code + custom）· ⚠️ **在沙箱与命令黑名单之外运行**（见「关键约定」） |
| Token 计量 | ✅ | per-run/per-message · cache 命中率 · 全局分析 Tab |
| 跨 run 对话记忆 | ✅ | 历史序列化注入 · token 预算 · 群聊跨 agent 可见 · 手动压缩 |
| 平台抽象（Win/POSIX） | ✅ | shell 选择 · 多盘符 DirPicker · 子进程清理 |
| Electron 桌面版 | ✅ | DMG / EXE 打包 · userData 路径迁移 |
| 全局 API Key 设置面板 | ✅ | app_settings 单行表 · 三层 key 优先级 |
| 移动端伴随 App | ⏳ | 响应式 Web 已适配;Capacitor 原生壳脚手架已建;手动配对（地址 + 设备 token）可用并能跨桌面重启;快照/会话/审批/提问/产物预览与导出/停止运行中任务已接通;事件流（`/api/mobile/events` + 一次性 stream token）已实现,App 以事件触发刷新并保留轮询兜底;QR/一次性配对码未实现 |
| 斜杠命令菜单 | ✅ | 输入 `/` 弹命令浮层（打开设置 / Agents 库等 UI 命令） |
| 测试覆盖 | 🟡 | Vitest 纯函数（security / workspace-utils / dispatch-plan / artifact-content / ppt-export / ppt-theme / mock-adapter 编排契约）；Playwright **E2E 基建 + 核心 IM 流 + 产物预览/导出 + 群聊编排**（mock agent，见附录） |

---

## 下篇 · 代码地图（功能 → 文件）

> 路径相对仓库根。找某功能从这里定位,不用全局搜索。

### 入口 & 前端壳
| 关注点 | 文件 |
|---|---|
| App 入口 / 布局 | `src/app/page.tsx` · `src/app/layout.tsx` |
| SSE 全局连接（客户端） | `src/components/stream-provider.tsx` |
| 前端状态总线（Zustand+Immer，reducer 在此应用 StreamEvent） | `src/stores/app-store.ts` |
| 主题 | `src/components/theme-provider.tsx` · `theme-toggle.tsx` |

### L5 UI 组件（`src/components/`）
| 区域 | 文件 |
|---|---|
| 侧栏（会话/产物库/Agents/分析 Tab） | `sidebar.tsx` |
| 聊天主面板 | `chat-panel.tsx` · `message-list.tsx` · `message-item.tsx` · `message-parts.tsx` |
| 输入框（附件/审批模式/选区引用/斜杠命令） | `message-input.tsx` · `edit-message-input.tsx` |
| Orchestrator 调度卡 | `dispatch-plan-card.tsx` |
| 产物预览 / 产物库 | `artifact-preview-panel.tsx` · `artifact-library.tsx` |
| fs_write 审批面板 + diff | `pending-writes-panel.tsx` · `pending-write-diff-tab.tsx` |
| ask_user 结构化弹窗 | `ask-user-question-dialog.tsx` |
| Token 计量 | `usage-dashboard.tsx` · `usage-badge.tsx` |
| 文件浏览器 | `file-explorer-panel.tsx` · `file-tab.tsx` · `file-library-dialog.tsx` |
| 选区改写 / 引用 | `selection-popover.tsx` · `quoted-message.tsx` |
| 导航辅助 | `pinned-messages-bar.tsx` · `conversation-outline.tsx` |
| Agent 库 / 创建 | `agent-library.tsx` · `create-agent-dialog.tsx` · `add-agent-dialog.tsx` · `agent-avatar.tsx` · `agent-info-popover.tsx` |
| 会话创建 / 目录选择 | `new-conversation-dialog.tsx` · `dir-picker-dialog.tsx` |
| 设置面板 | `settings-dialog.tsx` |
| 渲染基建 | `markdown.tsx` · `code-block.tsx` · `attachment-chip.tsx` · `ui/*`（shadcn） |

### L4→L3 API 路由（`src/app/api/`）
| 端点 | 作用 |
|---|---|
| `stream/route.ts` | **SSE 全局事件流**（一条连接） |
| `conversations/route.ts` · `conversations/[id]/**` | 会话 CRUD · 消息 · `fs/{listdir,read,write}` · `pending-writes` · `pending-questions` · `attachments` · `regenerate` |
| `messages/[id]/{edit,pin,bookmark,withdraw}` | 消息操作 |
| `agents/**` · `artifacts/**`（含 `/versions` `/export`） · `deployments/**` · `attachments/**` | 实体 CRUD / 部署包下载 |
| `deployments/[id]/[[...path]]` | 本地静态发布预览 URL |
| `runs/[id]/abort` | 中止 run（级联） |
| `usage/summary` | Token 分析聚合 |
| `platform` · `fs/listdir` | 平台信息 · 全局目录浏览 |

### L3 服务层（`src/server/`）
| 服务 | 文件 | 职责 |
|---|---|---|
| **AgentRunner** | `agent-runner.ts` | per-run 生命周期、选 adapter、`buildAdapterInput`、历史注入、token 预算、Orchestrator DAG + 冲突检测 —— **L3 核心** |
| 冲突检测 | `dispatch-file-writes.ts` | 子 run fs_write 写入追踪 + `detectWaveConflicts` 纯函数（`specs/06`） |
| 会话服务 | `conversation-service.ts` | 会话/消息持久化 |
| 跨 run 上下文 | `conversation-context.ts` | MessagePart → ChatMessage 序列化、pinned 注入（`specs/13`） |
| 上下文压缩 | `context-compaction-service.ts` | 手动压缩历史为摘要（落 `context_summaries` 表） |
| 事件总线 | `event-bus.ts` | HMR-safe globalThis 单例,推 SSE |
| 产物服务 | `artifact-service.ts` · `deployment-service.ts` · `ppt-export.ts` | 产物 CRUD + 版本链（parentArtifactId）· 本地静态发布与下载包 · slides JSON → 真 .pptx（pptxgenjs） |
| Agent / 附件 / 文件 | `agent-service.ts` · `attachment-service.ts` · `fs-service.ts` | |
| 审批中转 store | `pending-writes.ts` · `pending-questions.ts` · `pending-mcp-tools.ts` | fs_write 审批 / ask_user / 外部 MCP 工具审批的内存中转 |
| 外部 MCP server | `mcp-server-service.ts` · `mcp-approvals.ts` · `adapters/custom-mcp-{client,tools}.ts` | 登记/校验/脱敏 + 按 agent 解析（`${ENV}` 展开）· `trust='ask'` 审批门 · custom 的建连/工具表/路由（`specs/15`） |
| 设置 / Key | `settings-service.ts` | 三层 key 优先级解析 |
| 安全 / 平台 / 沙箱 | `security.ts`（黑名单 `getBannedPatterns`） · `platform.ts`（shell 选择） · `workspace-utils.ts`（路径校验/配额） | `specs/11` |
| ID 生成 | `ids.ts` | |
| 移动端 | `companion-config.ts` · `mobile-auth.ts` · `mobile-service.ts` · `mobile-cors.ts` · `network-hints.ts` | `specs/14` |

### L2 适配器（`src/server/adapters/`）
| 文件 | 说明 |
|---|---|
| `types.ts` | `AgentPlatformAdapter` 接口（事件流契约,`specs/05`） |
| `registry.ts` | adapter 注册/选择 |
| `claude-code-adapter.ts` | `query()` + `canUseTool` 桥 + SDK MCP 工具 + session 续接 |
| `custom-agent-adapter.ts` | OpenAI 协议 stream + 自驱 tool loop |
| `mock-adapter.ts` | 假事件流,开发用 |

### 工具系统（`src/server/tools/`）
`types.ts`（工具签名） · `registry.ts`（注册） · `write-artifact.ts` · `read-artifact.ts` · `read-attachment.ts` · `fs-read.ts` · `fs-write.ts` · `bash.ts` · `plan-tasks.ts`（Orchestrator DAG） · `ask-user.ts`。详见 `specs/07`。

### L1 持久化（`src/db/`）
| 文件 | 说明 |
|---|---|
| `schema.ts` | **10 张表**：`agents` · `conversations` · `messages` · `artifacts` · `workspaces` · `attachments` · `agent_runs` · `context_summaries` · `app_settings` · `mcp_servers`（`specs/08`） |
| `client.ts` | better-sqlite3 + Drizzle 实例 |
| `bootstrap.ts` | 首次启动自动建表 + seed |
| `builtin-agents.ts` · `seed.ts` | 5 个内置 Agent（Orchestrator / PM 小灰 / UI 设计师 / 前端工程师 / Reviewer） |
| `migrate-add-*.ts` | 增量迁移脚本（usage / bookmarks / workspace-mode / app-settings 等） |

DB 文件：`.agenthub-data/agenthub.db`;workspace：`.agenthub-data/workspaces/<conv_xxx>/`（sandbox 模式）。

### 共享类型（`src/shared/`）
`types.ts`（**`StreamEvent` / `MessagePart` 等跨层类型,改动牵一发动全身**） · `constants.ts` · `model-registry.ts`（模型清单） · `ppt-theme.ts`（`PptTheme` 解析 + 专业默认,预览/导出共用） · `mcp.ts`（adapter × transport 支持矩阵,前后端唯一数据源）。

### 桌面（`electron/`）& 移动（`apps/mobile/`）
- Electron：`main.ts`（主进程） · `paths.ts`（userData 路径迁移） · `server-bootstrap.ts`（拉起 Next standalone）。`specs/12`。
- 移动：`apps/mobile/`（Capacitor 伴随客户端,monorepo workspace `@agenthub/mobile`）。`specs/14`。

### 测试（`e2e/` + `*.test.ts`）
- 单元：`src/**/*.test.ts`（Vitest 纯函数：security / workspace-utils / dispatch-plan / artifact-content / ppt-export / ppt-theme / mock-adapter 编排契约）。
- E2E：`e2e/`（Playwright；`global-setup.ts` 建隔离库 + 插 4 个 mock agent：`E2E Mock` / `E2E Orchestrator` / `E2E Worker A|B`）；
  `chat.spec.ts`（核心 IM 流 + 工具卡片 F1 回归）· `conversations.spec.ts`（搜索/归档）· `artifacts.spec.ts`（产物卡片 → 预览分页 → .pptx 导出）· `dispatch.spec.ts`（群聊拆任务 → 审批 → 子任务 → 聚合）。
  配置 `playwright.config.ts`，命令 `pnpm e2e`。

---

## 附 · 当前现状（易过时,以代码为准）

### ✅ 近期完成（最新一批）
- **重新生成的同毫秒漏删（2026-10-20）**：`regenerateLatestResponse` 用严格 `>` 圈定要删的旧回复与要中止的 run，而消息 `createdAt` 与 run `startedAt` 可能和触发它的 user message 落在同一毫秒 —— 旧回复残留、仍在跑的 run 继续写新消息。改为 `>=` + 排除保留的 user message id（撤回路径原本就是这么做的）
- **附件下载的 stored XSS 修复（2026-10-20）**：`GET /api/attachments/:id` 此前按 `kind==='image'` 对 SVG 也发 `Content-Disposition: inline`，而 mimeType 是上传者自报值 —— 打开附件 URL 即可在应用同源下执行 SVG 里的脚本。现在只有 jpeg/png/gif/webp inline，其余一律 `attachment`，并加 `X-Content-Type-Options: nosniff` 与 `CSP: sandbox`
- **Electron / 移动端审计修复（2026-10-20）**：① companion 反向代理双向拆除连接（手机断开即销毁 upstream，SSE 不再残留订阅与 15s 心跳），代理监听失败（如端口占用）不再只写日志 —— 原因经 `AGENTHUB_COMPANION_PROXY_ERROR` → `/api/connection-hints` 显示在设置页；② 代理路径判定拒绝编码后的反斜杠（`%5C`）；③ Electron 用 `will-redirect` 拦截服务端 302 跳到外链（`will-navigate` 不覆盖这种情况），启动/加载失败弹系统错误框；④ 移动端事件流补 `cancel` 退订、断线后关闭、按 `desiredSize` 丢弃事件防止无界缓冲；⑤ 一次性 stream token 绑定设备 token 哈希，轮换后旧 token 作废；⑥ 移动端路由统一错误出口：已知 404 原样返回，其余回通用 500 且不把内部错误串发给局域网设备
- **第七轮审计修复（2026-10-20）**：① **全局搜索存储型 XSS** —— FTS5 snippet 与 LIKE 片段此前原样注入 `dangerouslySetInnerHTML`，消息里的 `<img onerror>` 可执行；现在服务端整体转义、只保留 `<mark>`；② 刷新 / SSE 重连后的状态恢复 —— 从 streaming 消息重建 run（中止按钮与计划修订不再消失）、重连时各面板重拉快照、消息快照可删除服务端已删的行；③ 旧快照不再覆盖流式消息的 parts；断线期间漏掉的 `message.end` / 审批结果由重连补齐；④ usage 统计改为 runs + 历史消息合并并按 runId 去重；⑤ 撤回 / 重新生成 / 删除会话同步清理部署目录；⑥ 压缩摘要 / 系统提示 / updatedAt 改为单事务，并广播系统提示；⑦ approve 写盘失败返回真实原因（不再一律 500）；⑧ 删除产物失败不再伪装成 404；⑨ 桌面端消息长度与移动端一样限制 12000；⑩ 部署结果系统消息广播；⑪ 静态发布替换失败可恢复旧目录；⑫ run 结束后清理进程级 fileWrites / evidence 表、insertRun 失败也发 `run.end`；⑬ PATCH Agent 显式 `modelId: null` 会被校验拦住；⑭ 侧栏重命名 / 目录选择 / code_file 预览 / 上传失败提示 / 会话切换错误残留同步修复
- **移动端与流式审计修复（2026-10-20）**：① companion 反向代理按解码 + POSIX 归一化后的路径判定，`/api/mobile/../settings` 及其编码形式不再能借代理读到未鉴权的桌面 API；② 移动端事件流每 15s 心跳复核期望 token，轮换 token / 关闭伴随模式会关闭长连接；③ 移动端切换 host 时清空旧 token 与全部旧 host 状态（快照、会话、产物缓存），慢响应不再串到新会话，快照/产物响应按请求序号取最新，发送失败保留草稿，操作进行中所有审批按钮统一禁用；④ Claude Code 的 SDK `result` 报错（如 `error_max_turns`）现在让 run 失败并带出 `errors`，不再静默变成正常回答；⑤ custom adapter 每个 turn 在工具执行前上报 usage，plan 阶段不再丢失用量；错误可视化消息不再发 `message.end`（由 `run.end` 落到 error/aborted），中止的 adapter 消息也由 `run.end` 收尾
- **移动端事件流（2026-10-20）**：新增 `GET /api/mobile/events`（Bearer 鉴权，SSE 格式）与 `POST /api/mobile/stream-token`（30 秒、一次性，供不能带 header 的 `EventSource` 走 query token）。移动 App 用事件流触发快照刷新（500ms 去抖），轮询保留为 WebView 不支持 fetch streaming 时的兜底
- **全局搜索支持「仅当前会话」范围（2026-10-20）**：搜索弹窗输入框右侧新增切换按钮，存在打开中的会话时出现；范围在查询时读取 `activeConversationId`（不存会话 id，切换会话不会留下过期过滤），没有打开的会话时自动退回跨会话搜索（`specs/16`）
- **适配器 / 上下文可靠性修复（2026-10-20）**：① abort 后 codex / mock / custom 不再补发 `message.end`，codex 也不再把 abort 错误规范化成失败；custom 的工具循环每轮检查 abort，`MAX_TURNS` 耗尽改为显式报错而不是静默收尾；② Claude Code 的 resume session 改按 `(conversationId, agentId)` 存（此前群聊切换 Agent 会续上别人的 SDK 会话），清理时删除该会话所有 agent 的 key；③ 上下文摘要的覆盖边界改为「同一毫秒也包含」，只排除被摘要的那条消息本身 —— 此前严格 `created_at >` 会静默丢掉同毫秒的新消息；④ vision 图片统一准入（jpeg/png/gif/webp、原图 ≤ 5 MB），OpenAI 与 Anthropic 路径共用，避免不支持的图让整轮 400；⑤ `read_artifact` 超 50k 字符截断并标记，`read_attachment` 的 PDF 解析加 abort + 60s 超时；⑥ PPT 内容里任意位置的 base64 data URI 与超长单字段都会被拒绝（此前只查字符串开头）
- **前端 / Electron 缺陷修复（2026-10-20）**：① 输入法组合态的 Enter 不再误发送 / 误选菜单 / 误跳搜索结果；② 发送失败会撤掉乐观消息并把文本、附件、提及、引用、回复目标放回输入框，同时显示错误；③ 首次消息快照与 SSE 消息并集合并（不再丢掉加载期间到达的回复），加载失败显示重试；④ pending 审批的挂载兜底不再用旧快照覆盖 SSE 已推来的条目，`ask_user` 断线时也能本地收起；⑤ 产物版本预览 / 全局搜索 / 文件树 / 附件库加请求序号或换代守卫，旧响应不再覆盖新状态；⑥ FileTab 按路径重建并把未保存草稿存 sessionStorage；⑦ Electron 外链只放行 http(s)，`file:` / `smb:` 不再交给 OS
- **编排与生命周期缺陷修复（2026-10-20）**：① 子任务 `tool.result` 的产物交接信息现在会解包 Claude Code 的 MCP content blocks 与 Codex 的 `{result,status}` 包装（此前顶层检查直接丢弃 `outputKey`，下游任务被跳过）；② 同波次子任务改用 `allSettled`，单个子任务抛错也会等同波次收尾并在 `finally` 清理 fileWrites / evidence；③ 自动创建的 `project` 产物会向最后一条输出消息补 `artifact_ref`，撤回 / 重新生成不再留下孤儿；④ 删除有 queued/running run 的会话返回 409；⑤ 未知 / 跨会话附件 id 不再被静默丢弃；⑥ 删除自建 Agent 同步移除各会话 `agentIds` 中的死引用；⑦ 删除产物同步清理对应本地部署目录；⑧ artifact 版本号读取 + 插入改为单事务；⑨ 外部静态发布先写临时目录再替换；⑩ 附件入库失败时删除已落盘文件；⑪ 前端 `run.usage` 改为累计；⑫ pending write / question 路由校验会话归属；⑬ `MAX_DISPATCH_ROUNDS` 与 spec 对齐为 2
- **沙箱与工具缺陷修复（2026-10-20）**：① workspace 路径校验补 realpath —— 此前只做词法比较,workspace 内的 symlink / junction 可直接读写外部文件;② Windows 黑名单 `del` / `rd` 支持带引号的盘符路径（`del /F /Q "C:\"` 此前可绕过）;③ `fs_write` 审批通过但写盘失败时返回真实错误,不再伪装成「用户拒绝」,并补上 review 结果的 `cwd`;④ sandbox 配额按覆盖增量计算,重写同一文件不再重复占用;⑤ 已中止的 run 不再启动新的 bash 进程;⑥ Anthropic / OpenAI 工具调用事件保持在 `message.end` 之前,工具产生的 part 不会再丢;`deploy.status` 不再以空缓冲覆盖已落库的 parts;`run.usage` 跨阶段累加;abort 时不再把消息收尾成 complete;⑦ 释放 abort / parent signal 监听,避免长会话累积
- **移动端可停止运行中的任务（2026-10-20）**：新增 `POST /api/mobile/runs/:id/abort`（复用 `abortRun`），状态页列出 `runningRuns`（Agent 名 + 开始时间）并提供「停止」；此前移动端只能看到运行中计数，无法中止
- **伴随模式远程暴露收口（2026-10-20）**：打包版此前在 companion 开启时把整个 Next server 绑到 `0.0.0.0:60646`，同一局域网任何设备都能直接 `GET /api/settings`（明文 provider key + 设备 token）、调用 `/api/conversations` 等桌面 API。现在 Next 固定 loopback + 系统端口，`0.0.0.0:60646` 改为只转发 `/api/mobile/*` 的反向代理，其余路径 404；移动端路由自身仍校验 Bearer token
- **一批 UI / 移动端缺陷修复（2026-10-20）**：删除用过的 Agent 时把外键失败显示出来（此前只 console）；切换 provider 清空旧凭据与 Base URL；claude-code / anthropic 的 Base URL 做格式校验；name / description 输入加上限；设置面板开启伴随 / 重置 token 不再冲掉未保存的 key，读取失败时禁用保存；删除会话时同步清理客户端侧的产物与预览；移动端对未适配的产物类型与 `deploy_candidates` 给出说明而不是空白；移动端拒绝纯空白消息
- **移动端鉴权改用设置表（2026-10-20）**：`/api/mobile/*` 的期望 token 此前只读 `AGENTHUB_MOBILE_TOKEN` 环境变量，而 token 实际存在 `app_settings.mobile_device_token` —— `pnpm dev` / 直接起 Next 时桌面一重启，设置面板里配好的 token 就全部 401/503。现在环境变量（dev / Electron bootstrap 注入）优先、否则读设置表，且 `companion_mode='off'` 时旧 token 不再放行；snapshot 的 `server.companionMode` 也改为读设置表（此前读一个从未写入的 `AGENTHUB_COMPANION_MODE`，永远报 `lan`）
- **Custom adapter 支持 Anthropic（2026-10-20）**：`provider='anthropic'` 时走 `@anthropic-ai/sdk` Messages API（`messages.stream`），保留同一套 AgentHub 工具循环——`tool_use` / `tool_result` block、内置与外部 MCP 工具共用执行器、thinking/text 流式 part、缓存 token 用量；历史从 OpenAI ChatMessage 转换（只保留 user/assistant 文本、合并连续同角色）。key 回退 `agent.apiKey → ANTHROPIC_API_KEY → ANTHROPIC_AUTH_TOKEN`，Base URL 可指向兼容网关。已用本机 relay 做真实两轮 tool-loop 验证（模型 `claude-sonnet-4-6`）
- **Agent 配置导入 / 导出（2026-10-20）**：v1 JSON（`format: agenthub-agent`）由 `src/shared/agent-export.ts` 严格校验（zod `strict`）；导出只含身份 / prompt / adapter / model / 工具 / vision，**永不含** `apiKey` / `apiBaseUrl` / `id` / `mcpServerIds`；导入在 Agent 库触发，校验通过后打开创建弹窗预填，用户补 key 并确认才落库，失败在列表顶部显示可读错误
- **Agent 头像选择器（2026-10-20）**：创建 / 编辑弹窗的基本信息页新增 emoji 预设（10 个）+ 自定义输入（≤ 8 字符），`PATCH /api/agents/:id` 与服务层同步支持 `avatar`（空串回落到 `🤖`）；此前只能使用 service 默认值。顺带清理 `specs/10` 中两条已过时的 TODO（删除二次确认已实现）
- **POSIX 子进程清理补 SIGKILL 升级（2026-10-20）**：`killProcessTree` / `killProcessTreeByPid` 在发出 SIGTERM 后 5 秒对同一进程组 / 已收集的 pid 补发 SIGKILL（定时器 `unref()`），覆盖忽略优雅信号的 bash 子进程与 stdio MCP server；Windows 仍由 `taskkill /F /T` 一步强制
- **内置工具 `web_fetch`（2026-10-20）**：抓取 http/https URL 的文本内容。SSRF 防护包括协议白名单、URL 内嵌凭据、`localhost` / `*.localhost`、IP 字面量与 DNS 解析结果的非公网判定（回环 / 私网 / link-local / 组播 / 保留段 / 云 metadata / IPv6 ULA 与内嵌 IPv4 形式），域名在建连时用自定义 `lookup` 复核（覆盖 DNS rebinding）；重定向手动跟随且每跳重校验；整体 20s 超时、2 MiB 上限、50,000 字符截断；非文本响应只返回元信息
- **流式可靠性两处修复（2026-10-20）**：① `persistEvent` 的 parts 缓冲缺失时改为从 DB 回读，`message.end` 之后到达的 part / tool 事件不再把已落库的 `parts` 覆盖成单元素数组（消息不存在或已完成则丢弃该事件）；② claude-code adapter 的完整消息兜底只在整轮**没有**收到 partial text 时启用，`[tool_use, text]` 顺序下不再把已流出的文本整段重发一份。同时补跑完 F2 的 5 格 live 验证：SDK init 对坏 `command` 实际报 `failed`，健康 server 无假阳性，解析失败与持久化均符合预期
- **外部 MCP 工具接入 P1**（`specs/15`）：custom adapter 自建 MCP 客户端层 —— 每个 `stream()` 并行 connect + listTools（stdio/sse/http）、工具清洗为 `mcp__*` 并合并进 OpenAI function list（内置优先、运行期 Map 路由）、`trust='ask'` 审批门复用现有队列、`mcp_server.unavailable` 上报建连失败、`finally` 关闭连接并杀 stdio 进程树。`CLAUDE.md §5.5` 的审批门适用范围已扩展为 Claude Code + custom
- **MCP 连接失败可见（F2）**：claude-code adapter 从 SDK init 消息读取 `mcp_servers` 状态，对 `failed` / `needs-auth` / `disabled` 发 `mcp_server.unavailable`；解析阶段与 spawn 阶段失败统一由 AgentRunner 写成会话内一条持久的 `role='system'` 提示（`msg_mcp_<runId>`），点名 server 与状态 —— 此前只有 `console.warn`，用户看到的是「已启用、已勾选、就是没有」。Codex 的 spawn 状态仍无 SDK 信号可读
- **F1 修复（`partIndex` 归一）**：新增 `src/server/part-slots.ts`，在 `agent-runner.ts` 的 `consumeStream` 入口把适配器的「流内序号」翻译成 `parts` 真实下标 —— 此前 `part.start` 按下标赋值、`tool.call` 按 push 追加，两套写入协议混用会让**工具调用之后到来的文本覆盖 `tool_use` 槽位**（持久化形状变 `["text","tool_result"]`，工具卡片闪现即消失、刷新也不复现）。Runner 从此是唯一索引权威（`specs/02`）；`StreamEvent` 形状不变，客户端零改动。E2E 回归见 `e2e/chat.spec.ts`
- **PPT 预览/导出一致性修复**：预览改为固定逻辑画布（768×432）+ `transform: scale()` 适配面板，版式不再随面板宽度变形、全屏是真放大；去掉预览侧 7/6/4 与导出侧 8/6/3/4 的条数硬上限（不再静默吃内容），排不下时预览显示「本页内容超出画布，导出会被截断」角标；全屏元素改为整个 deck（翻页/退出按钮随之进入全屏）
- **外部 MCP 工具接入 P0**（`specs/15`）：`mcp_servers` 表 + `agents.mcpServerIds` · 设置面板登记（stdio/sse/http + 测试连接 + 密钥脱敏）· Agent builder 勾选 · claude-code / codex 接线 · `trust='ask'` 审批门（仅 Claude Code）
- **Playwright E2E 第二批**：MockAdapter 扩成确定性假 agent（普通脚本 + **真调 write_artifact 的产物场景** + Orchestrator 三阶段 + **产物交接**），新增 `artifacts.spec.ts`（产物卡片 → 预览分页 → 真 .pptx 导出）与 `dispatch.spec.ts`（群聊拆任务 → 审批 → 子任务 → 聚合；含 `expectedOutputs`/`inputs` 交接链）
- 会话归档（service / API / sidebar，`archived` 字段早有，本批接通 UI）
- Orchestrator **同波次代码冲突检测**（fs_write 写入追踪 + 聚合阶段上报；盲区 bash / SDK adapter，`specs/06`）
- **PPT 产物**：`ppt` 类型 + 结构化 slides JSON + 真 .pptx 导出（pptxgenjs）+ 完整 theme token（预览/导出同源消费 `resolvePptTheme`）
- **Playwright E2E** 基建 + 核心 IM 流（mock agent；本机 `pnpm e2e` 跑，详见「测试」节）
- 斜杠命令菜单（`/` 浮层）

### 📋 待办
- 外部 MCP P2：Codex 的审批门（边界说明 + UI 如实标注）、OAuth 鉴权的远程 server、per-conversation 连接池
- 冲突检测盲区：bash / SDK adapter 写入（可加波次快照补全）
- Codex 写盘审批 hook（当前 Review 模式用 read-only sandbox）
- sandbox 配额对 Claude Code SDK 失效（SDK 自己写盘绕过 quota）
- 移动端伴随 App：QR/一次性配对码 + `device_sessions`（服务端只存 token hash、可吊销；涉及 schema 变更）
- Orchestrator plan 阶段的 Claude Code usage：SDK 只在 `result` 消息里给 usage，而 plan 在 `plan_tasks` 的 `tool.call` 处提前结束（拿不到 `result`），该阶段 token 仍可能不计入 `agent_runs.usage`；custom adapter 已改为按 turn 提前上报
- E2E 可观测性：本机 Playwright 浏览器版本与 `@playwright/test` 不匹配时需 `pnpm exec playwright install chromium`

### ⚠️ 关键约定（动手前必看）
- 改实体字段 → 同步 `specs/01`;改事件 → 同步 `specs/02`;改 Bash 黑名单 → 同步 `specs/11` + `src/server/security.ts`（单一数据源）;改 MCP 支持矩阵 → `src/shared/mcp.ts`。
- 所有 LLM 调用必带 `AbortSignal`;跨进程输入（API body / LLM 输出）必经 zod 校验;fs/bash 必过 Workspace 沙箱。
- ⚠️ **伴随模式不要绑 0.0.0.0 整个 server**:`electron/server-bootstrap.ts` 让 Next 只监听 loopback，对外的 companion 端口是只放行 `/api/mobile/*` 的反向代理。把 Next 直接绑到 0.0.0.0 等于把未鉴权的 `/api/settings`(明文 key)与全部桌面 API 暴露给局域网。详见 `specs/14` §5.4。
- ⚠️ **SDK adapter 以隔离模式启动**（`settingSources: []` + `strictMcpConfig: true`）：workspace 里的 `.claude/settings.json`、项目 hooks（在宿主执行命令）、`.mcp.json` 都不参与本次 run —— 这是「审批门 + Bash 黑名单」真正生效的前提，少了它一个 JSON 文件就能替 AgentHub 放行工具。代价：项目记忆只剩 `<effectiveCwd>/CLAUDE.md`（上限 50 000 字符）。详见 `CLAUDE.md §5.5`、`specs/11-platform.md`。
- ⚠️ **外部 MCP server 不在上述沙箱保证内**:它们在 workspace 沙箱与命令黑名单之外运行(stdio 直接 spawn 任意命令);stdio 子进程**继承完整进程环境**,因此能读到 AgentHub 已存的 provider API Key 与内部 token。`trust='ask'` 审批门**对 Claude Code 与 custom 生效，对 Codex 不生效**。详见 `CLAUDE.md §5.5` 与 `specs/15`。
- 完整协作规则见 `CLAUDE.md`。

---

*最后更新：2026-10-20 · 记入 Electron / 移动端审计修复（companion 代理双向拆除与监听失败可见、编码反斜杠拒绝、`will-redirect` 外链拦截、移动端事件流 cancel/退订/背压、stream token 绑定设备 token、移动端路由统一错误出口），第七轮审计修复（全局搜索存储型 XSS、刷新 / 重连后的 run 与审批状态恢复、流式快照合并、usage 合并、部署目录随产物删除、压缩事务化、approve 错误语义、消息长度上限等）与全局搜索的「仅当前会话」范围（并向待办移除已实现的 PPT 辅色语义着色 / 指标卡片化）、第六轮审计的适配器 / 上下文修复（abort 后的 `message.end` 与错误语义、custom 工具轮上限、Claude Code 会话按 agent 隔离、摘要边界的同毫秒包含性、vision 图片准入与体积上限、`read_artifact` 截断、PDF 解析超时、PPT 内嵌 base64 检测）与第五轮审计的前端 / Electron 修复（IME Enter、发送失败回滚与错误提示、消息快照与 SSE 合并、审批兜底不覆盖实时状态、请求序号守卫、FileTab 草稿保留、Electron 外链限 http(s)）与第四轮审计的编排 / 生命周期修复（交接结果解包、并行波次收尾与清理、project 产物归属、会话删除保护、附件校验、Agent 删除清理、部署清理、版本事务化、发布目录原子替换、usage 累计、审批会话归属）、移动端事件流与一次性 stream token、沙箱 realpath 校验 / Windows 引号路径黑名单 / fs_write 错误语义 / 配额增量 / bash abort / 流式事件顺序与 usage 累计等一批修复、伴随模式远程暴露收口（companion 端口只代理 `/api/mobile/*`）、一批 UI / 移动端缺陷修复、移动端鉴权改用设置表（重启后 token 不失效 + snapshot 模式来源修正）、Custom adapter 的 Anthropic Messages API 支持、Agent 配置导入 / 导出、头像选择器、POSIX 子进程 SIGKILL 升级与内置 `web_fetch`（含 SSRF 防护）。同日更早记入了流式可靠性两处修复与 F2 的 live 验证结果。2026-10-19 记入外部 MCP P1（custom 自建 MCP 客户端 + 审批门扩展到 custom）与外部 MCP 连接失败可见（F2：`mcp_server.unavailable` + 持久系统提示）。2026-10-18 记入了 shell 工具按身份识别（Windows 上 SDK 的 shell 工具是 `PowerShell`，此前按 `Bash` 字面量匹配导致黑名单与审批分类器整条失效）。2026-10-13 记入了 Claude Code adapter 的隔离启动（`settingSources: []` + `strictMcpConfig: true`）与 F1 修复（`partIndex` 归一，`src/server/part-slots.ts`）及两个相邻未修缺陷（`persistEvent` 空缓冲兜底、claude-code adapter 非流式回退重复渲染）。改动较大后请同步本文件的「功能矩阵」与「当前现状」两节。*
