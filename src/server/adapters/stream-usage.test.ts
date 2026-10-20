import { describe, expect, it } from 'vitest'

import { accumulateUsage, extractMessageDeltaUsage } from './stream-usage'

describe('extractMessageDeltaUsage', () => {
  it('reads all four token buckets from a message_delta event', () => {
    expect(
      extractMessageDeltaUsage({
        type: 'message_delta',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 200,
        },
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 100,
      cacheReadTokens: 200,
      lastInputTokens: 310,
    })
  })

  it('treats null buckets from partial gateways as zero', () => {
    expect(
      extractMessageDeltaUsage({
        type: 'message_delta',
        usage: {
          input_tokens: 3,
          output_tokens: 1,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      }),
    ).toEqual({
      inputTokens: 3,
      outputTokens: 1,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      lastInputTokens: 3,
    })
  })

  it('ignores other events and all-zero usage', () => {
    expect(extractMessageDeltaUsage({ type: 'content_block_delta' })).toBeNull()
    expect(extractMessageDeltaUsage(null)).toBeNull()
    expect(
      extractMessageDeltaUsage({
        type: 'message_delta',
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    ).toBeNull()
  })
})

describe('accumulateUsage', () => {
  it('sums calls within one stage and keeps the latest prompt size', () => {
    const first = accumulateUsage(null, {
      inputTokens: 10,
      outputTokens: 2,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      lastInputTokens: 10,
    })
    const second = accumulateUsage(first, {
      inputTokens: 20,
      outputTokens: 4,
      cacheCreationTokens: 1,
      cacheReadTokens: 2,
      lastInputTokens: 23,
    })
    expect(second).toEqual({
      inputTokens: 30,
      outputTokens: 6,
      cacheCreationTokens: 1,
      cacheReadTokens: 2,
      lastInputTokens: 23,
    })
  })
})
