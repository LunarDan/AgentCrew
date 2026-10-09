import { describe, expect, it } from 'vitest'

import { parseDispatchPlanToolArgs, validateDispatchPlan } from '@/server/dispatch-plan'
import {
  evaluateTaskResultReport,
  readTaskResultReportFromToolResult,
} from '@/server/task-result-report'
import type { DispatchPlanItem, StreamEvent } from '@/shared/types'

import { MockAdapter, parseAvailableAgents, parseDeclaredOutput, parseUpstreamArtifactId } from './mock-adapter'
import type { AdapterInput } from './types'

/**
 * 假 adapter 的编排能力（PLAN / 子任务报告 / AGGREGATE）是 e2e/dispatch.spec.ts 的地基：
 * 这里只盯住 AgentRunner 真正依赖的那几个契约点，改动被破坏时单元测试先报错。
 */

const PLAN_SYSTEM_PROMPT = [
  '你是项目经理。',
  '## 可用 Agent',
  '- { id: "ag_a", name: "前端", capabilities: ["frontend"], tools: ["fs_write"], description: "写前端页面" }',
  '- { id: "ag_b", name: "后端", capabilities: ["backend"], tools: ["fs_write"], description: "写后端接口" }',
].join('\n')

function baseInput(overrides: Partial<AdapterInput>): AdapterInput {
  return {
    agentId: 'ag_orch',
    conversationId: 'conv_test',
    runId: 'run_test',
    prompt: '做一个落地页',
    workspacePath: '/tmp/workspace',
    systemPrompt: 'mock',
    apiKey: null,
    apiBaseUrl: null,
    modelId: null,
    toolNames: [],
    ...overrides,
  }
}

async function collect(input: AdapterInput): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  const adapter = new MockAdapter()
  for await (const event of adapter.stream(input, new AbortController().signal)) {
    events.push(event)
  }
  return events
}

describe('MockAdapter plan 阶段', () => {
  it('按 system prompt 的可用 agent 列表发出一条合法 plan_tasks', async () => {
    const events = await collect(
      baseInput({ toolNames: ['plan_tasks'], systemPrompt: PLAN_SYSTEM_PROMPT }),
    )

    const toolCall = events.find((event) => event.type === 'tool.call')
    expect(toolCall).toBeDefined()
    if (toolCall?.type !== 'tool.call') throw new Error('expected a tool.call event')
    expect(toolCall.toolName).toBe('plan_tasks')

    const plan = parseDispatchPlanToolArgs(toolCall.args)
    expect(plan.map((task) => task.agentId)).toEqual(['ag_a', 'ag_b'])
    // code 任务会被要求提供构建/测试命令证据，假 agent 给不出 → mock 统一声明 doc
    expect(plan.every((task) => task.taskKind === 'doc')).toBe(true)
    // 真实编排路径会用同一份校验，plan 必须能过
    expect(() =>
      validateDispatchPlan(plan, [{ id: 'ag_a' }, { id: 'ag_b' }], 'ag_orch'),
    ).not.toThrow()

    // plan 被 AgentRunner 拦截后由它补 message.end，adapter 自己不能抢先发
    expect(events.some((event) => event.type === 'message.end')).toBe(false)
  })

  it('群里没有其他 agent 时只回复文本，不产出非法 plan', async () => {
    const events = await collect(
      baseInput({ toolNames: ['plan_tasks'], systemPrompt: '## 可用 Agent\n（无）' }),
    )

    expect(events.some((event) => event.type === 'tool.call')).toBe(false)
    expect(events.at(-1)?.type).toBe('message.end')
  })
})

describe('MockAdapter 子任务阶段', () => {
  it('发出能过完成门禁的 report_task_result', async () => {
    const events = await collect(
      baseInput({ agentId: 'ag_a', toolNames: ['report_task_result'] }),
    )

    const toolResult = events.find((event) => event.type === 'tool.result')
    expect(toolResult).toBeDefined()
    if (toolResult?.type !== 'tool.result') throw new Error('expected a tool.result event')

    const report = readTaskResultReportFromToolResult(toolResult.result)
    expect(report?.status).toBe('complete')

    const task: DispatchPlanItem = { id: 't1', agentId: 'ag_a', taskKind: 'doc', task: '整理要点' }
    expect(evaluateTaskResultReport(task, report ?? undefined).ok).toBe(true)
  })
})

