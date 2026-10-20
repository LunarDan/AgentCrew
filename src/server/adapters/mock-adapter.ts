import { eq } from 'drizzle-orm'

import { db, schema } from '@/db/client'
import { PLAN_TASKS_TOOL_NAME } from '@/server/dispatch-plan'
import { newMessageId, newToolCallId } from '@/server/ids'
import { REPORT_TASK_RESULT_TOOL_NAME } from '@/server/task-result-report'
import { toolRegistry } from '@/server/tools/registry'
import type { ToolContext } from '@/server/tools/types'
import type { ArtifactRecord, MessagePart, PartDelta, StreamEvent } from '@/shared/types'

import type { AdapterInput, AgentPlatformAdapter } from './types'

/**
 * MockAdapter — 不调用任何真实 LLM，按预设脚本吐流式事件。
 *
 * 用途：
 *   1. 开发期不烧 token
 *   2. 端到端骨架验证（SSE / store / UI 渲染）
 *   3. 演示环境备份
 *   4. Playwright E2E 的确定性假 agent（产物 / 编排场景，见 e2e/）
 *
 * 行为：
 *   - 普通 run：按 prompt 关键词选脚本，字符级流式（还原真实体感）
 *   - 产物场景：真调 write_artifact（经 toolRegistry）——产物真落库，再发 artifact.create，
 *     上层才会注入 artifact_ref part。该 agent 的 tool_names 需含 write_artifact 才触发。
 *   - Orchestrator 三阶段：PLAN 阶段按 system prompt 的可用 agent 列表发 plan_tasks；
 *     子任务（tool_names 含 report_task_result）发一次 complete 报告；AGGREGATE 阶段直接给总结。
 *   - 支持 AbortSignal
 */
export class MockAdapter implements AgentPlatformAdapter {
  readonly name = 'mock' as const

  async *stream(input: AdapterInput, signal: AbortSignal): AsyncIterable<StreamEvent> {
    // Orchestrator 的三条路径由 toolNames / systemPrompt 区分，不依赖用户措辞。
    if (input.toolNames.includes(PLAN_TASKS_TOOL_NAME)) {
      yield* streamPlanStage(input, signal)
      return
    }
    if (input.systemPrompt.includes(AGGREGATE_STAGE_MARKER)) {
      yield* streamAggregateStage(input, signal)
      return
    }
    if (input.toolNames.includes(REPORT_TASK_RESULT_TOOL_NAME)) {
      yield* streamChildTask(input, signal)
      return
    }
    yield* streamScriptedRun(input, signal)
  }
}

/** 聚合阶段 system prompt 里的稳定标记（由 buildOrchestratorAggregatePrompt 注入）。 */
const AGGREGATE_STAGE_MARKER = '你处于「聚合阶段」'
const WRITE_ARTIFACT_TOOL_NAME = 'write_artifact'

/** 交接 key：mock 约定下游任务消费名为 doc 的文档产物。 */
const HANDOFF_OUTPUT_ID = 'doc'
const HANDOFF_PROMPT_PATTERN = /(交接|handoff)/i

