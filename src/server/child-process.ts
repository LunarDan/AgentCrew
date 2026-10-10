/**
 * 子进程清理工具 —— spec 11 §「子进程清理」的落点。
 *
 * 从 tools/bash.ts 提出来供外部 MCP stdio server 复用：Windows 上 `child.kill()`
 * 杀不掉孙进程，必须 taskkill /T；POSIX 上要用进程组（负 pid），依赖 spawn 时
 * `detached: true`。两处都必须用同一份实现，否则总有一处会漏杀。
 */
import { spawn, type ChildProcess } from 'node:child_process'

import type { Platform } from '@/server/platform'

/** 杀进程树。Windows 走 taskkill /F /T；POSIX 走进程组（要求子进程 detached）。 */
export function killProcessTree(
  child: ChildProcess,
  platform: Platform,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  if (platform === 'windows' && typeof child.pid === 'number') {
    const killer = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true })
    killer.on('error', () => {})
    return
  }
  if (typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? (error as { code?: unknown }).code : null
      if (code !== 'ESRCH') {
        child.kill(signal)
      }
      return
    }
  }
  child.kill(signal)
}
