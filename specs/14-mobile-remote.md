# Spec 14 -- 移动端伴随 App（Capacitor Companion）

> 目标：做一个真正安装在手机上的 AgentHub 伴随 App，用来远程观察桌面端会话状态、任务完成情况，审批文件修改，并通过对话向 Agent 提出意见。
>
> **关键决策（已定）**：移动端是 **Capacitor App**，不是手机浏览器页面 / PWA；桌面端 AgentHub 仍是唯一 host，负责 SQLite、workspace、Agent、工具执行；手机 App 只作为远程控制客户端。通信优先走 Tailscale / tailnet，也支持 LAN 直连。

涉及（预计新增 / 改动，**实现阶段才落地**）：`apps/mobile/`（Capacitor + React/Vite App）、`packages/shared/`（可选，共享类型 / API client / reducer）、`src/middleware.ts` 或 route-level auth（远程 API 鉴权）、`src/app/api/mobile/*`（移动端聚合 API）、`electron/server-bootstrap.ts`（companion mode 监听地址）、`src/server/device-sessions-service.ts`（设备会话令牌）、`device_sessions` 表（见 Spec 08 后续补充）。

---

## 1. 定位

移动端不是把当前 Next.js 应用塞进手机里跑。当前项目包含 Next API routes、SQLite、workspace 文件系统、Claude Code SDK、bash/fs 工具和 Electron embedded server，这些都不能、也不应该在手机 WebView 内运行。

正确形态：

```txt
Desktop AgentHub
- Next API / SSE
- SQLite
- workspace / tools / agents
- Electron 桌面窗口
- Companion server 对外监听（用户手动开启）

Mobile App (Capacitor)
- React/Vite UI
- 无 DB / 无 LLM SDK / 无工具执行
- 通过 Tailscale 或 LAN 连接桌面 host
- 观察状态 / 审批 / 发消息 / 回答 ask_user
```

---

## 2. 目标与非目标

### 目标

- 手机上安装一个 App（iOS / Android），不是要求用户用浏览器打开网页。
- App 能看到会话列表、当前 running run、Orchestrator plan、子任务完成 / 失败状态。
- App 能进入会话，查看消息流、产物卡片、token usage 摘要。
- App 能审批 `fs_write.pending`：看 diff，批准或拒绝。
- App 能处理 `ask_user.pending`：选择答案并提交。
- App 能发送消息、@ Agent、引用消息或任务结果提出意见。
- App 能对最新消息执行编辑重发 / 撤回 / 重新生成（行内图标按钮，仅出现在最新用户消息或最新非流式 agent 消息上；删除经 `message.removed` 广播给其它客户端）。
- 状态实时同步：桌面端和手机端订阅同一批事件，最终状态一致。
- 配对一次后长期可用，可在桌面端吊销设备。

### 非目标

- 不在手机上跑 Agent、LLM SDK、bash、fs 工具或 workspace。
- 不做云同步 / CRDT / 多主写入；桌面 SQLite 仍是唯一真相源。
- 不做公网中继服务作为默认路径；出门访问优先交给 Tailscale / WireGuard 类私有网络。
- 不把现有 Next UI 直接复用成移动 App UI；移动端需要为触控和小屏重做信息架构。
- 不做离线出站队列。桌面不可达时发送失败，用户恢复连接后手动重试。

---

## 3. 项目组织

推荐先放在同一 repo，避免类型和事件协议漂移：

```txt
apps/mobile/
  capacitor.config.ts
  package.json
  src/
    main.tsx
    api/
    stores/
    screens/
    components/
  ios/
  android/

packages/shared/        # 可选，第二阶段抽出
  stream-events.ts
  api-types.ts
  reducer.ts
```

如果短期不想改成 workspace/monorepo，可以先建 `mobile/` 目录；但最终建议把 `StreamEvent`、`MessagePart`、API DTO、部分 reducer helper 抽到共享包，桌面和移动端都从同一处 import。

