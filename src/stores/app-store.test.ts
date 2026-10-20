import { beforeEach, describe, expect, it } from 'vitest'

import type { MessageRow } from '@/db/schema'
import type { DispatchPlanItem } from '@/shared/types'

import { selectDispatchForMessage, useAppStore } from './app-store'

const PLAN: DispatchPlanItem[] = [
  {
    id: 'task_frontend',
    agentId: 'ag_frontend',
    task: '实现页面调整',
  },
]

function resetStore(): void {
  useAppStore.setState({
    conversations: {},
    agents: {},
    messages: {},
    artifacts: {},
    messageIdsByConv: {},
    runsByConv: {},
    dispatchesByRunId: {},
    activeConversationId: null,
    previewArtifactId: null,
    fileExplorerOpen: false,
    openFilesByConv: {},
    activeTabByConv: {},
    replyTargetByConv: {},
    pendingQuoteForInput: null,
    pendingAttachmentsByConv: {},
    pendingWritesByConv: {},
    pendingBashCommandsByConv: {},
    pendingQuestionsByConv: {},
    unreadByConv: {},
    mobileSidebarOpen: false,
    highlightedMessageId: null,
    streamConnected: false,
    resyncNonce: 0,
    restoredRunIds: {},
  })
}

function agentMessage(id: string, runId: string, createdAt: number): MessageRow {
  return {
    id,
    conversationId: 'conv_1',
    role: 'agent',
    agentId: 'ag_orchestrator',
    parts: [],
    status: 'complete',
    parentMessageId: null,
    mentionedAgentIds: [],
    runId,
    usage: null,
    createdAt,
  }
}

describe('app-store dispatch plan binding', () => {
  beforeEach(() => {
    resetStore()
  })

  it('does not return the same dispatch for every message in the run', () => {
    useAppStore.setState({
      messages: {
        msg_plan: agentMessage('msg_plan', 'run_orch', 1),
        msg_extra: agentMessage('msg_extra', 'run_orch', 2),
      },
      dispatchesByRunId: {
        run_orch: {
          runId: 'run_orch',
          messageId: 'msg_plan',
          plan: PLAN,
          taskStatus: { task_frontend: 'pending' },
          childRunIds: {},
          reviewStatus: 'pending',
          pendingPlanId: 'pdp_1',
        },
      },
    })

    const state = useAppStore.getState()
    expect(selectDispatchForMessage(state, 'msg_plan')?.runId).toBe('run_orch')
    expect(selectDispatchForMessage(state, 'msg_extra')).toBeNull()
  })

  it('attaches a pending dispatch to the next message for that run', () => {
    useAppStore.getState().applyEvent({
      type: 'dispatch.plan.pending',
      conversationId: 'conv_1',
      timestamp: 1,
      pendingPlan: {
        id: 'pdp_1',
        conversationId: 'conv_1',
        agentId: 'ag_orchestrator',
        runId: 'run_orch',
        plan: PLAN,
        createdAt: 1,
      },
    })

    expect(useAppStore.getState().dispatchesByRunId.run_orch?.messageId).toBe('')

    useAppStore.getState().applyEvent({
      type: 'message.start',
      conversationId: 'conv_1',
      timestamp: 2,
      messageId: 'msg_plan',
      agentId: 'ag_orchestrator',
      runId: 'run_orch',
    })

    const state = useAppStore.getState()
    expect(state.dispatchesByRunId.run_orch?.messageId).toBe('msg_plan')
    expect(selectDispatchForMessage(state, 'msg_plan')?.pendingPlanId).toBe('pdp_1')
  })

  it('does not resurrect a plan that was resolved while the snapshot was in flight', () => {
    useAppStore.getState().applyEvent({
      type: 'dispatch.plan.pending',
      conversationId: 'conv_1',
      timestamp: 1,
      pendingPlan: {
        id: 'pdp_1',
        conversationId: 'conv_1',
        agentId: 'ag_orchestrator',
        runId: 'run_orch',
        plan: PLAN,
        createdAt: 1,
      },
    })
    useAppStore.getState().applyEvent({
      type: 'dispatch.plan.resolved',
      conversationId: 'conv_1',
      timestamp: 50,
      runId: 'run_orch',
      pendingId: 'pdp_1',
      approved: true,
    })

    // 快照在审批之前读出，响应在审批之后才到
    useAppStore.getState().setPendingDispatchPlansForConversation(
      'conv_1',
      [
        {
          id: 'pdp_1',
          conversationId: 'conv_1',
          agentId: 'ag_orchestrator',
          runId: 'run_orch',
          plan: PLAN,
          createdAt: 1,
        },
      ],
      ['pdp_1'],
      40,
    )

    const dispatch = useAppStore.getState().dispatchesByRunId.run_orch
    expect(dispatch?.reviewStatus).toBe('approved')
    expect(dispatch?.pendingPlanId).toBeUndefined()
  })
})

