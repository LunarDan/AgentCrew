import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import type { WorkspaceRow } from '@/db/schema'
import { IS_WINDOWS } from '@/server/platform'

/**
 * workspace 模式相关 helper：
 *  - getEffectiveCwd：决定 bash / fs 工具的 cwd（local 模式用 boundPath，sandbox 用 rootPath）
 *  - assertPathWithinWorkspace：把工具入参的路径解析到 effective cwd 子树内，越权抛错
 *  - isPathSafe：拒绝明显敏感的系统 / 用户隐私目录（创建会话时校验 boundPath；listdir API 校验导航目标）
 *  - isPathWithin：跨平台路径包含判断（Windows 大小写不敏感）—— 详见 specs/11-platform.md
 */

export function getEffectiveCwd(workspace: WorkspaceRow): string {
  if (workspace.mode === 'local' && workspace.boundPath) {
    return workspace.boundPath
  }
  return workspace.rootPath
}

const IS_WIN = IS_WINDOWS

/** 子路径包含判断。Windows 大小写不敏感；POSIX 大小写敏感。 */
export function isPathWithin(child: string, parent: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p)
    return IS_WIN ? resolved.toLowerCase() : resolved
  }
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p + path.sep)
}

/**
 * 把 target（可相对、可绝对）解析为绝对路径，并强制落在 workspace 的 effective cwd 子树内。
 * 越权返回 null（调用方决定怎么响应）。
 *
 * 只做词法比较不够：workspace 里的符号链接 / Windows junction 可以指向外部，
 * 而 `path.resolve` 不会展开它。这里再按真实路径（realpath）比较一次；
 * 目标不存在时展开最近的已存在祖先，防止「先指到不存在的链接目标，再写入」。
 */
export function resolveSafePath(workspace: WorkspaceRow, target: string): string | null {
  const cwd = getEffectiveCwd(workspace)
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd, target)
  if (!isPathWithin(abs, cwd)) return null

  const realCwd = realPathOrNull(cwd)
  if (!realCwd) return abs // workspace 根尚不存在（刚创建）：词法检查已经足够
  const realAbs = resolveRealPath(abs)
  if (!realAbs || !isPathWithin(realAbs, realCwd)) return null
  return abs
}

function realPathOrNull(p: string): string | null {
  try {
    return realpathSync.native(p)
  } catch {
    return null
  }
}

function resolveRealPath(abs: string): string | null {
  const direct = realPathOrNull(abs)
  if (direct) return direct
  const parent = path.dirname(abs)
  if (parent === abs) return null
  const realParent = resolveRealPath(parent)
  return realParent === null ? null : path.join(realParent, path.basename(abs))
}

export function assertPathWithinWorkspace(workspace: WorkspaceRow, target: string): string {
  const resolved = resolveSafePath(workspace, target)
  if (!resolved) {
    throw new Error(`Path "${target}" is outside workspace`)
  }
  return resolved
}

// Windows 可用盘符列表，模块级缓存避免重复 statSync
let _cachedDrives: string[] | null = null
function getAvailableDrives(): string[] {
  if (_cachedDrives) return _cachedDrives
  if (!IS_WIN) {
    _cachedDrives = []
    return _cachedDrives
  }
  const drives: string[] = []
  for (let i = 65; i <= 90; i++) {
    const root = `${String.fromCharCode(i)}:\\`
    try {
      statSync(root)
      drives.push(root)
    } catch {
      // drive not present
    }
  }
  _cachedDrives = drives
  return drives
}

function getSystemRoots(): string[] {
  if (!IS_WIN) {
    return ['/etc', '/System', '/usr', '/bin', '/sbin', '/var', '/private', '/Library/Keychains']
  }
  const roots: string[] = []
  for (const drive of getAvailableDrives()) {
    roots.push(
      path.join(drive, 'Windows'),
      path.join(drive, 'Program Files'),
      path.join(drive, 'Program Files (x86)'),
      path.join(drive, '$Recycle.Bin'),
      path.join(drive, 'System Volume Information'),
      path.join(drive, 'Recovery'),
    )
  }
  // %SystemDrive%\ProgramData
  const sysDrive = process.env.SystemDrive || 'C:'
  roots.push(path.join(sysDrive + '\\', 'ProgramData'))
  return roots
}

function getSensitiveSegments(): string[] {
  const shared = ['.ssh', '.aws', '.gcloud', '.kube', '.gnupg', '.docker', '.azure']
  if (IS_WIN) {
    return [
      ...shared,
      'AppData\\Roaming\\Microsoft\\Credentials',
      'AppData\\Local\\Microsoft\\Credentials',
      'AppData\\Roaming\\Microsoft\\Protect',
      'AppData\\Roaming\\gh',
      'AppData\\Roaming\\Claude',
    ]
  }
  return [
    ...shared,
    '.config/gh',
    'Library/Keychains',
    'Library/Application Support/Code/User',
  ]
}

/**
 * 拒绝几类明显敏感的目录：
 *  - 用户的 ssh / aws / gcloud / Windows 凭证等
 *  - 系统级目录（POSIX: /etc, /System, /usr...; Windows: 每盘符的 \Windows, \Program Files, \$Recycle.Bin... + \ProgramData）
 *  - UNC 设备路径（\\?\ / \\.\）一律拒
 *  - 用户 home 本身（让用户至少进一层）
 *
 * 这是「软安全」—— 不阻止恶意路径（用户都能直接编辑 DB 绕过），只是把
 * 「随手填错」的坑挡掉。
 */
export function isPathSafe(absPath: string): boolean {
  const lexical = path.resolve(absPath)

  // UNC 设备路径直接拒（realpath 之前先按原始写法拦）
  if (IS_WIN && /^\\\\[?.]\\/.test(lexical)) return false
  // 普通 UNC 网络路径（\\server\share）也暂拒
  if (IS_WIN && lexical.startsWith('\\\\')) return false

  // 解析符号链接 / junction 后再判：词法路径可能只是敏感目录的别名（如 D:\docs → ~/.ssh）。
  // 目标还不存在时沿祖先逐级 realpath，再接回剩余段 —— 否则「junction 下的新目录」会漏判。
  const real = resolveRealish(lexical)
  if (!real) return false

  const home = canonicalizeOrSelf(homedir())
  const normalized = real

  // 用户 home 自身不允许（agent 可以在 home 子目录里工作；纯等价比较，不含子路径）
  const homeKey = IS_WIN ? home.toLowerCase() : home
  const normalizedKey = IS_WIN ? normalized.toLowerCase() : normalized
  if (normalizedKey === homeKey) return false

  // 敏感子路径（相对 home）
  for (const seg of getSensitiveSegments()) {
    const sensitive = path.resolve(home, seg)
    if (isPathWithin(normalized, sensitive)) return false
  }

  // 系统根目录
  for (const root of getSystemRoots()) {
    if (isPathWithin(normalized, root)) return false
  }

  return true
}

function canonicalizeOrSelf(target: string): string {
  try {
    return realpathSync.native(path.resolve(target))
  } catch {
    return path.resolve(target)
  }
}

/** 沿祖先链找第一个可 realpath 的目录，再把剩余段接回去；根都解析不了返回 null。 */
function resolveRealish(target: string): string | null {
  let current = path.resolve(target)
  const rest: string[] = []
  while (true) {
    try {
      const real = realpathSync.native(current)
      return rest.length === 0 ? real : path.join(real, ...rest)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return null
      rest.unshift(path.basename(current))
      current = parent
    }
  }
}