---

## 4. 网络可达性

### 4.1 Companion Mode

桌面端新增「Companion Mode / 手机伴随模式」，默认关闭。

```txt
app_settings.companion_mode ∈ 'off' | 'lan' | 'tailnet'
  off     -> 只监听 127.0.0.1（默认，行为不变）
  lan     -> 监听 0.0.0.0:<port>，同 Wi-Fi 可访问
  tailnet -> 监听 0.0.0.0:<port>，推荐只通过 Tailscale IP / MagicDNS 访问
```

打开 companion mode 前必须完成配对能力和鉴权能力。禁止出现「监听 0.0.0.0 且无鉴权」。

P0 实现允许先使用「桌面端地址 + 设备 token」完成配对：

- `app_settings.mobile_device_token` 保存当前桌面端的移动端 token；
- 桌面设置页展示可连接地址与 token；
- 打包版 Electron 在 `companion_mode !== 'off'` 且 token 存在时，对 `0.0.0.0:60646` 起一个**只转发 `/api/mobile/*`** 的反向代理；Next 本体始终只监听 `127.0.0.1`（见 §5.4 的实现约束）；
- 手机 App 手动填写地址与 token；扫码配对后续复用同一 payload。

**鉴权来源（2026-10-20）**：`/api/mobile/*` 的期望 token 优先取环境变量（dev 注入 / Electron bootstrap），否则取 `app_settings.companion_mode + mobile_device_token`。设置表是持久来源 —— 进程重启后旧 token 仍有效；`companion_mode = 'off'` 时 DB token 不再放行（环境变量覆盖仅用于 dev）。`GET /api/mobile/snapshot` 的 `server.companionMode` 同样来自设置表，不再读单独的 `AGENTHUB_COMPANION_MODE` 环境变量。Token 由 `newMobileDeviceToken()` 生成（24 字节随机，base64url）；`PATCH /api/settings` 拒绝短于 16 字符的 `mobileDeviceToken`，避免手填出可猜的弱 token。比较使用 `timingSafeEqual`。

### 4.2 Tailscale / Tailnet

Tailscale 不作为 AgentHub 的 npm 依赖，也不嵌入代码。它是用户在手机和电脑上安装的网络层软件：

```txt
手机 Tailscale App + 桌面 Tailscale
       -> 同一个 tailnet
       -> 桌面有固定 100.x.y.z IP / MagicDNS 名称
       -> AgentHub mobile app 访问 http(s)://<desktop-tailnet-name>:<port>
```

AgentHub 只需要：

- companion mode 监听非 loopback 地址；
- 设置页展示当前可连接地址；
- 配对 QR / 手输地址包含 tailnet URL；
- 文档说明推荐 Tailscale 作为跨网访问方式。

可选增强：如果用户配置了 Tailscale HTTPS / `tailscale serve`，移动 App 使用 HTTPS；否则 tailnet 内 HTTP 也可作为 P0，因为链路本身由 WireGuard 加密。

**连接说明（2026-10-20）**：`README.md`「Connecting from a phone」一节面向用户写清了配对流程（设置页地址 → 生成配对码 → App 内配对 → 设备可吊销）、打包版 companion 端口默认 `60646` 且只转发 `/api/mobile/*`、配对码只在内存里（重启桌面即失效），以及「优先 Tailscale、LAN 仅限可信网络」的取舍。App 的地址输入接受 `http://` 与 `https://` 两种 scheme，因此配置了 Tailscale HTTPS / `tailscale serve` 的用户直接填 HTTPS 地址即可，无需改代码。

### 4.3 LAN fallback

LAN 模式用于同 Wi-Fi 快速验证：

```txt
http://<desktop-lan-ip>:<port>
```

风险：明文 HTTP，适合可信局域网，不适合公共 Wi-Fi。产品文案必须提示用户优先使用 Tailscale。

---

## 5. 配对与鉴权

