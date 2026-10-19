/**
 * 跨 server / client 共享的常量。放在 `shared/` 下避免 client 误 import server 文件。
 */

/** 单会话内 pin 消息上限；超过由 conversation-service 拒绝以防 system prompt 膨胀。 */
export const PIN_LIMIT_PER_CONVERSATION = 5

/** user 消息正文上限（桌面 / 移动 / 编辑统一），防止超长文本撑爆上下文与 UI。 */
export const MAX_MESSAGE_CHARS = 12000

/** id 类字符串上限：id 都是短 token，超长输入只可能是异常请求。 */
export const MAX_ID_CHARS = 200

/** 请求体里 id 列表的上限（会话成员、附件、工具名等批量字段）。 */
export const MAX_ID_LIST_LENGTH = 50

/** Agent system prompt 上限：远高于实际用量，只用于挡住异常超大请求。 */
export const MAX_SYSTEM_PROMPT_CHARS = 100_000

/** API key / base URL 等配置字符串的请求体上限。 */
export const MAX_API_KEY_CHARS = 4096
export const MAX_URL_CHARS = 2048
