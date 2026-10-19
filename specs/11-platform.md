# Spec 11 — 平台抽象（Platform）

> AgentHub 在本地运行，宿主可能是 macOS / Linux / Windows。本 spec 定义跨平台差异的处理契约：shell 选择、命令黑名单、路径校验、子进程清理。

源文件：`src/server/platform.ts`（platform 检测与常量），`src/server/security.ts`（双平台黑名单），`src/server/tools/bash.ts`（shell 执行）。

---

## Platform 枚举

```typescript
export type Platform = 'posix' | 'windows'

export function currentPlatform(): Platform {
  return process.platform === 'win32' ? 'windows' : 'posix'
}
```

**为什么不区分 darwin / linux**：bash 工具行为、黑名单语法、路径风格在 macOS 与 Linux 之间一致；区分到 POSIX vs Windows 两类即可。后续若出现 darwin 专属需求（如 Keychain 路径）再细化。

---

## Shell 选择

| Platform | 命令 | 参数 | 说明 |
|---|---|---|---|
| `posix` | 用户 login shell（`zsh` / `bash`）优先，回退 `sh` | `['-l', '-i', '-c', command]` 或 `['-c', command]` | macOS / Linux 默认优先继承用户 shell 初始化出的 PATH |
| `windows` | `powershell.exe` | `['-NoProfile', '-NonInteractive', '-Command', '<chcp> ; <command>']` | 用系统自带 PS 5.1（不依赖 pwsh 7） |

**POSIX 细节**：
- 优先从 `process.env.SHELL` 解析用户 shell；缺失时回退 `os.userInfo().shell`
- 仅当解析到的绝对路径存在且 shell basename 是 `zsh` 或 `bash` 时，使用 `-l -i -c <command>`。这样桌面版从 Finder / Dock 启动时，也能加载用户 `.zprofile` / `.zshrc` / `.bash_profile` / `.bashrc` 中配置的 Node、pnpm、Homebrew、nvm 等 PATH
- 其它 shell 或无法解析用户 shell 时回退 `sh -c <command>`，保持 POSIX 命令语法稳定
- 仍然直接 `spawn(shell.cmd, shell.args)`，不使用 `shell: true`

**Windows 细节**：
- 子进程启动选项加 `windowsHide: true`，避免闪现控制台
- 命令前 prepend `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ` 强制 stdout / stderr 为 UTF-8（Windows 默认 codepage 936 / cp1252 会导致中文乱码 / LLM 上下文污染）。**不**用 `chcp 65001`——chcp 在 PowerShell 初始化输出流之后才生效，命令本身的错误信息仍是 GBK
- 用系统自带 PS 5.1（不依赖 pwsh 7）

**Why PowerShell 不用 `cmd.exe`**：cmd 语法贫瘠（无管道、变量插值能力差），LLM 生成质量低；PowerShell 5.1 在所有 Win10+ 系统预装，无需用户额外配置。

**禁止**：
- 不要在 PowerShell 命令里嵌套 `bash -c`（即便检测到 Git Bash 存在）；Phase 1 保持单 shell 策略
- 不要给 spawn 传 `shell: true`（会让黑名单更难匹配，且引入 shell 注入风险）

---

## 命令黑名单（双平台）

`src/server/security.ts` 导出 `getBannedPatterns(platform): RegExp[]`：

### POSIX 黑名单

```typescript
const POSIX_BANNED: RegExp[] = [
  /\brm\s+-rf\s+\//,             // rm -rf /
  /\bsudo\b/,                     // 提权
  /\bchmod\s+\d{3,4}\s+\//,      // chmod 777 /
  /:\(\)\{\s*:\|:&\s*\}/,        // fork bomb
  /curl\s+[^|]*\|\s*(bash|sh)/,  // curl | sh
  /wget\s+[^|]*\|\s*(bash|sh)/,  // wget | sh
  /\beval\b/,
  /\bexec\b\s+/,
]
```

### Windows 黑名单