### 5.1 为什么不用浏览器 cookie 作为主方案

手机 App 是 Capacitor 本地壳，页面 origin 通常是 `capacitor://localhost`，不是桌面 Next server 的同源页面。原先 PWA/浏览器方案里的 httpOnly cookie + EventSource 自动带 cookie 不再是最稳妥的主路径。

移动 App 主方案改为：

- REST API：`Authorization: Bearer <deviceToken>`
- 事件流：优先 fetch streaming 带 Authorization header；如 WebView 对 streaming 支持不稳定，再加短期 stream token fallback
- token 存在 App 本地安全存储中；P0 可用 Capacitor Preferences，若引入 secure storage 插件需按 CLAUDE.md 先讨论新依赖

### 5.2 设备会话

新增 `device_sessions` 表，服务端只存 token hash，不存明文 token。

建议字段：

```ts
device_sessions {
  id              text PK       // dev_<nanoid>
  device_name     text NOT NULL // "Liz's iPhone"
  token_hash      text NOT NULL
  created_at      int NOT NULL
  last_seen_at    int
  revoked_at      int
}
```

**实现状态（2026-10-20）**：表已落地（`src/db/schema.ts` / `bootstrap.ts`，`token_hash` 唯一索引），服务在 `src/server/device-sessions.ts`：一设备一 token，DB 只存 sha256；`last_seen_at` 按分钟节流更新；吊销幂等。鉴权同时接受旧的全局 token（`app_settings.mobile_device_token` / env）与未吊销的设备会话，关闭伴随模式后两者都失效。设备名去控制字符并限 64 字符。

### 5.3 配对流程

P0 同时支持 QR 和手输，QR 是主路径，手输是兜底。

```txt
桌面设置页
  1. 用户打开 Companion Mode
  2. 点击「配对新设备」
  3. 生成一次性 pairing code + desktop base URL
  4. 显示 QR：
     agenthub://pair?baseUrl=http://host:port&code=123456

手机 App
  1. 扫 QR 或手输 base URL + code
  2. POST /api/mobile/pair { code, deviceName }
  3. 桌面校验 code
  4. 返回 deviceToken
  5. App 存 token，后续请求带 Authorization
```

配对码要求：

- 5 分钟 TTL；
- 一次性使用；
- 错误次数限速；
- 只暂存内存，不落库。

**实现状态（2026-10-20）**：配对码（6 位数字，`src/server/pairing-codes.ts`）与 `POST /api/mobile/pair` 已实现；桌面设置页「移动端连接」可生成配对码、查看已配对设备并吊销（`POST /api/settings/pairing-code`、`GET/DELETE /api/settings/devices`，写接口带同源校验）。限流为「单码错 5 次作废 + 每分钟最多 20 次失败」；全局失败预算**只拦错误码**，正确码始终可以兑换（否则未鉴权的失败洪泛能把合法用户锁在门外）。未鉴权的 pair 接口先按 `Content-Length` 拒绝 >4 KB 的请求体，避免在限流前把超大 JSON 读进内存。`companion_mode = 'off'` 时拒绝配对。**尚未实现**：QR 图片渲染与手机端扫码 —— 需要摄像头 / 扫码依赖（按 §6.2 先讨论），当前以手输地址 + 配对码为主路径。

### 5.4 API 鉴权边界

所有 `/api/mobile/*` 必须鉴权，除 `/api/mobile/pair`。
现有桌面 Web API 可以保持 loopback 无鉴权，但 companion mode 打开后，远程访问路径必须走 mobile API 或 middleware 保护后的 API。不要让局域网设备直接调用未鉴权的 `/api/conversations`、`/api/agents`、`/api/settings`。

