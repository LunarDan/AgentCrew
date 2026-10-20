/**
 * 全局 API key / endpoint 设置。单行表，PK 固定 'singleton'。
 *
 * 读取语义（adapter 用）：
 *   getKey(provider) → app_settings 字段 ?? process.env.<PROVIDER>_API_KEY ?? null
 *
 * agents.apiKey 仍然是 per-agent override，优先级最高，由 adapter 自行处理。
 */
import { eq } from 'drizzle-orm'

import { db, schema } from '@/db/client'
import type { AppSettingsRow } from '@/db/schema'
import {
  DEFAULT_COMPANION_PORT,
  newMobileDeviceToken,
  writeCompanionConfig,
  type CompanionMode,
} from '@/server/companion-config'

const SINGLETON_ID = 'singleton'

const EMPTY: AppSettingsRow = {
  id: SINGLETON_ID,
  anthropicApiKey: null,
  anthropicBaseUrl: null,
  openaiApiKey: null,
  deepseekApiKey: null,
  arkApiKey: null,
  companionMode: 'off',
  mobileDeviceToken: null,
  deploymentPublishEnabled: false,
  deploymentPublishDir: null,
  deploymentPublicBaseUrl: null,
  updatedAt: 0,
}

export async function getAppSettings(): Promise<AppSettingsRow> {
  const row = await db.query.appSettings.findFirst({
    where: eq(schema.appSettings.id, SINGLETON_ID),
  })
  return row ?? EMPTY
}

export interface AppSettingsPatch {
  anthropicApiKey?: string | null
  anthropicBaseUrl?: string | null
  openaiApiKey?: string | null
  deepseekApiKey?: string | null
  arkApiKey?: string | null
  companionMode?: CompanionMode
  mobileDeviceToken?: string | null
  deploymentPublishEnabled?: boolean
  deploymentPublishDir?: string | null
  deploymentPublicBaseUrl?: string | null
}

// 单行表的「读-合并-整行 upsert」必须串行：设置面板与 token 轮换并发保存时，
// 后写者会用自己读到的旧快照覆盖对方的字段。dev 下模块会热重载，队列必须挂在
// globalThis 上，否则新模块实例带着空队列并发写同一行。
const globalForSettings = globalThis as unknown as {
  __agenthubSettingsWriteQueue?: Promise<unknown>
}
function withSettingsWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalForSettings.__agenthubSettingsWriteQueue ?? Promise.resolve()
  const run = previous.then(fn, fn)
  globalForSettings.__agenthubSettingsWriteQueue = run.catch(() => {})
  return run
}

/** UPSERT 全部字段：传 null 清空，undefined 不动。 */
export async function updateAppSettings(patch: AppSettingsPatch): Promise<AppSettingsRow> {
  return withSettingsWriteLock(() => updateAppSettingsLocked(patch))
}

async function updateAppSettingsLocked(patch: AppSettingsPatch): Promise<AppSettingsRow> {
  const current = await getAppSettings()
  const next: AppSettingsRow = {
    ...current,
    ...Object.fromEntries(
      Object.entries(patch).map(([k, v]) => [k, normalize(v)]),
    ),
    id: SINGLETON_ID,
    updatedAt: Date.now(),
  } as AppSettingsRow

  if (next.companionMode !== 'off' && !next.mobileDeviceToken) {
    next.mobileDeviceToken = newMobileDeviceToken()
  }

  // upsert：先 delete + insert（SQLite ON CONFLICT 需要 unique constraint；PK 自带）
  await db
    .insert(schema.appSettings)
    .values(next)
    .onConflictDoUpdate({
      target: schema.appSettings.id,
      set: {
        anthropicApiKey: next.anthropicApiKey,
        anthropicBaseUrl: next.anthropicBaseUrl,
        openaiApiKey: next.openaiApiKey,
        deepseekApiKey: next.deepseekApiKey,
        arkApiKey: next.arkApiKey,
        companionMode: next.companionMode,
        mobileDeviceToken: next.mobileDeviceToken,
        deploymentPublishEnabled: next.deploymentPublishEnabled,
        deploymentPublishDir: next.deploymentPublishDir,
        deploymentPublicBaseUrl: next.deploymentPublicBaseUrl,
        updatedAt: next.updatedAt,
      },
    })

  try {
    syncCompanionRuntime(next)
  } catch (err) {
    // 行已提交：配置文件写失败不能让调用方以为保存没发生（重试会再写一次库）。
    console.error('[settings] failed to sync companion runtime', err)
  }
  return next
}

/** 只换 token：companionMode 必须由锁内的当前行决定，不能在这里读旧快照再写回。 */
export async function regenerateMobileDeviceToken(): Promise<AppSettingsRow> {
  return updateAppSettings({ mobileDeviceToken: newMobileDeviceToken() })
}

export function syncCompanionRuntime(settings: AppSettingsRow): void {
  writeCompanionConfig({
    companionMode: settings.companionMode,
    mobileDeviceToken: settings.mobileDeviceToken,
    companionPort: DEFAULT_COMPANION_PORT,
  })

  if (settings.companionMode !== 'off' && settings.mobileDeviceToken) {
    process.env.AGENTHUB_MOBILE_TOKEN = settings.mobileDeviceToken
  } else {
    delete process.env.AGENTHUB_MOBILE_TOKEN
  }
}

/** 空串归一为 null，避免 "" 与 null 混杂。trim 用户输入。 */
function normalize(v: string | boolean | null | undefined): string | boolean | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (typeof v === 'boolean') return v
  const trimmed = v.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 给 adapter 用的 helper：拿一个 provider 的 effective key。
 * 顺序：app_settings → env var → null。
 */
export async function getEffectiveApiKey(
  provider: 'anthropic' | 'openai' | 'deepseek' | 'ark',
): Promise<string | null> {
  const settings = await getAppSettings()
  switch (provider) {
    case 'anthropic':
      return settings.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? null
    case 'openai':
      return settings.openaiApiKey ?? process.env.OPENAI_API_KEY ?? null
    case 'deepseek':
      return settings.deepseekApiKey ?? process.env.DEEPSEEK_API_KEY ?? null
    case 'ark':
      return settings.arkApiKey ?? process.env.ARK_API_KEY ?? null
  }
}

/** Anthropic 的 base URL（第三方网关）；空 = 走 SDK 默认。 */
export async function getEffectiveAnthropicBaseUrl(): Promise<string | null> {
  const settings = await getAppSettings()
  return settings.anthropicBaseUrl ?? process.env.ANTHROPIC_BASE_URL ?? null
}
