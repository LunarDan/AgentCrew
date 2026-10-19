import type { NextRequest } from 'next/server'

import { mobileJson } from './mobile-cors'

/** 明确的「目标不存在」；移动端路由只把它映射成 404。 */
export class MobileNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MobileNotFoundError'
  }
}

/**
 * 移动端路由统一错误出口：已知 4xx 原样返回；其余只记日志、回通用 500。
 * 移动端走局域网，内部错误串（路径、SQL、堆栈）不能回给别的设备。
 */
export function mobileErrorJson(req: NextRequest, err: unknown, action: string) {
  if (err instanceof MobileNotFoundError) {
    return mobileJson(req, { error: err.message }, { status: 404 })
  }
  console.error(`[mobile] ${action} failed`, err)
  return mobileJson(req, { error: 'Internal error' }, { status: 500 })
}
