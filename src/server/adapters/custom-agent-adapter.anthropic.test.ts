import { describe, expect, it } from 'vitest'

import { toAnthropicMessages } from './custom-agent-adapter'
import { resolveCustomProviderClientConfig } from './custom-provider-client'

describe('toAnthropicMessages', () => {
  it('keeps user and assistant text in order', () => {
    const messages = toAnthropicMessages([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'follow-up' },
    ])
    expect(messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'follow-up' },
    ])
  })

  it('drops system and tool messages', () => {
    const messages = toAnthropicMessages([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
      { role: 'assistant', content: 'hi' },
    ])
    expect(messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
  })

  it('drops a leading assistant message', () => {
    const messages = toAnthropicMessages([
      { role: 'assistant', content: 'orphan' },
      { role: 'user', content: 'hello' },
    ])
    expect(messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('merges consecutive messages with the same role', () => {
    const messages = toAnthropicMessages([
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'a' },
    ])
    expect(messages).toEqual([
      { role: 'user', content: 'one\n\ntwo' },
      { role: 'assistant', content: 'a' },
    ])
  })

  it('extracts text parts from multimodal content', () => {
    const messages = toAnthropicMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
        ],
      },
    ])
    expect(messages).toEqual([{ role: 'user', content: 'describe' }])
  })

  it('returns an empty array for empty history', () => {
    expect(toAnthropicMessages([])).toEqual([])
  })
})

describe('resolveCustomProviderClientConfig(anthropic)', () => {
  it('prefers the per-agent key', () => {
    expect(
      resolveCustomProviderClientConfig('anthropic', 'agent-key', 'https://relay.example/v1'),
    ).toEqual({ apiKey: 'agent-key', baseURL: 'https://relay.example/v1' })
  })

  it('falls back to ANTHROPIC_API_KEY', () => {
    const previous = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'env-key'
    try {
      expect(resolveCustomProviderClientConfig('anthropic')).toEqual({ apiKey: 'env-key' })
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previous
    }
  })

  it('throws without a key', () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    const previousAuthToken = process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    try {
      expect(() => resolveCustomProviderClientConfig('anthropic')).toThrow(/ANTHROPIC_API_KEY/)
    } finally {
      if (previousApiKey !== undefined) process.env.ANTHROPIC_API_KEY = previousApiKey
      if (previousAuthToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = previousAuthToken
    }
  })
})
