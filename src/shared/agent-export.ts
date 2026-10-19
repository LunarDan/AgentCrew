import { z } from 'zod'

import { AVAILABLE_AGENT_TOOLS, normalizeAgentToolNames } from './agent-builder-config'

export const AGENT_EXPORT_FORMAT = 'agenthub-agent'
export const AGENT_EXPORT_VERSION = 1

const ProviderSchema = z.enum(['anthropic', 'openai', 'deepseek', 'volcano-ark', 'openai-compatible'])
const AdapterSchema = z.enum(['custom', 'claude-code', 'codex'])
const ToolNameSchema = z.enum(AVAILABLE_AGENT_TOOLS)

export const AgentExportSchema = z
  .object({
    format: z.literal(AGENT_EXPORT_FORMAT),
    version: z.literal(AGENT_EXPORT_VERSION),
    agent: z
      .object({
        name: z.string().trim().min(1).max(64),
        avatar: z.string().max(8).default('🤖'),
        description: z.string().trim().min(1).max(280),
        capabilities: z.array(z.string().trim().min(1)).default([]),
        systemPrompt: z.string().min(1),
        adapterName: AdapterSchema,
        modelProvider: ProviderSchema.optional(),
        modelId: z.string().min(1).optional(),
        toolNames: z.array(ToolNameSchema).default([]),
        supportsVision: z.boolean().default(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.agent.adapterName !== 'custom') return
    if (!value.agent.modelProvider) {
      ctx.addIssue({
        code: 'custom',
        path: ['agent', 'modelProvider'],
        message: 'custom adapter requires modelProvider',
      })
    }
    if (!value.agent.modelId) {
      ctx.addIssue({
        code: 'custom',
        path: ['agent', 'modelId'],
        message: 'custom adapter requires modelId',
      })
    }
  })

export type AgentExportFile = z.infer<typeof AgentExportSchema>
export type AgentExportAgent = AgentExportFile['agent']

export interface ExportableAgent {
  name: string
  avatar: string
  description: string
  capabilities: string[]
  systemPrompt: string
  /** AgentRow 的 AdapterName 含 'mock'；不支持的 adapter 会被 schema 拒绝。 */
  adapterName: string
  modelProvider?: string | null
  modelId?: string | null
  toolNames: string[]
  supportsVision: boolean
}

/** 只导出可分享字段；apiKey / apiBaseUrl / id / mcpServerIds 永远不出现。 */
export function buildAgentExport(agent: ExportableAgent): AgentExportFile {
  const payload = {
    format: AGENT_EXPORT_FORMAT,
    version: AGENT_EXPORT_VERSION,
    agent: {
      name: agent.name,
      avatar: agent.avatar || '🤖',
      description: agent.description,
      capabilities: agent.capabilities,
      systemPrompt: agent.systemPrompt,
      adapterName: agent.adapterName,
      ...(agent.adapterName === 'custom' && agent.modelProvider
        ? { modelProvider: agent.modelProvider }
        : {}),
      ...(agent.modelId ? { modelId: agent.modelId } : {}),
      toolNames: normalizeAgentToolNames(agent.toolNames),
      supportsVision: agent.supportsVision,
    },
  }
  return AgentExportSchema.parse(payload)
}

export function parseAgentExport(raw: unknown): AgentExportFile {
  const parsed = AgentExportSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  const path = issue && issue.path.length > 0 ? issue.path.join('.') : 'root'
  throw new Error(`Invalid Agent config (${path}): ${issue?.message ?? 'unknown error'}`)
}

export function agentExportFileName(name: string): string {
  const slug =
    name
      .trim()
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent'
  return `agenthub-agent-${slug}.json`
}