/** 普通 run：按关键词脚本流式播放。 */
async function* streamScriptedRun(
  input: AdapterInput,
  signal: AbortSignal,
): AsyncIterable<StreamEvent> {
  const script = pickScript(input.prompt, input.toolNames)
  const messageId = newMessageId()
  const ctx: ToolContext = {
    conversationId: input.conversationId,
    workspacePath: input.workspacePath,
    agentId: input.agentId,
    runId: input.runId,
    abortSignal: signal,
  }

  yield {
    type: 'message.start',
    conversationId: input.conversationId,
    timestamp: Date.now(),
    messageId,
    agentId: input.agentId,
    runId: input.runId,
  }

  let partIndex = -1

  for (const step of script) {
    if (signal.aborted) break

    if (step.kind === 'text' || step.kind === 'thinking' || step.kind === 'code') {
      partIndex++
      yield* streamPart(input, messageId, partIndex, step, signal)
    } else if (step.kind === 'tool') {
      const callId = newToolCallId()
      yield {
        type: 'tool.call',
        conversationId: input.conversationId,
        timestamp: Date.now(),
        messageId,
        callId,
        toolName: step.toolName,
        args: step.args,
      }
      await sleep(300)
      yield {
        type: 'tool.result',
        conversationId: input.conversationId,
        timestamp: Date.now(),
        messageId,
        callId,
        result: step.result ?? { ok: true },
        isError: false,
      }
    } else if (step.kind === 'tool_exec') {
      yield* executeToolStep(input, messageId, step, ctx)
    }
  }

  if (signal.aborted) return

  yield {
    type: 'message.end',
    conversationId: input.conversationId,
    timestamp: Date.now(),
    messageId,
  }
}

/** 真执行一个工具：产物场景靠它落库，否则消息里只会出现假的 tool_result。 */
async function* executeToolStep(
  input: AdapterInput,
  messageId: string,
  step: Extract<ScriptStep, { kind: 'tool_exec' }>,
  ctx: ToolContext,
): AsyncIterable<StreamEvent> {
  const callId = newToolCallId()

  yield {
    type: 'tool.call',
    conversationId: input.conversationId,
    timestamp: Date.now(),
    messageId,
    callId,
    toolName: step.toolName,
    args: step.args,
  }

  const result = await toolRegistry.execute(step.toolName, step.args, ctx)
  const value = result.ok ? result.value : { error: result.error }

  yield {
    type: 'tool.result',
    conversationId: input.conversationId,
    timestamp: Date.now(),
    messageId,
    callId,
    result: value,
    isError: !result.ok,
  }

  // 与 CustomAgentAdapter 约定一致：工具结果含 artifactId → adapter 统一发 artifact.create。
  if (step.toolName !== WRITE_ARTIFACT_TOOL_NAME || !result.ok) return
  const artifact = await loadArtifactRecord(value)
  if (!artifact) return

  yield {
    type: 'artifact.create',
    conversationId: input.conversationId,
    timestamp: Date.now(),
    artifact,
  }
}

/**
 * PLAN 阶段：从 plan system prompt 的「可用 Agent」列表取真实 id，发一次 plan_tasks。
 *
 * AgentRunner 会拦截这次 tool.call 并停流（tool.result / message.end 由它补齐），
 * 所以这里 yield 完 plan_tasks 就结束，不要自己发 message.end。
 */
async function* streamPlanStage(
  input: AdapterInput,
  signal: AbortSignal,
): AsyncIterable<StreamEvent> {
  const messageId = newMessageId()

  yield {
    type: 'message.start',
    conversationId: input.conversationId,
    timestamp: Date.now(),
    messageId,
    agentId: input.agentId,
    runId: input.runId,
  }

  const agents = parseAvailableAgents(input.systemPrompt)
  if (agents.length === 0) {
    yield* streamPart(input, messageId, 0, { kind: 'text', content: NO_TEAMMATE_REPLY }, signal)
    if (signal.aborted) return
    yield {
      type: 'message.end',
      conversationId: input.conversationId,
      timestamp: Date.now(),
      messageId,
    }
    return
  }

  const request = summarizeRequest(input.prompt)

  yield* streamPart(
    input,
    messageId,
    0,
    { kind: 'text', content: `收到，我把「${request}」拆成 ${agents.length} 个任务：` },
    signal,
  )

  yield {
    type: 'tool.call',
    conversationId: input.conversationId,
    timestamp: Date.now(),
    messageId,
    callId: newToolCallId(),
    toolName: PLAN_TASKS_TOOL_NAME,
    args: { tasks: buildPlanTasks(agents, request) },
  }
}