```typescript
// PowerShell 接受无歧义参数前缀：-r / -Rec / -Fo 与 -Recurse / -Force 等价
const PS_RECURSIVE = '-(?:r|rec(?:urse)?)\\b'
const PS_FORCE = '-fo(?:rce)?\\b'
const PS_DELETE_VERB = '(?:remove-item|ri|rm|rmdir|del|erase|rd)'

const WINDOWS_BANNED: RegExp[] = [
  // 删根 / 删盘（cmd 与 PowerShell 的别名都算）
  /\b(del|erase)\s+\/[fsq\s/"']*[a-z]:[\\/]?/i,   // del /F /Q C:\  （路径带引号也算）
  /\b(rd|rmdir)\s+\/[sq\s/"']*[a-z]:[\\/]?/i,     // rd / rmdir /S /Q "C:\"
  // Remove-Item 及其别名，两个参数任意顺序；缩写与全称同样命中
  new RegExp(`\\b${PS_DELETE_VERB}\\b[^|;]*${PS_RECURSIVE}[^|;]*${PS_FORCE}`, 'i'),
  new RegExp(`\\b${PS_DELETE_VERB}\\b[^|;]*${PS_FORCE}[^|;]*${PS_RECURSIVE}`, 'i'),
  // 格式化 / 关机
  /\bformat\s+[a-z]:/i,
  /\bshutdown\b/i,
  /\brestart-computer\b/i,
  /\bstop-computer\b/i,
  // 注册表破坏
  /\breg\s+delete\b/i,
  /\bRemove-ItemProperty\b/i,
  // 进程暴力清理
  /\btaskkill\b[^|;]*\/im\s*\*/i,                   // taskkill /IM *
  /\bStop-Process\b[^|;]*-Force[^|;]*\*/i,
  // 远程下载 + 执行
  /Invoke-Expression\s*\(\s*(Invoke-WebRequest|iwr|curl|wget)/i,
  /\biex\b\s*\(\s*(iwr|curl|wget|Invoke-WebRequest)/i,
  // 策略放宽
  /Set-ExecutionPolicy\s+(Unrestricted|Bypass)/i,
  // 磁盘破坏
  /\bbcdedit\b/i,
  /\bdiskpart\b/i,
  // 凭据 / 安全模块
  /\bcipher\s+\/w/i,                                // cipher /w 擦除空闲空间
]
```

**参数缩写（2026-10-20）**：PowerShell 会解析无歧义前缀，`Remove-Item -Rec -Fo C:\...`、`rm -r -fo ...`、`ri -rec -fo ...` 都真的执行递归强删。规则按「动词 + 两个参数（任意顺序）」书写，而不是逐个别名 × 逐个全称。`-f` 单字母歧义（`-Filter` / `-Force`），不予匹配；`-r` 在 `Remove-Item` 上无歧义，按 `-Recurse` 处理。`bash-command-approval.ts` 的 Windows 关键命令分类器使用同一组缩写模式。

### 公共黑名单

`POSIX_BANNED` 与 `WINDOWS_BANNED` 之外，所有平台共享：

```typescript
const SHARED_BANNED: RegExp[] = [
  // 暂无；保留扩展点（未来可能加 SSRF 命令、加密货币挖矿特征等）
]
```

`getBannedPatterns(platform)` 返回 `[...SHARED_BANNED, ...(platform === 'windows' ? WINDOWS_BANNED : POSIX_BANNED)]`。

**为什么不做语义判断**：黑名单只拦最显著的破坏命令，LLM 真要绕过总能绕（如 base64 编码）；真正的兜底是沙箱（workspace.rootPath / boundPath）与人工审批（fsWriteApprovalMode）。

---

## 工具描述按平台变体

`src/server/tools/bash.ts` 的 `description` 字段从静态字符串改为基于 `currentPlatform()` 生成：

- **POSIX**：`"Run a shell command inside workspace. POSIX uses the user login shell for zsh/bash ($SHELL -l -i -c) when available, otherwise sh -c. Use POSIX syntax: ls, grep, cat, git, npm. Output: stdout+stderr merged, 10000 char limit, 30s timeout. Blocked: rm -rf /, sudo, fork bombs, curl | sh."`
- **Windows**：`"Run a PowerShell 5.1 command inside workspace. Use PowerShell syntax: Get-ChildItem, Select-String, Get-Content, git, npm. Output is UTF-8 (chcp 65001), stdout+stderr merged, 10000 char limit, 30s timeout. Blocked: Remove-Item -Recurse -Force, format, shutdown, iex(iwr ...), reg delete."`

