## 0. Decisions (2026-10-18)

- [x] 0.1 **方案 C**：从 `system:init` 的 `tools` 表取本次 run 实际提供的工具名，用「已知 shell 名 ∪ 表内工具 + `command` 输入」判定，而不是 `toolName === 'Bash'`。
- [x] 0.2 **保留 `mcp__*` 排除**：外部 MCP 工具在第 5 步有 `trust` 门，不能落进 shell 分支（否则会被 shell 分支 `return allow()` 吞掉）。
- [x] 0.3 **失败关闭**：已知 shell 名但输入解析不出 `command` → deny，不 allow。若字段名与假设不符，live 验证会立刻暴露，届时改规则而不是留一个静默放行。
- [x] 0.4 **不改黑名单/分类器本身**：`security.ts` 与 `bash-command-approval.ts` 的规则一条不动。本次只修「这些规则在什么条件下被调用」。

## 1. Spec（commit 1，先落）

- [x] 1.1 `openspec/specs/tools/spec.md` — 新 Requirement：shell 工具按身份而非字面量名判定，且判定失败时不得落到默认放行。
- [x] 1.2 `openspec/specs/platform-security/spec.md` — 命令黑名单与审批分类器对 Claude Code agent 在所有宿主平台上生效；平台差异只影响 shell 名，不影响闸门是否存在。
- [x] 1.3 `openspec/specs/adapters/spec.md` — `canUseTool` 桥的需求补上「shell 工具识别」这条前提。
- [x] 1.4 `openspec/changes/fix-sdk-shell-tool-gate/specs/{tools,platform-security,adapters}/spec.md` — 上述三条的 delta，按 `add-external-mcp` 的 `# <Capability> Delta` 形状。

## 2. Docs（commit 2）

- [x] 2.1 `specs/11-platform.md:130` — 改掉被证伪的断言。原文说 ClaudeCodeAdapter 的黑名单「走同一份 `getBannedPatterns`」，需写明：成立的前提是 shell 工具能被识别，且 Windows 上该工具不叫 `Bash`。
- [x] 2.2 `specs/07-tools.md:505` — 「Bash 黑名单走 `findBannedPattern`」补上同一前提；「Claude Code agent 的工具集」段落的 `Bash` 改为「shell 工具（POSIX 为 `Bash`，Windows 为 `PowerShell` 等）」。
- [x] 2.3 `specs/05-adapter-interface.md` — `canUseTool` 桥一节补一句：工具名是 SDK 提供的，不能按 POSIX 的名字硬编码。
- [x] 2.4 `CLAUDE.md §5.2` — 加一条：黑名单要真正生效，前提是 adapter 能识别 shell 工具；**不新增/调整任何规则**，故不改 `security.ts` 与 `specs/11` 的黑名单清单。
- [x] 2.5 `OVERVIEW.md` — 关键约定或待办里补记；若之前把「审批门生效」写成无条件成立，一并修正。

## 3. Implementation（commit 3）

- [x] 3.1 新增 `src/server/adapters/shell-tool.ts`：
  - `SHELL_TOOL_NAMES`（`Bash` / `PowerShell` / `pwsh` / `cmd` / `shell`，大小写无关）
  - `hasCommandString(input): boolean`
  - `isShellTool(toolName, toolInput, sdkToolNames: string[] | null): boolean`
  - 纯函数，无 import，便于单测。
- [x] 3.2 `claude-code-adapter.ts`：
  - `options` 之前声明 `let sdkToolNames: string[] | null = null`
  - `:473` 的 `m.type === 'system'` 分支里，init 时写入 `sdkToolNames = m.tools ?? []`（保留 `session_id` 逻辑）
  - `:882` 的 `if (toolName === 'Bash')` → `if (isShellTool(toolName, toolInput, sdkToolNames))`
  - `PermissionCtx` 增加 `getSdkToolNames` 或直接把闭包变量传进去（选改动面更小的那种）
  - 已知 shell 名但 `command` 解析不出 → `deny('Unrecognized shell tool input…')`