/**
 * 默认发并行任务；请求里出现「交接 / handoff」时改发一条产物交接链
 * （t1 产出文档产物 → 其余任务依赖并消费它），用于覆盖 expectedOutputs / inputs 契约。
 *
 * 统一声明 taskKind='doc'：假 agent 不跑构建 / 测试，
 * 声明成 code 会命中「必须有验证命令证据」的完成门禁而必然失败。
 */
function buildPlanTasks(agents: Array<{ id: string }>, request: string): unknown[] {
  if (agents.length >= 2 && HANDOFF_PROMPT_PATTERN.test(request)) {
    const [producer, ...consumers] = agents
    return [
      {
        id: 't1',
        agentId: producer.id,
        taskKind: 'doc',
        task: `围绕「${request}」产出可交接的文档产物。`,
        expectedOutputs: [{ id: HANDOFF_OUTPUT_ID, type: 'document', required: true }],
      },
      ...consumers.map((agent, index) => ({
        id: `t${index + 2}`,
        agentId: agent.id,
        taskKind: 'doc',
        task: `消费上游产物，给出「${request}」你负责部分的结论。`,
        dependsOn: ['t1'],
        inputs: [{ fromTaskId: 't1', outputId: HANDOFF_OUTPUT_ID, required: true }],
      })),
    ]
  }

  return agents.map((agent, index) => ({
    id: `t${index + 1}`,
    agentId: agent.id,
    taskKind: 'doc',
    task: `围绕「${request}」完成你负责的部分，并给出明确结论。`,
  }))
}

const NO_TEAMMATE_REPLY =
  '这个群里除了我没有别的 agent，没有可以分派的对象。请把我加进一个多 agent 群聊，或直接告诉我要做什么。'

/** 子任务：报一次 complete，否则 AgentRunner 的完成门禁会判 failed 并重试。 */
async function* streamChildTask(
  input: AdapterInput,
  signal: AbortSignal,
): AsyncIterable<StreamEvent> {
  const messageId = newMessageId()
  const ctx: ToolContext = {
    conversationId: input.conversationId,
    workspacePath: input.workspacePath,
    agentId: input.agentId,
    runId: input.runId,
    abortSignal: signal,
  }
  // 上游产物经 <required_inputs artifactId="art_x"> 注入，回显它才能断言交接真的通了。
  const upstreamArtifactId = parseUpstreamArtifactId(input.prompt)
  const summary = upstreamArtifactId
    ? `Mock 子任务已完成，上游产物 ${upstreamArtifactId} 已收到。`
    : 'Mock 子任务已完成分派内容（确定性假执行，不调用真实模型）。'

  yield {
    type: 'message.start',
    conversationId: input.conversationId,
    timestamp: Date.now(),
    messageId,
    agentId: input.agentId,
    runId: input.runId,
  }

  yield* streamPart(input, messageId, 0, { kind: 'text', content: summary }, signal)

  // 任务声明了非 project 产物 → 按子 Agent 提示词的要求真写一份并带上 outputKey，
  // 这样下游任务的 <required_inputs> 才能解析出 artifactId。
  const declaredOutput = parseDeclaredOutput(input.prompt)
  if (declaredOutput && input.toolNames.includes(WRITE_ARTIFACT_TOOL_NAME)) {
    yield* executeToolStep(
      input,
      messageId,
      {
        kind: 'tool_exec',
        toolName: WRITE_ARTIFACT_TOOL_NAME,
        args: buildHandoffArtifactArgs(declaredOutput),
      },
      ctx,
    )
  }

  const callId = newToolCallId()
  yield {
    type: 'tool.call',
    conversationId: input.conversationId,
    timestamp: Date.now(),
    messageId,
    callId,
    toolName: REPORT_TASK_RESULT_TOOL_NAME,
    args: { status: 'complete', summary },
  }
  yield {
    type: 'tool.result',
    conversationId: input.conversationId,
    timestamp: Date.now(),
    messageId,
    callId,
    result: { ok: true, value: { status: 'complete', summary } },
    isError: false,
  }

  if (signal.aborted) return
  yield {
    type: 'message.end',
    conversationId: input.conversationId,
    timestamp: Date.now(),
    messageId,
  }
}

