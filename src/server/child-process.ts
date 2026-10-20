/**
 * 子进程清理工具 —— spec 11 §「子进程清理」的落点。
 *
 * 从 tools/bash.ts 提出来供外部 MCP stdio server 复用：Windows 上 `child.kill()`
 * 杀不掉孙进程，必须 taskkill /T；POSIX 上要用进程组（负 pid），依赖 spawn 时
 * `detached: true`。两处都必须用同一份实现，否则总有一处会漏杀。
 */
import { spawnSync, type ChildProcess } from 'node:child_process'

import type { Platform } from '@/server/platform'

const FORCE_KILL_DELAY_MS = 5_000
/**
 * taskkill 走 Windows 的进程管理接口；该接口偶尔会整体卡住（实测一次 /F /T 花 61 秒）。
 * 同步调用会阻塞整个事件循环，所以给它一个上限，超时后退回直接结束目标进程。
 */
const TASKKILL_TIMEOUT_MS = 5_000

function taskkillTree(pid: number): void {
  const result = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: TASKKILL_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  if (result.error || result.status !== 0) {
    // taskkill 不可用或超时：至少把目标进程结束掉，孙进程清理退化为尽力而为
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已退出
    }
  }
}

/** POSIX 进程可能在收到 SIGTERM 后继续忽略；5 秒后对同一目标补 SIGKILL。 */
function scheduleForceKill(pids: number[], useProcessGroup: boolean): void {
  if (pids.length === 0) return
  const timer = setTimeout(() => {
    for (const pid of pids) {
      try {
        process.kill(useProcessGroup ? -pid : pid, 'SIGKILL')
      } catch {
        // 进程已退出；清理是尽力而为。
      }
    }
  }, FORCE_KILL_DELAY_MS)
  timer.unref()
}

/** 杀进程树。Windows 走 taskkill /F /T；POSIX 走进程组（要求子进程 detached）。 */
export function killProcessTree(
  child: ChildProcess,
  platform: Platform,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  if (platform === 'windows' && typeof child.pid === 'number') {
    // 同步执行：taskkill 未跑完就继续关闭 stdio / 让父进程退出，会让 /T 拿不到完整进程树。
    taskkillTree(child.pid)
    return
  }
  if (typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, signal)
      if (signal !== 'SIGKILL') scheduleForceKill([child.pid], true)
      return
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? (error as { code?: unknown }).code : null
      if (code !== 'ESRCH') {
        child.kill(signal)
        if (signal !== 'SIGKILL') scheduleForceKill([child.pid], true)
      }
      return
    }
  }
  child.kill(signal)
}

/**
 * 按 pid 杀进程树。MCP SDK 的 stdio transport 以 `detached: false` 启动，拿不到进程组，
 * 所以不能复用上面按负 pid 的实现。
 */
export function killProcessTreeByPid(
  pid: number,
  platform: Platform,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  if (!Number.isInteger(pid) || pid <= 0) return

  if (platform === 'windows') {
    // 同步执行：调用方随后就会 close transport，不能让 taskkill 与父进程退出赛跑。
    taskkillTree(pid)
    return
  }

  const childrenByParent = new Map<number, number[]>()
  const listed = spawnSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' })
  if (!listed.error && typeof listed.stdout === 'string') {
    for (const line of listed.stdout.split('\n')) {
      const [pidText, ppidText] = line.trim().split(/\s+/)
      const childPid = Number(pidText)
      const parentPid = Number(ppidText)
      if (!Number.isInteger(childPid) || !Number.isInteger(parentPid)) continue
      const siblings = childrenByParent.get(parentPid)
      if (siblings) siblings.push(childPid)
      else childrenByParent.set(parentPid, [childPid])
    }
  }

  // 先收集后代再由深到浅杀：父进程先退出会让子进程被 reparent，之后 `ps` 就找不到了。
  const descendants: number[] = []
  const stack = [pid]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) continue
    for (const childPid of childrenByParent.get(current) ?? []) {
      descendants.push(childPid)
      stack.push(childPid)
    }
  }

  for (const target of [...descendants.reverse(), pid]) {
    try {
      process.kill(target, signal)
    } catch {
      // 进程可能已退出；清理是尽力而为。
    }
  }

  if (signal !== 'SIGKILL') scheduleForceKill([...descendants, pid], false)
}
