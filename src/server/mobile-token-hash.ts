import { createHash } from 'node:crypto'

/** 设备 token / 一次性流 token 的绑定都用同一个哈希（纯函数，避免测试拉进 DB 初始化）。 */
export function hashMobileDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