/** AGGREGATE 阶段：不再分派，直接给一句可断言的总结。 */
async function* streamAggregateStage(
  input: AdapterInput,
  signal: AbortSignal,
): AsyncIterable<StreamEvent> {
  const messageId = newMessageId()

  yield {
    type: 'message.start',
    conversationId: input.conversationId,
    timestamp: Date.now(),
    messageId,
    agentId: input.agentId,
    runId: input.runId,
  }
  yield* streamPart(
    input,
    messageId,
    0,
    {
      kind: 'text',
      content: '编排完成：子任务已按计划执行完毕，各任务状态见上方调度卡。',
    },
    signal,
  )
  if (signal.aborted) return
  yield {
    type: 'message.end',
    conversationId: input.conversationId,
    timestamp: Date.now(),
    messageId,
  }
}

async function loadArtifactRecord(value: unknown): Promise<ArtifactRecord | null> {
  if (value === null || typeof value !== 'object') return null
  const artifactId = (value as { artifactId?: unknown }).artifactId
  if (typeof artifactId !== 'string') return null

  const row = await db.query.artifacts.findFirst({ where: eq(schema.artifacts.id, artifactId) })
  if (!row) return null
  return {
    id: row.id,
    conversationId: row.conversationId,
    type: row.type,
    title: row.title,
    content: row.content,
    version: row.version,
    parentArtifactId: row.parentArtifactId ?? undefined,
    createdByAgentId: row.createdByAgentId,
    createdAt: row.createdAt,
  }
}

/** 从 buildOrchestratorPlanPrompt 的「## 可用 Agent」列表里取 id / name。 */
export function parseAvailableAgents(systemPrompt: string): Array<{ id: string; name: string }> {
  const agents: Array<{ id: string; name: string }> = []
  const pattern = /^- \{ id: "([^"]+)", name: "([^"]+)"/gm
  for (const match of systemPrompt.matchAll(pattern)) {
    agents.push({ id: match[1], name: match[2] })
  }
  return agents
}

/** plan 任务文案里回显用户请求（只取首行，避免把 XML 上下文塞进任务描述）。 */
function summarizeRequest(prompt: string): string {
  const firstLine = prompt.split('\n').find((line) => line.trim().length > 0)?.trim() ?? prompt.trim()
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine
}

/** 子任务 prompt 里 `<output id="doc" type="document" required="true" />` —— project 由系统建，不写。 */
export function parseDeclaredOutput(prompt: string): { id: string; type: string } | null {
  const match = /<output id="([^"]+)" type="([^"]+)"/.exec(prompt)
  if (!match || match[2] === 'project') return null
  return { id: match[1], type: match[2] }
}

/** 子任务 prompt 里 `<input ... artifactId="art_x" />` —— 上游产物已解析并注入。 */
export function parseUpstreamArtifactId(prompt: string): string | null {
  return /artifactId="([^"]+)"/.exec(prompt)?.[1] ?? null
}

function buildHandoffArtifactArgs(output: { id: string; type: string }): unknown {
  return {
    // mock 只会写文档产物；声明了别的类型时也按文档交付（假 adapter 的已知简化）。
    type: 'document',
    title: `Mock 交接产物 ${output.id}`,
    outputKey: output.id,
    content: {
      format: 'markdown',
      content: `# 交接产物 ${output.id}\n\n本文件由 MockAdapter 生成，用于验证 Orchestrator 的产物交接链路（声明类型：${output.type}）。`,
    },
  }
}

// ─── 流式 part 输出 ───────────────────────────────────────
type PartStep = Extract<ScriptStep, { kind: 'text' | 'thinking' | 'code' }>