**注**：CustomAgentAdapter 与 ClaudeCodeAdapter 不共用同一工具实例；ClaudeCodeAdapter 走 SDK 原生 shell 工具，描述由 SDK 控制，但 `canUseTool` 钩子里的黑名单走同一份 `getBannedPatterns`。**这句成立有前提：钩子必须认得出这是 shell 工具。** 工具名由 SDK 按平台提供 —— POSIX 上是 `Bash`，Windows 上实测是 `PowerShell`（2026-10-18）。此前 `bridgePermission` 只判断 `toolName === 'Bash'`，于是在 Windows 上黑名单与审批分类器整条未被咨询，所有命令落到默认放行。识别规则（已知名集合、本次 run 的 `tools` 表、输入带 `command`）与失败关闭行为见 `specs/05-adapter-interface.md`「canUseTool 桥」。

---

## 进程清理

**POSIX**：优先按进程组杀 —— `process.kill(-child.pid, signal)`（要求子进程以 `detached: true` 启动），拿不到 pid 时回退 `child.kill(signal)`。若 5 秒后目标仍存活，对同一进程组 / pid 补发 `SIGKILL`（`killProcessTree` / `killProcessTreeByPid` 内统一实现；定时器 `unref()`，不阻止进程退出）。

**Windows**：Node 的 `child.kill('SIGTERM')` 在 Windows 下等价于 `TerminateProcess`，**杀不到孙子进程**（如 `powershell → npm → node`，npm 退了但 node 留下）。因此走：

```typescript
function killProcessTree(child: ChildProcess, platform: Platform, signal = 'SIGTERM') {
  if (platform === 'windows' && typeof child.pid === 'number') {
    spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true })
  } else if (typeof child.pid === 'number') {
    process.kill(-child.pid, signal)   // 进程组；ESRCH 等失败时回退 child.kill(signal)
    if (signal !== 'SIGKILL') {
      setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 5000).unref()
    }
  } else {
    child.kill(signal)
  }
}
```

`taskkill /F /T /PID` 强制递归杀进程树；不存在的 PID 静默忽略。

**共享实现**：该函数已从 `src/server/tools/bash.ts` 提到 **`src/server/child-process.ts`**，由 `bash` 工具与**外部 MCP stdio server 的 teardown**（Spec 15）**共用同一份**，避免两处各写一份、总有一处漏杀。

---

## 外部 MCP stdio 子进程（Spec 15）

用户登记的外部 MCP server 的 stdio 形态会在 run 期间以子进程运行。两个跨平台要点：

1. **清理**：run 结束 / abort 时用上面共享的 `killProcessTree` 杀**进程树**（Windows `taskkill /F /T`，POSIX 进程组），与 bash 工具同一实现 —— 否则 `stdio server → 它拉起的子命令` 会留下孤儿进程。
2. **环境：完整继承，不是白名单**：stdio MCP 子进程用 `buildChildProcessEnv` 启动，把 `process.env` **整体透传**（唯一变换是 Windows 上补 `HOME ← USERPROFILE`）。这**不是**白名单、也**不构成隔离** —— 因此该 server **能读到 AgentHub 自己存的 provider API Key 与内部 token**。设置面板的「测试连接」探测进程（`testMcpServerConnection`）同样如此。这是明确接受的安全取舍（本地单用户，登记 = 知情同意，CLAUDE.md §5.4），但文档与 UI 都**只能**描述为「完整环境继承」，**不得**称其为白名单或隔离（详见 Spec 15 §6.3）。

**Codex 的 MCP 配置落在隔离的 `CODEX_HOME`**：codex adapter 把外部 server 写进 `config.mcp_servers`，而 Codex 子进程的 `CODEX_HOME` / `CODEX_SQLITE_HOME` 指向 AgentHub dataDir 下的隔离目录，所以**不碰用户本机 `~/.codex/config.toml`**（见「SDK 子进程的 HOME 兼容」与 Spec 05）。

---

## SDK 子进程的 HOME 兼容

Claude Code SDK 内部用 `~` 展开（通过 `os.homedir()`）找配置。Node 在 Windows 上 `os.homedir()` 已正确返回 `C:\Users\xxx`，但若 SDK 子进程检查 `process.env.HOME`（POSIX 风俗），Windows 默认无此变量。

`buildSdkEnv` 兜底：

```typescript
function buildSdkEnv(...) {
  const base = { ...process.env }
  if (process.platform === 'win32' && !base.HOME) {
    base.HOME = base.USERPROFILE
  }
  // ...其余 API key 注入逻辑
}
```

---

## SDK 子进程不加载项目设置

