/**
 * 一次性 schema migration：新增 mcp_servers 表 + agents.mcp_server_ids 列
 * （外部 MCP server 登记，见 specs/15-external-mcp.md）。
 *
 * 与 toolNames 的关系：
 *  - toolNames      = 内置工具多选，SDK adapter 下会被清空
 *  - mcpServerIds   = 外部 MCP server 引用，SDK adapter 下**保留**（那正是 SDK agent 拿自选工具的途径）
 *
 * 可重入：表 / 列已存在时跳过。`pnpm db:push` 也能创建，这个脚本是给已有库的 ALTER 路径。
 *
 * 执行：tsx src/db/migrate-add-mcp-servers.ts
 */
import { sql } from 'drizzle-orm'

import { db } from './client'

/**
 * drizzle 把 driver 错误包成 `DrizzleError`，真正的 SQLite 消息在 `cause` 里
 * （`err.message` 只有 "Failed to run the query ..."）。幂等判断必须看 cause，
 * 否则脚本第二次跑就会抛错。
 */
function errorText(err: unknown): string {
  const parts: string[] = []
  let cur: unknown = err
  for (let depth = 0; depth < 5 && cur instanceof Error; depth += 1) {
    parts.push(cur.message)
    cur = cur.cause
  }
  return parts.join(' | ').toLowerCase()
}

function safeRun(stmt: string, label: string) {
  try {
    db.run(sql.raw(stmt))
    console.log(`✓ ${label}`)
  } catch (err) {
    if (errorText(err).includes('already exists')) {
      console.log(`= ${label}, skip`)
    } else {
      throw err
    }
  }
}

function safeAlter(stmt: string, columnName: string) {
  try {
    db.run(sql.raw(stmt))
    console.log(`✓ added column ${columnName}`)
  } catch (err) {
    if (errorText(err).includes('duplicate column')) {
      console.log(`= column ${columnName} already exists, skip`)
    } else {
      throw err
    }
  }
}

safeRun(
  `CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    transport TEXT NOT NULL,
    command TEXT,
    args TEXT NOT NULL DEFAULT '[]',
    env TEXT,
    url TEXT,
    headers TEXT,
    trust TEXT NOT NULL DEFAULT 'ask',
    enabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  'created mcp_servers',
)

safeAlter(
  `ALTER TABLE agents ADD COLUMN mcp_server_ids TEXT NOT NULL DEFAULT '[]'`,
  'mcp_server_ids',
)

console.log('done')