describe('MockAdapter aggregate 阶段', () => {
  it('聚合阶段不再发工具调用，只给一条总结', async () => {
    const events = await collect(
      baseInput({
        systemPrompt: 'mock\n\n## 当前阶段\n你处于「聚合阶段」。所有子任务已执行完成。',
      }),
    )

    expect(events.some((event) => event.type === 'tool.call')).toBe(false)
    expect(events.at(-1)?.type).toBe('message.end')
  })
})

describe('MockAdapter 普通 run', () => {
  it('agent 没有 write_artifact 时不冒充产出产物', async () => {
    const events = await collect(baseInput({ prompt: '生成一份 PPT 产物', toolNames: [] }))

    expect(events.some((event) => event.type === 'artifact.create')).toBe(false)
    expect(
      events.some((event) => event.type === 'tool.call' && event.toolName === 'write_artifact'),
    ).toBe(false)
  })
})

describe('parseAvailableAgents', () => {
  it('忽略没有 agent 的列表', () => {
    expect(parseAvailableAgents('## 可用 Agent\n（无）')).toEqual([])
  })
})

describe('MockAdapter 产物交接', () => {
  it('计划里出现「交接」时发一条带 expectedOutputs / inputs 的交接链', async () => {
    const events = await collect(
      baseInput({
        toolNames: ['plan_tasks'],
        systemPrompt: PLAN_SYSTEM_PROMPT,
        prompt: '用产物交接的方式推进：写一份方案',
      }),
    )

    const toolCall = events.find((event) => event.type === 'tool.call')
    if (toolCall?.type !== 'tool.call') throw new Error('expected a tool.call event')
    const plan = parseDispatchPlanToolArgs(toolCall.args)

    expect(plan[0].expectedOutputs).toEqual([
      { id: 'doc', type: 'document', required: true },
    ])
    expect(plan[1].dependsOn).toEqual(['t1'])
    expect(plan[1].inputs).toEqual([{ fromTaskId: 't1', outputId: 'doc', required: true }])
    expect(() =>
      validateDispatchPlan(plan, [{ id: 'ag_a' }, { id: 'ag_b' }], 'ag_orch'),
    ).not.toThrow()
  })

  it('没有 write_artifact 的子 agent 不写产物，但仍报 complete', async () => {
    const events = await collect(
      baseInput({
        agentId: 'ag_b',
        toolNames: ['report_task_result'],
        prompt: '<expected_outputs>\n    <output id="doc" type="document" required="true" />\n</expected_outputs>',
      }),
    )

    expect(events.some((event) => event.type === 'artifact.create')).toBe(false)
    const toolResult = events.find((event) => event.type === 'tool.result')
    if (toolResult?.type !== 'tool.result') throw new Error('expected a tool.result event')
    expect(readTaskResultReportFromToolResult(toolResult.result)?.status).toBe('complete')
  })

  it('收到上游产物时在回复里回显 artifactId', async () => {
    const events = await collect(
      baseInput({
        agentId: 'ag_b',
        toolNames: ['report_task_result'],
        prompt: '<required_inputs>\n    <input fromTaskId="t1" outputId="doc" required="true" artifactId="art_abc" />\n</required_inputs>',
      }),
    )

    const text = events
      .filter((event) => event.type === 'part.delta')
      .map((event) => (event.type === 'part.delta' ? event.delta.text : ''))
      .join('')
    expect(text).toContain('art_abc')
  })
})

describe('子任务 prompt 契约解析', () => {
  it('读取非 project 的 expected output', () => {
    expect(parseDeclaredOutput('<output id="doc" type="document" required="true" />')).toEqual({
      id: 'doc',
      type: 'document',
    })
  })

  it('project 产物由系统创建，mock 不代写', () => {
    expect(parseDeclaredOutput('<output id="project" type="project" required="true" />')).toBeNull()
    expect(parseDeclaredOutput('<context></context>')).toBeNull()
  })

  it('从 required_inputs 里取上游 artifactId', () => {
    expect(parseUpstreamArtifactId('<input fromTaskId="t1" artifactId="art_x" />')).toBe('art_x')
    expect(parseUpstreamArtifactId('<artifact id="art_x" type="document" />')).toBeNull()
  })
})