**实现约束（2026-10-20）**：打包版不要把整个 Next server 绑到 `0.0.0.0` —— 那等于把 `/api/settings`（含明文 provider key 与设备 token）、`/api/conversations` 等全部桌面 API 暴露给同一局域网。`electron/server-bootstrap.ts` 的做法是：Next 固定 `HOSTNAME=127.0.0.1` + 系统分配端口；companion 开启时另起 `0.0.0.0:<companionPort>` 的 HTTP 反向代理，仅放行路径前缀 `/api/mobile/`（含 CORS 预检），其余一律 404。移动端每条路由仍自行校验 Bearer token。

路径判定必须**归一化后**再比较：`/api/mobile/../settings` 原始前缀命中，但 Next 会把它解析成 `/api/settings`。`electron/companion-proxy.ts` 先做百分号解码、再按 POSIX 规则归一化，归一化结果必须与解码结果完全一致且仍以 `/api/mobile/` 开头；`..`、`.`、重复斜杠、反斜杠（含编码后的 `%5C`）与非法转义一律拒绝。

代理监听失败（典型是 `EADDRINUSE`）不能只写日志：此时手机侧完全连不上，而设置页仍会展示 LAN 地址。`electron/server-bootstrap.ts` 等待 `listen` 结果，失败时把原因写入 `AGENTHUB_COMPANION_PROXY_ERROR`；`GET /api/connection-hints` 原样带出 `companionProxyError`，设置页在「移动端连接」里显示错误横幅。代理自身的连接拆除也必须双向：手机断开后销毁 upstream 请求，否则 SSE 的订阅与心跳会一直泄漏。

移动端 API 不得返回：

- `agents.apiKey`
- `app_settings.*ApiKey`
- `app_settings.anthropicBaseUrl` 中可能含凭据的部分
- 不必要的绝对敏感路径

---

## 6. 移动端 API

移动 App 不应拼很多桌面 API 来恢复状态。需要移动端聚合 API，保证首次打开能拿到完整 snapshot，然后再接事件流。

### 6.1 Snapshot

```txt
GET /api/mobile/snapshot
Authorization: Bearer <deviceToken>
```

返回：

- conversations summary
- agents safe fields
- active/running runs
- pendingWrites
- pendingQuestions
- unread-ish counters（服务端可选）

```ts
interface MobileSnapshot {
  conversations: MobileConversationSummary[]
  agents: MobileAgent[]
  runningRuns: MobileRun[]
  pendingWrites: PendingWrite[]
  pendingQuestions: PendingQuestion[]
  server: {
    version: string
    companionMode: 'lan' | 'tailnet'
  }
}
```

### 6.2 会话详情

```txt
GET /api/mobile/conversations/:id
```

返回：

- conversation
- messages
- runs
- artifacts summary
- dispatch state 可重建数据
- pinned/bookmarked ids

### 6.3 事件流

优先方案：

```txt
GET /api/mobile/events
Authorization: Bearer <deviceToken>
```

客户端用 `fetch()` 读取 `ReadableStream`，服务端仍编码为 SSE 格式或 NDJSON。这样可以带 Authorization header。

fallback 方案：

```txt
POST /api/mobile/stream-token
Authorization: Bearer <deviceToken>

GET /api/mobile/events?streamToken=<short-lived-token>
```

`streamToken` 30 秒内有效、一次性，用于 WebView 不支持 fetch streaming 而必须使用 `EventSource` 的平台。token 在签发时绑定当时的设备 token 哈希（内存表里不存设备 token 明文）：消费时要求当前设备 token 与签发时一致，轮换后旧流 token 立即作废；消费失败同样删除，避免反复试错。

**实现状态（2026-10-20）**：`GET /api/mobile/events`（Bearer）与 `POST /api/mobile/stream-token`（30 秒一次性 token，`GET /api/mobile/events?streamToken=...`）已实现。移动端 App 用事件流触发快照刷新（500ms 去抖），同时保留 2–3s 轮询作为 WebView 不支持 fetch streaming 时的兜底。一次性流 token 绑定的是**请求它时实际使用的凭据**（全局 token 或某台配对设备 token）的哈希，心跳按哈希复核：全局 token 轮换、设备被吊销或关闭 companion mode 都会主动关闭已建立的连接。

