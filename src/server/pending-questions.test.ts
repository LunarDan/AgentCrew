import { describe, expect, it } from 'vitest'

import { validateAskUserAnswers } from './pending-questions'
import type { PendingQuestion } from '@/shared/types'

const base: PendingQuestion = {
  id: 'pq_test',
  conversationId: 'conv_1',
  agentId: 'agent_1',
  runId: 'run_1',
  createdAt: 1,
  questions: [
    {
      question: '选哪个方案？',
      header: '方案',
      options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
    },
    {
      question: '需要哪些能力？',
      header: '能力',
      multiSelect: true,
      options: [{ label: '搜索', description: '' }, { label: '写文件', description: '' }],
    },
  ],
}

describe('validateAskUserAnswers', () => {
  it('accepts labels offered by the question', () => {
    expect(
      validateAskUserAnswers(base, {
        '选哪个方案？': { selectedLabels: ['A'] },
        '需要哪些能力？': { selectedLabels: ['搜索', '写文件'], freeformNote: '' },
      }),
    ).toBeNull()
  })

  it('rejects unknown question keys', () => {
    expect(
      validateAskUserAnswers(base, { '不存在的问题': { selectedLabels: [] } }),
    ).toBe('Unknown question: 不存在的问题')
  })

  it('rejects labels that were not offered', () => {
    expect(
      validateAskUserAnswers(base, { '选哪个方案？': { selectedLabels: ['C'] } }),
    ).toBe('Unknown option for question: 选哪个方案？')
  })

  it('rejects multiple labels on a single-select question', () => {
    expect(
      validateAskUserAnswers(base, { '选哪个方案？': { selectedLabels: ['A', 'B'] } }),
    ).toBe('Question only accepts one option: 选哪个方案？')
  })

  it('allows an empty answer set', () => {
    expect(validateAskUserAnswers(base, {})).toBeNull()
  })
})
