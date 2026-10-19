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

/** 会话服务里这些错误是用户可理解、可操作的输入问题；其余一律按内部错误处理。 */
const USER_ERROR_PREFIXES = [
  'Conversation not found',
  'Message not found',
  'Only the latest user message',
  'Only user messages',
  'Content cannot be empty',
  'Message is too long',
  'No user message to regenerate',
  'A newer user message arrived',
  'Attachments',
  '群聊缺少协调者',
  'No available agent',
]

/** 与 mobileErrorJson 相同，但保留已知的用户输入错误文案（不泄露其它内部错误）。 */
export function mobileUserErrorJson(req: NextRequest, err: unknown, action: string) {
  if (err instanceof Error && USER_ERROR_PREFIXES.some((p) => err.message.startsWith(p))) {
    const status = err.message.startsWith('Message not found') ? 404 : 400
    return mobileJson(req, { error: err.message }, { status })
  }
  return mobileErrorJson(req, err, action)
}