describe('app-store run failure cleanup', () => {
  beforeEach(() => {
    resetStore()
  })

  it('adds error results for unresolved tool calls when a run fails', () => {
    useAppStore.setState({
      messages: {
        msg_tool: {
          ...agentMessage('msg_tool', 'run_failed', 1),
          status: 'streaming',
          parts: [
            {
              type: 'tool_use',
              callId: 'call_bash',
              toolName: 'bash',
              args: { command: 'npm run dev' },
            },
          ],
        },
      },
      messageIdsByConv: { conv_1: ['msg_tool'] },
    })

    useAppStore.getState().applyEvent({
      type: 'run.end',
      conversationId: 'conv_1',
      timestamp: 2,
      runId: 'run_failed',
      status: 'failed',
      error: 'process exited with code 1',
    })

    const message = useAppStore.getState().messages.msg_tool
    expect(message.status).toBe('error')
    expect(message.parts).toContainEqual({
      type: 'tool_result',
      callId: 'call_bash',
      result: '工具调用未完成：本次运行失败。process exited with code 1',
      isError: true,
    })

    useAppStore.getState().applyEvent({
      type: 'tool.result',
      conversationId: 'conv_1',
      timestamp: 3,
      messageId: 'msg_tool',
      callId: 'call_bash',
      result: 'server fallback',
      isError: true,
    })

    const results = useAppStore
      .getState()
      .messages.msg_tool.parts.filter((part) => part.type === 'tool_result')
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      type: 'tool_result',
      callId: 'call_bash',
      result: 'server fallback',
      isError: true,
    })
  })

  it('does not duplicate existing tool results on aborted runs', () => {
    useAppStore.setState({
      messages: {
        msg_tool: {
          ...agentMessage('msg_tool', 'run_aborted', 1),
          status: 'streaming',
          parts: [
            {
              type: 'tool_use',
              callId: 'call_done',
              toolName: 'fs_read',
              args: { path: 'README.md' },
            },
            {
              type: 'tool_result',
              callId: 'call_done',
              result: 'ok',
              isError: false,
            },
          ],
        },
      },
      messageIdsByConv: { conv_1: ['msg_tool'] },
    })

    useAppStore.getState().applyEvent({
      type: 'run.end',
      conversationId: 'conv_1',
      timestamp: 2,
      runId: 'run_aborted',
      status: 'aborted',
    })

    const message = useAppStore.getState().messages.msg_tool
    expect(message.status).toBe('aborted')
    expect(message.parts.filter((part) => part.type === 'tool_result')).toHaveLength(1)
  })
})

