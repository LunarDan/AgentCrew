/**
 * 跨 server / client 共享的常量。放在 `shared/` 下避免 client 误 import server 文件。
 */

/** 单会话内 pin 消息上限；超过由 conversation-service 拒绝以防 system prompt 膨胀。 */
export const PIN_LIMIT_PER_CONVERSATION = 5

/** user 消息正文上限（桌面 / 移动 / 编辑统一），防止超长文本撑爆上下文与 UI。 */
export const MAX_MESSAGE_CHARS = 12000
