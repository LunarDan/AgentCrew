import { and, eq, isNull } from 'drizzle-orm'

import { db, schema } from '@/db/client'
import type { DeviceSessionRow } from '@/db/schema'
import { newDeviceSessionId } from '@/server/ids'
import { newMobileDeviceToken } from '@/server/companion-config'
import { hashMobileDeviceToken } from '@/server/mobile-token-hash'

/**
 * 移动端设备会话（specs/14-mobile-remote.md §5.2）。
 *
 * 一设备一 token；DB 只存 sha256，明文只在配对响应里出现一次。吊销后即便 token
 * 被复制出来也不再可用 —— 这是 §5.3 一次性配对码的价值。
 */

const LAST_SEEN_THROTTLE_MS = 60_000
const MAX_DEVICE_NAME_LENGTH = 64

export interface DeviceSessionSummary {
  id: string
  deviceName: string
  createdAt: number
  lastSeenAt: number | null
}

/** 设备名会原样出现在桌面设置页，去掉控制字符并限长。 */
export function normalizeDeviceName(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (cleaned || '未知设备').slice(0, MAX_DEVICE_NAME_LENGTH)
}

export async function createDeviceSession(
  deviceName: string,
  now = Date.now(),
): Promise<{ session: DeviceSessionSummary; deviceToken: string }> {
  const deviceToken = newMobileDeviceToken()
  const row: DeviceSessionRow = {
    id: newDeviceSessionId(),
    deviceName: normalizeDeviceName(deviceName),
    tokenHash: hashMobileDeviceToken(deviceToken),
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
  }
  await db.insert(schema.deviceSessions).values(row)
  return {
    session: {
      id: row.id,
      deviceName: row.deviceName,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
    },
    deviceToken,
  }
}

/** 未吊销的会话；调用方用它的 id / 名称判断是否仍有效。 */
export async function findActiveDeviceSessionByHash(
  tokenHash: string,
): Promise<DeviceSessionRow | null> {
  const row = await db.query.deviceSessions.findFirst({
    where: and(
      eq(schema.deviceSessions.tokenHash, tokenHash),
      isNull(schema.deviceSessions.revokedAt),
    ),
  })
  return row ?? null
}

/** 记录活跃时间；按分钟节流，避免每个请求都写库。 */
export async function touchDeviceSession(id: string, now = Date.now()): Promise<void> {
  const row = await db.query.deviceSessions.findFirst({
    where: eq(schema.deviceSessions.id, id),
  })
  if (!row || row.revokedAt !== null) return
  if (row.lastSeenAt !== null && now - row.lastSeenAt < LAST_SEEN_THROTTLE_MS) return
  await db
    .update(schema.deviceSessions)
    .set({ lastSeenAt: now })
    .where(eq(schema.deviceSessions.id, id))
}

export async function listDeviceSessions(): Promise<DeviceSessionSummary[]> {
  const rows = await db.query.deviceSessions.findMany({
    where: isNull(schema.deviceSessions.revokedAt),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  })
  return rows.map((row) => ({
    id: row.id,
    deviceName: row.deviceName,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  }))
}

/** 吊销是幂等的：已经吊销 / 不存在的 id 返回 false。 */
export async function revokeDeviceSession(id: string, now = Date.now()): Promise<boolean> {
  const result = await db
    .update(schema.deviceSessions)
    .set({ revokedAt: now })
    .where(and(eq(schema.deviceSessions.id, id), isNull(schema.deviceSessions.revokedAt)))
    .returning({ id: schema.deviceSessions.id })
  return result.length > 0
}
