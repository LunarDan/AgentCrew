import { mkdirSync } from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

import { bootstrapDatabase } from '../src/db/bootstrap'

const E2E_DATA_DIR = path.resolve('.agenthub-data-e2e')

interface SeedAgent {
  id: string
  name: string
  avatar: string
  description: string
  capabilities: string[]
  toolNames: string[]
  isOrchestrator?: boolean
}

const SEED_AGENTS: SeedAgent[] = [
  {
    id: 'ag_e2e_mock',
    name: 'E2E Mock',
    avatar: '🤖',
    description: 'E2E 测试专用 mock agent（确定性脚本回复，不调真实 LLM）',
    capabilities: ['test'],
    // write_artifact 让「产物」关键词脚本能真落库产物（mock adapter 只在有该工具时才演产物）。
    toolNames: ['write_artifact'],
  },
  {
    id: 'ag_e2e_orch',
    name: 'E2E Orchestrator',
    avatar: '🧭',
    description: 'E2E 测试专用 mock Orchestrator（确定性拆任务，不调真实 LLM）',
    capabilities: ['orchestration'],
    toolNames: ['plan_tasks', 'ask_user'],
    isOrchestrator: true,
  },
  {
    id: 'ag_e2e_worker_a',
    name: 'E2E Worker A',
    avatar: '🅰️',
    description: 'E2E 测试专用 mock 子 agent A',
    capabilities: ['test'],
    // 产物交接 E2E 里由 A 产出文档产物（mock 只在声明了 expectedOutputs 时才写）
    toolNames: ['write_artifact'],
  },
  {
    id: 'ag_e2e_worker_b',
    name: 'E2E Worker B',
    avatar: '🅱️',
    description: 'E2E 测试专用 mock 子 agent B',
    capabilities: ['test'],
    toolNames: [],
  },
]

/**
 * E2E 全局准备：建一个隔离的测试库（不碰真实 .agenthub-data），
 * 自动建表 + seed 内置 agent，并插入 mock adapter 测试 agent。
 *
 * mock agent 只能直接写 DB —— 创建 agent 的 API（zod）禁止 adapter_name='mock'。
 * better-sqlite3 须为当前 Node ABI（e2e 脚本前置 ensure-node-sqlite 保证）。
 */
export default function globalSetup() {
  // 数据目录已由 playwright.config 的 webServer 命令在启动 dev server 之前清掉。
  // 这里不能再 rmSync：dev server 已经起来并持有 SQLite 句柄（Windows 上会 EPERM）。
  mkdirSync(path.join(E2E_DATA_DIR, 'workspaces'), { recursive: true })

  const sqlite = new Database(path.join(E2E_DATA_DIR, 'agenthub.db'))
  try {
    bootstrapDatabase(sqlite)
    const insert = sqlite.prepare(
      `INSERT INTO agents (
         id, name, avatar, description, capabilities, system_prompt,
         adapter_name, model_provider, model_id, api_key, api_base_url,
         tool_names, is_builtin, is_orchestrator, supports_vision, created_at
       ) VALUES (
         @id, @name, @avatar, @description, @capabilities, @system_prompt,
         @adapter_name, @model_provider, @model_id, @api_key, @api_base_url,
         @tool_names, @is_builtin, @is_orchestrator, @supports_vision, @created_at
       )`,
    )
    for (const agent of SEED_AGENTS) {
      insert.run({
        id: agent.id,
        name: agent.name,
        avatar: agent.avatar,
        description: agent.description,
        capabilities: JSON.stringify(agent.capabilities),
        system_prompt: 'mock',
        adapter_name: 'mock',
        model_provider: null,
        model_id: null,
        api_key: null,
        api_base_url: null,
        tool_names: JSON.stringify(agent.toolNames),
        is_builtin: 0,
        is_orchestrator: agent.isOrchestrator ? 1 : 0,
        supports_vision: 0,
        created_at: Date.now(),
      })
    }
  } finally {
    sqlite.close()
  }
}
