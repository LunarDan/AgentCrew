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
| 自建 Agent | ✅ | 表单/对话式创建,自定义 prompt + 工具集 |
| Orchestrator 编排 | ✅ | 三阶段规划 + DAG 调度 + 级联中止 + 可视化卡 + 同波次代码冲突检测（检测+上报，不自动合并） |
| 工具系统 | ✅ | write/deploy/read_artifact · read_attachment · fs_read/fs_write/bash · plan_tasks · ask_user |
| Artifact 预览/编辑 | ✅ | web_app(iframe + preview URL + 本地静态发布/源码包/容器包) / document(md) / image / 版本对比 diff（历史 diff 只读兼容） / **ppt(幻灯片分页预览 + 固定逻辑画布缩放 + 溢出角标 + 完整 theme token + 导出真 .pptx)** · code_file workspace 预览/编辑 · 版本链 v1↔v2 · 选区改写 · 面板内编辑(CodeMirror)→提交新版本 · 导出 |
| Workspace 沙箱 | ✅ | sandbox/local 双模式 · fs_write 审批(Review/Auto) · 双平台 shell 黑名单（按工具身份识别，Windows 的 `PowerShell` 同样覆盖）· SDK 隔离启动（workspace 的项目设置 / hooks / `.mcp.json` 不参与 run） |
| 外部 MCP server | ✅ | P0：设置面板登记（stdio/sse/http + 测试连接）+ Agent 勾选 · claude-code/codex 接线 · `ask` 审批门（仅 Claude Code）· ⚠️ **在沙箱与命令黑名单之外运行**（见「关键约定」） |
| Token 计量 | ✅ | per-run/per-message · cache 命中率 · 全局分析 Tab |
| 跨 run 对话记忆 | ✅ | 历史序列化注入 · token 预算 · 群聊跨 agent 可见 · 手动压缩 |
| 平台抽象（Win/POSIX） | ✅ | shell 选择 · 多盘符 DirPicker · 子进程清理 |
| Electron 桌面版 | ✅ | DMG / EXE 打包 · userData 路径迁移 |
| 全局 API Key 设置面板 | ✅ | app_settings 单行表 · 三层 key 优先级 |
| 移动端伴随 App | ⏳ | 响应式 Web 已适配;Capacitor 原生壳脚手架已建,配对通信待打通 |
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
| 外部 MCP server | `mcp-server-service.ts` · `mcp-approvals.ts` | 登记/校验/脱敏 + 按 agent 解析（`${ENV}` 展开）· `trust='ask'` 审批门（`specs/15`） |
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
- 外部 MCP P1：custom adapter 的 MCP 客户端层（连接 / listTools / loop 路由 / 清理）
- 外部 MCP P2：Codex 的审批门、OAuth 鉴权的远程 server、per-conversation 连接池
- PPT 深化：辅色语义着色（正面↑ / 警示↓）+ 数据页卡片化
- 冲突检测盲区：bash / SDK adapter 写入（可加波次快照补全）
- Codex 写盘审批 hook（当前 Review 模式用 read-only sandbox）
- sandbox 配额对 Claude Code SDK 失效（SDK 自己写盘绕过 quota）
- 移动端伴随 App 配对通信打通
- E2E 可观测性：本机 Playwright 浏览器版本与 `@playwright/test` 不匹配时需 `pnpm exec playwright install chromium`
- `persistEvent` 空缓冲兜底（F1 修复时记录，未改）：`partsBuffer` 没有该 message 时回退 `?? []`，于是 `message.end` 之后到达的 part / tool 事件会把已存 `parts` 覆盖成单元素数组。当前不可达，预防性记录
- claude-code adapter 非流式回退重复渲染（F1 修复时记录，未改）：流里已写出的文本被 `claude-code-adapter.ts:515-523` 的回退再发一份全文 part，同一段文字渲染两次

### ⚠️ 关键约定（动手前必看）
- 改实体字段 → 同步 `specs/01`;改事件 → 同步 `specs/02`;改 Bash 黑名单 → 同步 `specs/11` + `src/server/security.ts`（单一数据源）;改 MCP 支持矩阵 → `src/shared/mcp.ts`。
- 所有 LLM 调用必带 `AbortSignal`;跨进程输入（API body / LLM 输出）必经 zod 校验;fs/bash 必过 Workspace 沙箱。
- ⚠️ **SDK adapter 以隔离模式启动**（`settingSources: []` + `strictMcpConfig: true`）：workspace 里的 `.claude/settings.json`、项目 hooks（在宿主执行命令）、`.mcp.json` 都不参与本次 run —— 这是「审批门 + Bash 黑名单」真正生效的前提，少了它一个 JSON 文件就能替 AgentHub 放行工具。代价：项目记忆只剩 `<effectiveCwd>/CLAUDE.md`（上限 50 000 字符）。详见 `CLAUDE.md §5.5`、`specs/11-platform.md`。
- ⚠️ **外部 MCP server 不在上述沙箱保证内**:它们在 workspace 沙箱与命令黑名单之外运行(stdio 直接 spawn 任意命令);stdio 子进程**继承完整进程环境**,因此能读到 AgentHub 已存的 provider API Key 与内部 token。`trust='ask'` 审批门**只对 Claude Code 生效**。详见 `CLAUDE.md §5.5` 与 `specs/15`。
- 完整协作规则见 `CLAUDE.md`。

---

*最后更新：2026-10-18 · 记录 shell 工具按身份识别（Windows 上 SDK 的 shell 工具是 `PowerShell`，此前按 `Bash` 字面量匹配导致黑名单与审批分类器整条失效）。2026-10-13 记入了 Claude Code adapter 的隔离启动（`settingSources: []` + `strictMcpConfig: true`）与 F1 修复（`partIndex` 归一，`src/server/part-slots.ts`）及两个相邻未修缺陷（`persistEvent` 空缓冲兜底、claude-code adapter 非流式回退重复渲染）。改动较大后请同步本文件的「功能矩阵」与「当前现状」两节。*