**事件负载最小化**：手机侧只需要「有事发生」的信号。事件流只转发 `{ type, conversationId, timestamp }`，不转发原始事件里的 host 绝对路径、文件内容、工具参数与结果（`fs_write.pending.absolutePath`、`tool.call.args` 等）。原始事件只走本机 SSE；手机要详情时走已脱敏的 snapshot / detail 接口。

**错误面收敛**：`/api/mobile/*` 的错误响应不得把内部字符串（宿主绝对路径、SQLite 错误、errno）回给局域网设备。`src/server/mobile-errors.ts` 是统一出口：`mobileErrorJson` 只放行 `MobileNotFoundError`，其余记日志后返回 `Internal error` + 500；`mobileUserErrorJson` 额外放行会话服务里用户可理解、可操作的输入错误（撤回非最新消息、内容为空 / 超长、附件不存在等）。写盘审批失败在桌面端仍返回真实原因（便于排查），移动端只回通用文案。ask_user 答案同样有上限（≤4 题、每题 ≤8 个选项、备注 ≤4000 字），且 key / label 必须存在于原问题，否则 400。

**桌面写接口的 CSRF 门**：桌面 API 虽只监听 loopback，浏览器仍可从任意网页发起跨站简单请求（例如无 body 的 `POST /api/settings/mobile-token` 会重置设备凭据）。**所有**桌面写接口（`src/app/api/**` 下除 `/api/mobile/*`、`/api/internal/*` 以外的 POST / PUT / PATCH / DELETE）统一经 `rejectCrossOriginWrite`：`Origin` 与请求 origin 不一致、或 `Sec-Fetch-Site` 为 `cross-site` / `same-site` 时返回 403；无这些头的非浏览器调用不受影响。`/api/mobile/*` 已由 Bearer 鉴权保护，跨站页面无法带上该头，因此不重复加这道门。

事件流的生命周期必须完整：客户端断开（含反向代理一侧销毁）时通过 `ReadableStream.cancel` 退订 eventBus、停心跳并移除 abort 监听；鉴权是异步的，订阅建立后要再检查一次 `req.signal.aborted`。手机读得慢时按 `controller.desiredSize` 丢弃事件，不让服务端无界缓冲 —— 丢失的增量由重连后的快照补齐。并发也要有上限：每条流都常驻订阅全局 eventBus，因此 `/api/mobile/events` 按「凭据哈希 ≤2 条、全宿主 ≤8 条」限流（`src/server/mobile-stream-slots.ts`），超额返回 429；超出部分由手机端单流 + 轮询兜底，不需要多路并行。

### 6.4 操作 API

移动端第一版需要：

```txt
POST /api/mobile/conversations/:id/messages
POST /api/mobile/runs/:id/abort
POST /api/mobile/pending-writes/:id/approve
POST /api/mobile/pending-writes/:id/reject
POST /api/mobile/pending-questions/:id/answer
GET  /api/mobile/artifacts/:id        # 返回移动端安全裁剪后的 artifact content，用于 App 内预览
GET  /api/mobile/artifacts/:id/export
```

这些 API 可以复用现有 service，但 response DTO 要做移动端安全裁剪。

**实现状态（2026-10-20）**：`GET /api/mobile/snapshot`、会话详情 / 消息发送 / 撤回 / 编辑 / 重新生成、`POST /api/mobile/pending-writes|pending-questions/:id`、`GET /api/mobile/artifacts/:id`、`GET /api/mobile/artifacts/:id/export`、`POST /api/mobile/runs/:id/abort`、事件流（§6.3）均已实现（abort 在移动端状态页对运行中的 run 提供「停止」；导出与桌面共用 `src/server/artifact-export.ts`）。

---

## 7. 移动 App UX

