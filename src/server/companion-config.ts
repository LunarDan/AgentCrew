import { randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type CompanionMode = 'off' | 'lan' | 'tailnet'

export const DEFAULT_COMPANION_PORT = 60646

export interface CompanionConfig {
  companionMode: CompanionMode
  mobileDeviceToken: string | null
  companionPort: number
}

export function newMobileDeviceToken(): string {
  return randomBytes(24).toString('base64url')
}

export function writeCompanionConfig(config: CompanionConfig): void {
  const dataDir =
    process.env.AGENTHUB_DATA_DIR ??
    path.resolve(/* turbopackIgnore: true */ process.cwd(), '.agenthub-data')
  mkdirSync(dataDir, { recursive: true })
  const target = path.join(dataDir, 'companion.json')
  // 这个文件里有明文设备 token：直接覆写时崩溃 / 磁盘满会留下半截 JSON，
  // 下次 Electron 启动读不出来就会静默退回 off。temp + rename 保证原子性。
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 })
  try {
    renameSync(temp, target)
  } catch (err) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // 清理失败不影响原始错误
    }
    throw err
  }
}