describe('app-store message snapshot reconciliation', () => {
  beforeEach(() => { resetStore() })

  it('restores a running run from a streaming message and prunes it on the next snapshot', () => {
    useAppStore.getState().setMessagesForConversation('conv_1', [
      { ...agentMessage('msg_live', 'run_live', 10), status: 'streaming' },
    ])
    const running = useAppStore.getState().runsByConv.conv_1?.run_live
    expect(running?.status).toBe('running')

    // 下一次快照里该消息已 complete（run.end 在断线期间丢了）：重建的 run 要被清掉
    useAppStore.getState().setMessagesForConversation('conv_1', [
      agentMessage('msg_live', 'run_live', 10),
    ])
    expect(useAppStore.getState().runsByConv.conv_1?.run_live).toBeUndefined()
  })

  it('drops messages removed server-side but keeps local temp and streaming rows', () => {
    useAppStore.getState().upsertMessage(agentMessage('msg_stale', 'run_old', 1))
    useAppStore.getState().upsertMessage({ ...agentMessage('temp_1', 'run_new', 2) })
    useAppStore.getState().applyEvent({
      type: 'run.start',
      conversationId: 'conv_1',
      timestamp: 3,
      runId: 'run_new',
      agentId: 'ag_orchestrator',
      triggerMessageId: 'msg_trigger',
    })
    useAppStore.getState().applyEvent({
      type: 'message.start',
      conversationId: 'conv_1',
      timestamp: 3,
      messageId: 'msg_streaming',
      agentId: 'ag_orchestrator',
      runId: 'run_new',
    })

    useAppStore.getState().setMessagesForConversation('conv_1', [
      agentMessage('msg_kept', 'run_kept', 4),
    ])

    const state = useAppStore.getState()
    expect(state.messages.msg_stale).toBeUndefined()
    expect(state.messages.temp_1).toBeDefined()
    expect(state.messages.msg_streaming).toBeDefined()
    expect(state.messageIdsByConv.conv_1).toEqual([
      'msg_kept',
      'temp_1',
      'msg_streaming',
    ])
  })

  it('prunes an SSE-created run whose run.end was lost', () => {
    useAppStore.getState().applyEvent({
      type: 'run.start',
      conversationId: 'conv_1',
      timestamp: 100,
      runId: 'run_lost_end',
      agentId: 'ag_orchestrator',
      triggerMessageId: 'msg_trigger',
    })
    // 快照在请求发出后才返回，里面已经没有这个 run 的流式消息
    useAppStore.getState().setMessagesForConversation('conv_1', [], 200)
    expect(useAppStore.getState().runsByConv.conv_1?.run_lost_end).toBeUndefined()
  })

  it('keeps a run that started after the snapshot request was issued', () => {
    useAppStore.getState().applyEvent({
      type: 'run.start',
      conversationId: 'conv_1',
      timestamp: 300,
      runId: 'run_in_flight',
      agentId: 'ag_orchestrator',
      triggerMessageId: 'msg_trigger',
    })
    useAppStore.getState().setMessagesForConversation('conv_1', [], 200)
    expect(useAppStore.getState().runsByConv.conv_1?.run_in_flight?.status).toBe('running')
  })

  it('drops a streaming message the server no longer has', () => {
    useAppStore.getState().upsertMessage({
      ...agentMessage('msg_deleted_elsewhere', 'run_old', 10),
      status: 'streaming',
    })
    useAppStore.getState().setMessagesForConversation('conv_1', [], 20)
    expect(useAppStore.getState().messages.msg_deleted_elsewhere).toBeUndefined()
  })

  it('keeps a streaming message that arrived while the snapshot was in flight', () => {
    useAppStore.getState().upsertMessage({
      ...agentMessage('msg_arriving', 'run_new', 30),
      status: 'streaming',
    })
    useAppStore.getState().setMessagesForConversation('conv_1', [], 20)
    expect(useAppStore.getState().messages.msg_arriving).toBeDefined()
  })

  it('prunes run and dispatch state when their messages are deleted', () => {
    useAppStore.getState().applyEvent({
      type: 'run.start',
      conversationId: 'conv_1',
      timestamp: 1,
      runId: 'run_gone',
      agentId: 'ag_orchestrator',
      triggerMessageId: 'msg_trigger',
    })
    useAppStore.getState().upsertMessage(agentMessage('msg_gone', 'run_gone', 2))
    useAppStore.getState().applyEvent({
      type: 'dispatch.plan',
      conversationId: 'conv_1',
      timestamp: 3,
      runId: 'run_gone',
      plan: PLAN,
    })

    useAppStore.getState().removeMessages('conv_1', ['msg_gone'])

    const state = useAppStore.getState()
    expect(state.runsByConv.conv_1?.run_gone).toBeUndefined()
    expect(state.dispatchesByRunId.run_gone).toBeUndefined()
  })

  it('keeps live streaming parts when an older snapshot arrives', () => {
    useAppStore.getState().applyEvent({
      type: 'run.start',
      conversationId: 'conv_1',
      timestamp: 1,
      runId: 'run_1',
      agentId: 'ag_orchestrator',
      triggerMessageId: 'msg_trigger',
    })
    useAppStore.getState().applyEvent({
      type: 'message.start',
      conversationId: 'conv_1',
      timestamp: 2,
      messageId: 'msg_1',
      agentId: 'ag_orchestrator',
      runId: 'run_1',
    })
    useAppStore.getState().applyEvent({
      type: 'part.start',
      conversationId: 'conv_1',
      timestamp: 3,
      messageId: 'msg_1',
      partIndex: 0,
      part: { type: 'text', content: 'hello' },
    })

    useAppStore.getState().setMessagesForConversation('conv_1', [
      { ...agentMessage('msg_1', 'run_1', 2), status: 'streaming', parts: [] },
    ])

    expect(useAppStore.getState().messages.msg_1.parts).toHaveLength(1)
  })
})