移动端不是桌面三栏布局的缩小版。P0 信息架构：

```txt
Tab 1: 状态
  - 正在运行的会话 / run
  - Orchestrator 任务计划和完成情况
  - 待审批 / 待回答数量

Tab 2: 会话
  - 会话列表
  - 会话消息流
  - 输入框、@ Agent、引用回复

Tab 3: 审批
  - fs_write.pending 列表
  - diff 预览
  - 批准 / 拒绝

Tab 4: 设置
  - 连接状态
  - 当前 desktop host
  - 重新配对 / 退出登录
```

触控原则：

- 不依赖 hover。消息操作用长按菜单或显式更多按钮。
- 连续的 `tool_use` / `tool_result` 在消息流里默认合并为一个紧凑工具活动块；多次工具调用默认折叠，只显示数量、工具分布和完成 / 失败 / 进行中状态，点开再看单项状态。
- 进入会话详情时自动滚动到最新消息；后续新消息到达时，如果用户仍在底部附近则继续跟随底部，用户主动上滑阅读历史时不强制拉回。
- 审批按钮必须大且明确，拒绝和批准视觉区分。
- Auto 写入模式只能查看，不建议移动端切换；如要切换必须二次确认。
- artifact_ref 在消息里渲染为可点击产物卡片，点开后用底部 sheet 预览；web_app 默认用 `sandbox="allow-scripts"` iframe，源码视图只读；document 用 Markdown 只读渲染；image 等比预览。
- `deploy_status` message part 在 mobile DTO 中降级为 inline chip，显示 ready/failed、标题、artifact 版本或 workspace 路径、失败原因；移动端不执行桌面工具，只展示桌面端生成的 previewPath。
- 长文本和 diff 要支持横向滚动、行号、复制。

---

## 8. Workspace 与副作用语义

所有副作用仍在桌面执行：

- `fs_read` / `fs_write` 读写桌面 workspace；
- `bash` 在桌面 workspace cwd 内执行；
- Claude Code SDK 在桌面机器运行；
- 产物存桌面 SQLite 或 workspace。

手机 App 只是发起请求和审批。移动端批准 `fs_write.pending` 等价于桌面用户批准，必须保留现有沙箱、黑名单、review/auto 策略。

---

## 9. 离线策略

不做离线队列。

桌面不可达时：

- 顶部显示 disconnected；
- 禁止发送或发送后明确失败；
- pending write / pending question 不允许离线提交；
- 不缓存旧状态当成可操作状态。

原因：AgentHub 是 local-first 桌面 host，移动 App 没有完整 DB 和 workspace。离线队列会引出顺序、去重、撤回、审批过期等复杂问题，当前阶段不做。

### 9.1 请求与状态一致性（2026-10-20）

移动端在弱网、切后台、桌面端休眠的情况下必须保持「看到的即真实」，实现约束：

- **请求超时**：普通 API 请求 15 秒超时（`AbortSignal.timeout`，与调用方 signal 合并）；事件流不设超时（它本就长期挂着，断线由重连处理）。
- **轮询单飞**：快照轮询上一次未返回时不再叠加新请求；详情轮询同理。避免弱网下请求堆积、响应乱序。
- **序号守卫**：快照 / 会话详情 / 产物预览都按请求序号只接受最后一次响应；慢响应返回时若用户已返回列表或切到别的会话，直接丢弃。
- **失败语义**：发送 / 撤回 / 编辑 / 重新生成一旦写成功，后续刷新失败只提示，不把操作结果改写成失败（否则用户会重试并重复发送）。操作后的详情刷新是可选的，失败由 2 秒轮询与事件流补上。
- **连接状态**：任意一次请求失败都会把状态页从「已连接」拉回未连接（`lastSuccessfulConnection` 清空），不能在连不上时继续显示在线。
- **产物缓存**：预览按 30 秒 TTL 缓存，命中刷新时间戳；最多 5 条，按最近使用淘汰。过期后重新拉取，避免长期显示桌面端已改过的旧版本。
- **设备 token**：保存 / 请求前 trim —— 设置页允许粘贴带空白的 token，多余空白会让 Bearer 头失效。
- **审批 diff**：`computeLineDiff` 只在每张审批卡片内按内容 memo 化（快照每 3 秒刷新不能重算 LCS）；LCS 上限 600 行，超长文件退回截断的「全删 + 全增」（每侧 400 行）并标注省略行数，避免在 WebView 主线程分配 O(m·n) 矩阵或渲染整份文件。
- **Android 备份**：`android:allowBackup="false"`。设备 token 存在 WebView localStorage，`allowBackup` 会把整个 `app_webview` 复制进系统云备份。