Claude Code adapter 以**隔离模式**启动 SDK 子进程：

```typescript
settingSources: [],       // 不读任何文件系统设置源
strictMcpConfig: true,    // MCP server 只来自 adapter 显式传入的 mcpServers
```

`settingSources: []` 排除的是**作用域在 workspace 上的**文件系统设置源：

- workspace 的 `.claude/settings.json` / `settings.local.json` —— 尤其 `permissions.allow`：它在 CLI 侧**先于** `canUseTool` 求值，命中就不再回调（Bash 审批门与外部 MCP 的 `trust='ask'` 门都会因此被绕过）
- **项目 hooks** —— hook 是**在宿主上执行命令**，不经过 `canUseTool`，也不经过命令黑名单
- workspace 的 plugins / skills / 自定义命令 / `.claude/agents/` frontmatter
- workspace 的 `.mcp.json`（`strictMcpConfig` 独立再关一次，否则工作区放一个文件就能让 CLI 自己 spawn 任意 MCP server）

**不在排除范围**：管理员托管 / 策略层设置（managed policy）。企业下发的 `deny` 规则照旧生效 —— 这是有意的。

**唯一例外**：AgentHub 自己读 `<effectiveCwd>/CLAUDE.md` 注入 system prompt。原因是该 SDK 里「不加载项目设置」与「不加载项目 `CLAUDE.md`」是同一个开关，没有只关一半的选项（详见 Spec 05「项目记忆（CLAUDE.md）」）；上限 50 000 字符，读失败不 fail run。

**为什么不是「写保护 `.claude/`」**：bash 的 cwd 就是 workspace 根，`mkdir -p .claude && echo '{}' > .claude/settings.json` 既不在 `security.ts` 的黑名单里也不触发关键命令审批；local 模式下 workspace 就是用户真实仓库，本来就可能有这个文件。写保护不可执行。

契约：`openspec/specs/platform-security/spec.md`「SDK child processes SHALL start without filesystem settings sources」。改这一节等于改安全边界（CLAUDE.md §5.5、§6.2）。

---

## 沙箱路径校验（isPathSafe）

`src/server/workspace-utils.ts` 的 `isPathSafe(absPath)` 拒绝几类敏感目录。Windows 与 POSIX 走分支。

### 路径比较

**Windows 上路径比较必须大小写不敏感**。`C:\Users\Foo` 与 `c:\users\foo` 在 NTFS / ReFS 上是同一路径。封装为 helper：

```typescript
// 子路径包含判断；Windows 大小写不敏感，POSIX 大小写敏感
export function isPathWithin(child: string, parent: string): boolean {
  const norm = (p: string) =>
    process.platform === 'win32'
      ? path.resolve(p).toLowerCase()
      : path.resolve(p)
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p + path.sep)
}
```

`resolveSafePath` 与 `attachment-service` 的 traversal 检查统一走此 helper。

### 真实路径（symlink / junction）

词法比较只能挡住 `..`，挡不住 workspace **内部**指向外部的符号链接：`ln -s /etc inside/etc-link` 后，`inside/etc-link/passwd` 词法上完全在子树内。Windows 的目录 junction（`mklink /J`）同理。因此 `resolveSafePath` 在词法检查通过后，再按真实路径比较一次：

1. `realpathSync.native(cwd)` 得到 workspace 的真实根；
2. 目标存在时取 `realpathSync.native(target)`；
3. 目标不存在时（写入新文件），向上找到最近的已存在祖先做 realpath，再把剩余路径段拼回；
4. 真实路径不在真实根内 → 返回 `null`（与词法越权同一处理）。

workspace 根尚不存在时（刚建会话）退化为纯词法检查：此时没有可解析的真实路径，也没有可逃逸的链接。

这覆盖 `fs_read` / `fs_write` / `fs_list` / `readIfExists` / 部署脚本路径——它们都走 `assertPathWithinWorkspace`。`scanWorkspaceUsage` 的递归遍历另有 realpath 去重（见下文），两者互补。

### 系统根（systemRoots）

| 平台 | 路径 | 说明 |
|---|---|---|
| POSIX | `/etc`, `/System`, `/usr`, `/bin`, `/sbin`, `/var`, `/private`, `/Library/Keychains` | macOS / Linux 系统 |
| Windows | 每个可用盘符的 `\Windows`、`\Program Files`、`\Program Files (x86)`、`\$Recycle.Bin`、`\System Volume Information`、`\Recovery`；以及 `\ProgramData`（只在系统盘） | 多盘符均拦 |

