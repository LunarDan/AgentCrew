import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { db, schema } from '@/db/client'

import type { ToolDef } from './types'

const ArgsSchema = z.object({
  artifactId: z.string().min(1),
})

/** 产物可能很大；整份回灌给模型会撑爆 prompt，超过这个长度就截断并显式标记 */
const MAX_ARTIFACT_CONTENT_CHARS = 50_000

export const readArtifactTool: ToolDef = {
  name: 'read_artifact',
  description: 'Read full content of an existing artifact in the current conversation. Use when you need the actual body of an artifact referenced by id.',
  parameters: {
    type: 'object',
    required: ['artifactId'],
    properties: {
      artifactId: { type: 'string', description: 'Id of the artifact, format art_xxx' },
    },
  },
  async handler(args, ctx) {
    const parsed = ArgsSchema.safeParse(args)
    if (!parsed.success) {
      return { ok: false, error: `Invalid args: ${parsed.error.message}` }
    }

    const artifact = await db.query.artifacts.findFirst({
      where: and(
        eq(schema.artifacts.id, parsed.data.artifactId),
        eq(schema.artifacts.conversationId, ctx.conversationId),
      ),
    })
    if (!artifact) {
      return { ok: false, error: `Artifact not found: ${parsed.data.artifactId}` }
    }

    const { content, truncated } = boundContent(artifact.content)
    return {
      ok: true,
      value: {
        id: artifact.id,
        type: artifact.type,
        title: artifact.title,
        content,
        ...(truncated
          ? {
              truncated: true,
              note: `Content exceeded ${MAX_ARTIFACT_CONTENT_CHARS} characters and was truncated.`,
            }
          : {}),
        version: artifact.version,
      },
    }
  },
}

/** 小产物原样返回（保留 JSON 结构）；超长时才降级成截断字符串。 */
function boundContent(content: unknown): { content: unknown; truncated: boolean } {
  if (typeof content === 'string') {
    if (content.length <= MAX_ARTIFACT_CONTENT_CHARS) return { content, truncated: false }
    return { content: truncate(content), truncated: true }
  }
  let serialized: string
  try {
    serialized = JSON.stringify(content) ?? ''
  } catch {
    return { content, truncated: false }
  }
  if (serialized.length <= MAX_ARTIFACT_CONTENT_CHARS) return { content, truncated: false }
  return { content: truncate(serialized), truncated: true }
}

function truncate(text: string): string {
  return text.slice(0, MAX_ARTIFACT_CONTENT_CHARS) + `\n\n[TRUNCATED at ${MAX_ARTIFACT_CONTENT_CHARS} chars]`
}