const PART_STREAM_CONFIG: Record<PartStep['kind'], { chunk: number; delayMs: number }> = {
  text: { chunk: 4, delayMs: 20 },
  thinking: { chunk: 8, delayMs: 15 },
  code: { chunk: 8, delayMs: 15 },
}

async function* streamPart(
  input: AdapterInput,
  messageId: string,
  partIndex: number,
  step: PartStep,
  signal: AbortSignal,
): AsyncIterable<StreamEvent> {
  const part: MessagePart =
    step.kind === 'code'
      ? { type: 'code', language: step.language, content: '' }
      : { type: step.kind, content: '' }

  yield {
    type: 'part.start',
    conversationId: input.conversationId,
    timestamp: Date.now(),
    messageId,
    partIndex,
    part,
  }

  const { chunk, delayMs } = PART_STREAM_CONFIG[step.kind]
  for (const piece of chunkText(step.content, chunk)) {
    if (signal.aborted) break
    await sleep(delayMs)
    yield {
      type: 'part.delta',
      conversationId: input.conversationId,
      timestamp: Date.now(),
      messageId,
      partIndex,
      delta: { type: appendDeltaType(step.kind), text: piece },
    }
  }

  yield {
    type: 'part.end',
    conversationId: input.conversationId,
    timestamp: Date.now(),
    messageId,
    partIndex,
  }
}

function appendDeltaType(kind: PartStep['kind']): PartDelta['type'] {
  if (kind === 'code') return 'code.append'
  if (kind === 'thinking') return 'thinking.append'
  return 'text.append'
}

// ─── 脚本类型 ─────────────────────────────────────────────
type ScriptStep =
  | { kind: 'text'; content: string }
  | { kind: 'thinking'; content: string }
  | { kind: 'code'; language: string; content: string }
  | { kind: 'tool'; toolName: string; args: unknown; result?: unknown }
  /** 真执行（经 toolRegistry）：只有它能产出真产物 / 真副作用。 */
  | { kind: 'tool_exec'; toolName: string; args: unknown }

// ─── 内置脚本 ─────────────────────────────────────────────
const GREETING_SCRIPT: ScriptStep[] = [
  { kind: 'thinking', content: '用户在问候，我应该礼貌回应并介绍自己。' },
  {
    kind: 'text',
    content:
      '你好！我是 Mock Agent，目前用于验证 AgentHub 的端到端骨架。我会按预设脚本流式回复，不消耗任何 LLM token。\n\n你可以试试输入「写代码」、「生成一份 PPT 产物」或「执行任务」看其他场景。',
  },
]

const CODE_SCRIPT: ScriptStep[] = [
  { kind: 'thinking', content: '用户希望看到代码示例，我演示一段 React 组件代码。' },
  { kind: 'text', content: '好的，这是一个简单的 React 计数器组件：' },
  {
    kind: 'code',
    language: 'tsx',
    content: `import { useState } from 'react'

export function Counter() {
  const [count, setCount] = useState(0)
  return (
    <div className="flex items-center gap-2">
      <button onClick={() => setCount(c => c - 1)}>-</button>
      <span>{count}</span>
      <button onClick={() => setCount(c => c + 1)}>+</button>
    </div>
  )
}`,
  },
  { kind: 'text', content: '这是最朴素的实现。需要扩展可以告诉我（持久化、键盘快捷键等）。' },
]

const TOOL_SCRIPT: ScriptStep[] = [
  { kind: 'thinking', content: '我需要演示工具调用流程。' },
  { kind: 'text', content: '我先调用工具收集信息：' },
  {
    kind: 'tool',
    toolName: 'read_artifact',
    args: { artifactId: 'art_demo' },
    result: { title: '示例产物', size: 1024 },
  },
  { kind: 'text', content: '已读取产物信息。这只是脚本演示，真实工具会在后续 milestone 接入。' },
]