---

## 10. 安全

| 风险 | 处理 |
|---|---|
| companion mode 暴露桌面 API | 默认 off；打开时必须启用设备 token 鉴权 |
| token 泄漏 | 服务端只存 hash；桌面设置页可吊销设备 |
| 移动端查看明文 API key | mobile DTO 永不返回 key/settings 明文 |
| 远程触发危险命令 | 现有 bash 黑名单 + workspace 沙箱 + fs_write 审批不放松 |
| 公共网络明文 HTTP | 推荐 Tailscale；LAN 模式文案提示仅可信网络使用 |
| 丢手机 | 桌面端设备列表吊销 token |

---

## 11. 与现有架构的关系

- `StreamEvent` 仍是桌面到移动的实时协议。
- 用户消息（任意客户端发出）通过 `message.added` 广播，实现跨客户端实时同步（如桌面端看到手机端发的消息）；详见 Spec 02。
- 移动端可以复用 `applyEvent` 的核心 reducer，但不要强行复用桌面 UI 组件。
- `AgentRunner`、Adapter、ToolRegistry 不为移动端分叉。
- `/api/mobile/*` 是安全裁剪层，不替代现有桌面 API。
- Electron packaged server 仍服务桌面窗口；companion mode 只是额外开放远程客户端入口。

---

## 12. 分期

| 阶段 | 内容 | 产出 |
|---|---|---|
| P0 | Capacitor App 骨架；桌面 companion mode；Tailscale/LAN base URL 配对；device token；snapshot + events；会话查看；发送消息；审批 fs_write；回答 ask_user | 手机安装 App 后能连接桌面 AgentHub，观察状态并完成关键审批/反馈 |
| P1 | Orchestrator 状态页增强；artifact 预览/版本/导出体验优化；QR 配对体验；iOS/Android 打包脚本；Tailnet HTTPS 文档（2026-10-20：已写入 `README.md`「Connecting from a phone」） | 接近日常可用 |
| P2 | 推送通知、本机通知 badge、更多文件浏览能力、Capacitor secure storage 插件 | 增强体验，按需求讨论 |

---

## 13. 决策记录

| # | 问题 | 决定 |
|---|---|---|
| 1 | 移动端形态 | **Capacitor 手机 App**，不是手机浏览器页面 / PWA |
| 2 | 服务端位置 | 桌面 AgentHub 是唯一 host；手机不跑 Next/SQLite/LLM/tools |
| 3 | 网络 | 优先 Tailscale/tailnet；LAN 作为本地 fallback；不默认做公网中继 |
| 4 | 鉴权 | 设备配对 + Bearer token；服务端存 token hash；可吊销 |
| 5 | 事件流 | 优先 fetch streaming 带 Authorization；必要时短期 stream token + EventSource fallback |
| 6 | 离线 | 不做出站队列；不可达时显式失败 |

**实现起步（P0）**：新增 `apps/mobile` Capacitor App → 桌面端 `device_sessions` + pairing service → `/api/mobile/pair` / `/api/mobile/snapshot` / `/api/mobile/events` → Electron companion mode 监听地址门控 → 移动端状态页 / 会话页 / 审批页。
