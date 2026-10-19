import { describe, expect, it } from 'vitest'

import { readArtifactHandoffResult } from './artifact-handoff'

const handoff = { artifactId: 'art_1', outputKey: 'design_spec', status: 'ok' }

describe('readArtifactHandoffResult', () => {
  it('reads a direct object result', () => {
    expect(readArtifactHandoffResult(handoff)).toEqual({
      artifactId: 'art_1',
      outputKey: 'design_spec',
    })
  })

  it('reads a JSON string result', () => {
    expect(readArtifactHandoffResult(JSON.stringify(handoff))).toEqual({
      artifactId: 'art_1',
      outputKey: 'design_spec',
    })
  })

  it('reads Claude Code MCP content blocks', () => {
    expect(
      readArtifactHandoffResult([{ type: 'text', text: JSON.stringify(handoff) }]),
    ).toEqual({ artifactId: 'art_1', outputKey: 'design_spec' })
  })

  it('reads Codex { result, status } wrapper', () => {
    expect(
      readArtifactHandoffResult({ result: JSON.stringify(handoff), status: 'completed' }),
    ).toEqual({ artifactId: 'art_1', outputKey: 'design_spec' })
  })

  it('reads nested content wrappers', () => {
    expect(
      readArtifactHandoffResult({
        result: { content: [{ type: 'text', text: JSON.stringify(handoff) }] },
      }),
    ).toEqual({ artifactId: 'art_1', outputKey: 'design_spec' })
  })

  it('ignores blank outputKey', () => {
    expect(
      readArtifactHandoffResult({ artifactId: 'art_1', outputKey: '   ' }),
    ).toBeNull()
  })

  it('ignores unrelated results', () => {
    expect(readArtifactHandoffResult(null)).toBeNull()
    expect(readArtifactHandoffResult('done')).toBeNull()
    expect(readArtifactHandoffResult({ artifactId: 'art_1' })).toBeNull()
    expect(readArtifactHandoffResult([{ type: 'text', text: 'plain text' }])).toBeNull()
  })

  it('stops on cyclic wrappers instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.result = cyclic
    expect(readArtifactHandoffResult(cyclic)).toBeNull()
  })
})