/** 产物场景：真调 write_artifact，产出可预览 / 可导出的 PPT。 */
const ARTIFACT_SCRIPT: ScriptStep[] = [
  { kind: 'thinking', content: '用户想要可视产物，我用 write_artifact 直接产出一份 PPT。' },
  { kind: 'text', content: '我来生成一份 PPT 产物：' },
  {
    kind: 'tool_exec',
    toolName: 'write_artifact',
    args: {
      type: 'ppt',
      title: 'Mock PPT 演示',
      content: {
        title: 'Mock PPT 演示',
        slides: [
          { title: 'Mock PPT 演示', subtitle: 'MockAdapter 产物场景', layout: 'title' },
          {
            title: '这条链路覆盖了什么',
            blocks: [
              {
                type: 'bullets',
                items: [
                  'write_artifact 真落库（产物进 artifacts 表）',
                  'artifact.create 事件 → 消息里出现产物卡片',
                  '预览面板可渲染幻灯片，可导出真 .pptx',
                ],
              },
            ],
          },
        ],
      },
    },
  },
  { kind: 'text', content: '产物已生成，点上方卡片即可预览，右上角可下载 .pptx。' },
]

/**
 * 超长内容场景：一页塞进远超画布的要点，用于回归「本页内容超出画布」提示。
 * 只给一个 block 也能撑爆；标题与要点都写成可识别的固定文案，e2e 直接断言。
 */
const LONG_SLIDE_SCRIPT: ScriptStep[] = [
  { kind: 'text', content: '我来生成一份内容超长的 PPT，用来验证溢出提示：' },
  {
    kind: 'tool_exec',
    toolName: 'write_artifact',
    args: {
      type: 'ppt',
      title: '超长幻灯片演示',
      content: {
        title: '超长幻灯片演示',
        slides: [
          { title: '超长幻灯片演示', subtitle: '溢出提示回归', layout: 'title' },
          {
            title: '一页塞不下这么多内容',
            blocks: [
              {
                type: 'bullets',
                items: Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 条：这条要点用于把画布撑满并溢出`),
              },
            ],
          },
        ],
      },
    },
  },
  { kind: 'text', content: '生成完毕，第二页应显示溢出提示。' },
]

const DEFAULT_SCRIPT: ScriptStep[] = [
  { kind: 'thinking', content: '收到了用户消息，按通用模板回应。' },
  {
    kind: 'text',
    content:
      '我收到了你的消息。这是 MockAdapter 的默认响应，用于验证消息流式渲染、part 切换、tool 调用等链路。\n\n试试输入 "你好"、"写代码"、"生成一份 PPT 产物" 或 "执行任务" 触发不同脚本。',
  },
]

const ARTIFACT_PROMPT_PATTERN = /(产物|artifact|ppt|幻灯片)/i
/** 长文本场景：用于回归「幻灯片内容超出画布」提示（e2e + 手工检查）。 */
const LONG_SLIDE_PROMPT_PATTERN = /(超长|溢出|long slide|overflow)/i

function pickScript(prompt: string, toolNames: readonly string[]): ScriptStep[] {
  const p = prompt.toLowerCase()
  // 产物脚本要真调 write_artifact，没有该工具的 agent 不冒充能产出产物。
  const canWriteArtifact = toolNames.includes(WRITE_ARTIFACT_TOOL_NAME)
  if (LONG_SLIDE_PROMPT_PATTERN.test(p) && canWriteArtifact) {
    return LONG_SLIDE_SCRIPT
  }
  if (ARTIFACT_PROMPT_PATTERN.test(p) && canWriteArtifact) {
    return ARTIFACT_SCRIPT
  }
  if (/(你好|hello|hi|您好)/.test(p)) return GREETING_SCRIPT
  if (/(写代码|代码|code|component|组件)/.test(p)) return CODE_SCRIPT
  if (/(执行|工具|tool|run|跑)/.test(p)) return TOOL_SCRIPT
  return DEFAULT_SCRIPT
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size))
  }
  return chunks
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