**UNC 设备路径**（`\\?\`、`\\.\`）一律拒绝（绕过 Windows 路径规范化容易越狱）。

**普通 UNC 网络路径**（`\\server\share\...`）暂拒——文件系统语义不可靠（offline、ACL）。后续有需求再开放。

Drives 列表通过 `statSync('A:\\')` … `statSync('Z:\\')` 探测可用盘符（同 `/api/fs/listdir` 的 drives sentinel），模块级缓存避免重复 IO。

**缓存生命周期**：进程级缓存，**只在 Next server 重启时刷新**。dev 期间用户热插 U 盘 / 网络盘映射，新盘符不会出现在 `getSystemRoots()`，对应的 `\Windows`、`\Program Files` 等系统根拦截不到该盘符。这是有意接受的 trade-off —— 频繁 `statSync` 26 个盘符在每次 `isPathSafe` 调用里都跑代价更大。受影响的是「软安全」：用户能直接编辑 DB 绕过 isPathSafe，所以 stale 盘符的拦截缺失不算严重风险。

### 敏感子路径（sensitiveSegments）

相对 `homedir()` 的路径片段，命中即拒。

| 平台 | 片段 |
|---|---|
| 跨平台 | `.ssh`, `.aws`, `.gcloud`, `.kube`, `.gnupg`, `.docker`, `.azure` |
| POSIX | `.config/gh`, `Library/Keychains`, `Library/Application Support/Code/User` |
| Windows | `AppData\Roaming\Microsoft\Credentials`, `AppData\Local\Microsoft\Credentials`, `AppData\Roaming\Microsoft\Protect`, `AppData\Roaming\gh`, `AppData\Roaming\Claude` |

注：`AppData` 本身不一律拒，只挡明确凭证子目录；用户可能合法工作在 `AppData\Local\Programs\...` 下。

---

## boundPath 输入校验（conversation-service）

用户在「新建对话」绑定本地目录时，`conversation-service` 的 `createConversation` 校验：

- 必须 `path.isAbsolute(input)` 为 true
- **Windows 上额外**：原始输入字符串必须匹配 `^[A-Za-z]:[\\/]` 或 `^\\\\` 开头。否则 `/foo`、`/tmp` 这类 POSIX 风格输入会被 Node `path.resolve` 当作「当前盘符根 + 路径」（如 `C:\foo`），与用户意图不符
- 路径存在、是目录、可读写
- 通过 `isPathSafe`

---

## DirPicker 隐藏目录过滤

`/api/fs/listdir` 列出的子目录：

- 跨平台：以 `.` 开头的目录（dotfile / dotdir）过滤
- Windows 额外过滤已知隐藏 / 系统目录名（大小写不敏感）：`AppData`、`$Recycle.Bin`、`System Volume Information`、`Recovery`、`PerfLogs`、`Config.Msi`、`MSOCache`、`OneDriveTemp`、`ProgramData`

**Why 不读 Windows hidden attribute**：Node `fs.statSync` 不暴露此 attribute；引入第三方包（如 `winattr`）违反 CLAUDE.md §4.3「不为将来可能用到加抽象」，且这些已知名能覆盖 95% 噪音目录。

---

## UI placeholder 平台感知

`new-conversation-dialog.tsx` 的 boundPath 输入框 placeholder 按服务器平台显示：

- POSIX: `/Users/me/projects/foo`
- Windows: `D:\projects\foo`

服务器平台通过 `GET /api/platform` 一次性获取（返回 `{ platform: 'posix' | 'windows' }`），前端 useEffect 缓存。

**Why 不用 `navigator.userAgent`**：用户可能从 Mac 浏览器访问 Windows 上跑的 AgentHub，浏览器侧推断会与实际 host 不一致；服务器才是 bash 工具实际跑的地方。

---

## Workspace 清理重试

`conversation-service.ts` 的 `rmSync(workspace.rootPath, { recursive: true, force: true })` 在 Windows 经常抛 `EBUSY` / `EPERM` / `ENOTEMPTY`：

- 文件被进程占用（dev server / git）
- Antivirus 实时扫描时 hold handle
- `.git/index.lock` 类残留锁文件

实现：用 `fs/promises.rm` + 指数退避重试，100ms / 300ms / 900ms，3 次后仍失败才放弃（仅 `console.warn`，不上报 DB —— workspace 目录残留不影响逻辑正确性，下次清理或手动删即可）。

```typescript
async function rmDirWithRetry(target: string): Promise<void> {
  const RETRYABLE = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await fsp.rm(target, { recursive: true, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (!RETRYABLE.has(code) || attempt === 3) throw err
      await new Promise((r) => setTimeout(r, 100 * Math.pow(3, attempt - 1)))
    }
  }
}
```

---

## 递归扫描的 symlink/junction 防护

`fs-service.ts` 的 `scanWorkspaceUsage` 用栈递归遍历 workspace 算大小 / 文件数（fs_write 配额）。

- POSIX 上 `ln -s` symlink 可能引入循环
- Windows 上 `mklink /J` junction 与 `mklink /D` 目录 symlink 都是 reparse point，同样会循环

实现：访问每个目录前 `realpathSync(dir)`，记录到 `Set<string>`，重复 realpath 直接跳过。

**Why 不在 fs_read/fs_write 工具层做**：那两个是单文件操作，没有递归；`scanWorkspaceUsage` 是唯一的递归路径。

---

## 故意不做的事

| 项目 | 不做的理由 |
|---|---|
| **iconv-lite 编码 fallback** | PowerShell `[Console]::OutputEncoding = UTF8` 已覆盖实测场景；引入新依赖按 CLAUDE.md §6.2 要先讨论。等到真有 native exe 输出无视 PS encoding 的命令再加 |
| **Long path（>260）`\\?\` 前缀注入** | Win10 1607+ 默认支持长路径（需要 group policy + manifest），Node 24 内部已处理；实测踩坑再加 |
| **`SIGTERM → SIGKILL` 升级（POSIX）** | 现状 30s 超时直接 SIGTERM，未升级 SIGKILL。Phase 1 验证下来没有「kill 不掉」的命令；遇到再补 |

---

## 验证清单（Phase 1 + Phase 2 + Phase 3 合并前）

**Phase 1**：
- [ ] macOS：现有 bash 工具调用行为不变（回归 `ls`、`git status`、`npm test`）
- [ ] Windows：新建 sandbox 会话，bash 工具能跑 `Get-ChildItem`、`git --version`、`echo 中文`（输出非乱码）
- [ ] Windows：bash 工具拒绝 `Remove-Item -Recurse -Force C:\`、`format C:`、`iex (iwr ...)`
- [ ] Windows：bash 工具 30s 超时后用 `taskkill /F /T` 清进程树，无孤儿 `node.exe`
- [ ] Windows：Claude Code agent 启动正常（SDK 找到 `~/.claude` 即 `%USERPROFILE%\.claude`）

**Phase 2**：
- [ ] Windows：DirPicker 看不到 `AppData`、`$Recycle.Bin`、`System Volume Information` 等隐藏目录
- [ ] Windows：尝试绑定 `D:\Windows` 被拒（系统根）
- [ ] Windows：尝试绑定 `C:\Users\me\.ssh` 被拒（敏感子路径）
- [ ] Windows：绑定 `D:\projects\xxx` 成功，bash 工具能在该目录运行
- [ ] Windows：输入框 placeholder 显示 `D:\projects\foo` 而非 `/Users/me/projects/foo`
- [ ] Windows：路径大小写不敏感（`C:\Users\Foo` 与 `c:\users\foo` 互通）
- [ ] Windows：boundPath 输入 `/tmp` 被拒（POSIX 风格在 Windows 上无意义）

**Phase 3**：
- [ ] Windows：删除一个文件被 dev server 占用的会话，workspace 删除会重试 3 次后才放弃
- [ ] Windows：在 workspace 内 `mklink /J loop .` 创建 junction 循环，`scanWorkspaceUsage` 不死循环
- [ ] POSIX：在 workspace 内 `ln -s . loop` 创建 symlink 循环，`scanWorkspaceUsage` 不死循环

---

## 与其他 spec 的关系

- Spec 07（工具系统）：bash 工具的 `description` 与黑名单引用本 spec
- CLAUDE.md §5.2：黑名单原文从单平台改为双平台，详见本 spec 「命令黑名单」节
- Spec 05（adapter）：Claude Code adapter 的 `canUseTool` 黑名单走 `getBannedPatterns(currentPlatform())`