- [x] 3.3 新增 `src/server/adapters/shell-tool.test.ts` — `design.md §6` 的 9 行表，逐行断言；其中 `PowerShell` 那行是本次回归守卫。
- [x] 3.4 `pnpm typecheck`、`pnpm lint`、`pnpm test`（35 文件 / 278 通过 / 1 跳过）。

## 4. Live verification（2026-10-18）

环境：Windows 11，dev server，claude-code adapter，`claude-sonnet-4-6`（经 relay）。工作区里**没有** `.claude/settings.json`（`settingsPresent: false`）—— 隔离启动后审批门本来就不依赖它。所有「执行与否」的判据都是文件系统事实（marker 文件、`probe.sh` 是否存在），不是模型自述。

- [x] 4.1 从真实的 `system:init` 里读出工具表，确认这台 Windows 上 shell 工具的实际名字（`PowerShell`）与输入字段（`command`）。**这是方案 C 唯一还没被直接观测到的事实。**
  - 由 F1 修复后持久化的 `tool_use` 直接观测到：`toolName: "PowerShell"`，`args: { command: "Get-ChildItem -Name", description: "…" }`。方案 C 的三条前提（名字、输入字段、init 表）全部成立。
- [x] 4.2 修复后：同一条 `Remove-Item … -Force` 命令**必须**出现审批卡；拒绝后不得执行（marker 文件不存在）。
  - 第一格（同会话）：命令 `Remove-Item probe.sh -Force; node -e "…写 marker…"`，卡在 14.5s 出现，`pendingReason: "PowerShell recursive or forced removal"`（`bash-command-approval.ts:37`），拒绝返回 200。**但这一格的 marker 断言不作数**：模型被拒后把命令改写成去掉 `-Force` 的版本重试，该版本不命中分类器、因而正常执行并创建了 marker。持久化的 `tool_use` 里能清楚看到这是**第二条不同的命令**（两条 `tool_use`），被拒的第一条没有执行。
  - 补跑一格（新会话，prompt 明确「被拒后不得修改或重试」）：同一条命令，卡在 4.2s 出现，拒绝返回 200；只有 **一条** `tool_use`；`markerExecuted: false`；`probe.sh` 仍在。4.2 由此确定。
  - 观察（不是本次缺陷）：分类器是**按命令文本**匹配的，模型可以把 `-Force` 去掉来绕开一条具体规则。这正是既有的「黑名单 / 分类器是尽力而为，不是隔离」的边界，与本次修复无关，也未因本次修复变好或变坏。
- [x] 4.3 修复后：一条无害命令（如 `Get-ChildItem`）不弹卡、正常执行 —— 证明没有把所有命令都变成审批。
  - `Get-ChildItem -Name`：30s 窗口内无卡，run `complete`，输出 `probe.sh`。
- [x] 4.4 修复后：`git clean -n` / `git reset` 一类分类器规则仍会弹卡。
  - `git clean -n`：卡在 4.2s 出现，`pendingReason: "git command may discard local changes"`（`bash-command-approval.ts:24`），拒绝返回 200；模型报告被拦截，未执行任何替代命令。
- [x] 4.5 记录结果到本文件，格式同 `add-external-mcp/tasks.md §9`。

**补充（黑名单 deny 路径）**：第一轮在旧会话里跑 `Remove-Item -Recurse -Force probe.sh` 时模型凭上下文直接拒绝，`toolUses: []`，没有真正触发分支。改在新会话重跑：命令**确实被发出**（恰好一条 `tool_use`），**无卡**，`markerExecuted: false`，`probe.sh` 完好，模型回复里引用了命中的规则 `/\bRemove-Item\b[^|;]*-Recurse[^|;]*-Force/i`（即 `src/server/security.ts` 的 `WINDOWS_BANNED`）。说明 `findBannedPattern` 被到达并直接 deny，没有退化成审批卡或放行。
