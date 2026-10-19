import { describe, expect, it } from 'vitest'

import {
  AGENT_EXPORT_FORMAT,
  AGENT_EXPORT_VERSION,
  agentExportFileName,
  buildAgentExport,
  parseAgentExport,
  type ExportableAgent,
} from './agent-export'

const customAgent: ExportableAgent = {
  name: 'TestBot',
  avatar: '🧪',
  description: 'Runs tests',
  capabilities: ['testing', 'vitest'],
  systemPrompt: 'You are a test bot.',
  adapterName: 'custom',
  modelProvider: 'deepseek',
  modelId: 'deepseek-v4-flash',
  toolNames: ['fs_read', 'web_fetch'],
  supportsVision: true,
}

describe('buildAgentExport', () => {
  it('exports only shareable fields', () => {
    const file = buildAgentExport({
      ...customAgent,
      // Extra row fields are ignored by the structural type at runtime.
      ...({ apiKey: 'secret', apiBaseUrl: 'https://internal.example', id: 'ag_1', mcpServerIds: ['mcp_1'] } as object),
    })
    expect(file.format).toBe(AGENT_EXPORT_FORMAT)
    expect(file.version).toBe(AGENT_EXPORT_VERSION)
    expect(file.agent.name).toBe('TestBot')
    expect(file.agent.adapterName).toBe('custom')
    expect(file.agent.modelProvider).toBe('deepseek')
    expect(file.agent.modelId).toBe('deepseek-v4-flash')
    expect(JSON.stringify(file)).not.toContain('secret')
    expect(JSON.stringify(file)).not.toContain('apiKey')
    expect(JSON.stringify(file)).not.toContain('apiBaseUrl')
    expect(JSON.stringify(file)).not.toContain('mcp_1')
    expect(JSON.stringify(file)).not.toContain('ag_1')
  })

  it('drops tool names the builder cannot offer', () => {
    const file = buildAgentExport({ ...customAgent, toolNames: ['fs_read', 'plan_tasks', 'web_fetch'] })
    expect(file.agent.toolNames).toEqual(['fs_read', 'web_fetch'])
  })

  it('omits provider and model for SDK agents', () => {
    const file = buildAgentExport({
      ...customAgent,
      adapterName: 'claude-code',
      modelProvider: null,
      modelId: null,
      toolNames: [],
    })
    expect(file.agent.modelProvider).toBeUndefined()
    expect(file.agent.modelId).toBeUndefined()
  })

  it('rejects unsupported adapters', () => {
    expect(() => buildAgentExport({ ...customAgent, adapterName: 'mock' })).toThrow(/adapterName/)
  })
})

describe('parseAgentExport', () => {
  it('round-trips a built export', () => {
    const file = buildAgentExport(customAgent)
    expect(parseAgentExport(JSON.parse(JSON.stringify(file)))).toEqual(file)
  })

  it('applies defaults for optional fields', () => {
    const parsed = parseAgentExport({
      format: 'agenthub-agent',
      version: 1,
      agent: {
        name: 'Bot',
        description: 'desc',
        systemPrompt: 'prompt',
        adapterName: 'claude-code',
        toolNames: [],
      },
    })
    expect(parsed.agent.avatar).toBe('🤖')
    expect(parsed.agent.supportsVision).toBe(true)
    expect(parsed.agent.capabilities).toEqual([])
  })

  it.each([
    ['wrong format', { format: 'other', version: 1, agent: {} }, /format/],
    ['wrong version', { format: 'agenthub-agent', version: 2, agent: {} }, /version/],
    [
      'custom adapter without provider',
      {
        format: 'agenthub-agent',
        version: 1,
        agent: { ...customAgent, modelProvider: undefined },
      },
      /modelProvider/,
    ],
    [
      'custom adapter without model',
      {
        format: 'agenthub-agent',
        version: 1,
        agent: { ...customAgent, modelId: undefined },
      },
      /modelId/,
    ],
    [
      'unknown tool name',
      {
        format: 'agenthub-agent',
        version: 1,
        agent: { ...customAgent, toolNames: ['not_a_tool'] },
      },
      /toolNames/,
    ],
    [
      'unknown adapter',
      {
        format: 'agenthub-agent',
        version: 1,
        agent: { ...customAgent, adapterName: 'mock' },
      },
      /adapterName/,
    ],
    [
      'extra field',
      {
        format: 'agenthub-agent',
        version: 1,
        agent: { ...customAgent, apiKey: 'leaked' },
      },
      /apiKey|Unrecognized/,
    ],
  ])('rejects %s', (_label, raw, message) => {
    expect(() => parseAgentExport(raw)).toThrow(message)
  })
})

describe('agentExportFileName', () => {
  it('sanitizes the agent name', () => {
    expect(agentExportFileName('My Bot/Test')).toBe('agenthub-agent-My-Bot-Test.json')
    expect(agentExportFileName('   ')).toBe('agenthub-agent-agent.json')
  })
})
