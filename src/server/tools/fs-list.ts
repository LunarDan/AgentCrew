import { z } from 'zod'

import { getWorkspaceForConversation, listDirInWorkspace } from '@/server/fs-service'

import type { ToolDef } from './types'

const ArgsSchema = z.object({
  path: z.string().optional().default(''),
})

/**
 * 一个目录可能有几万个子项（生成的资源目录 / 绑定的下载目录）。列表会原样进 LLM 上下文
 * 并落成 tool_result，不能无界；超出时截断并提示模型换更窄的路径。
 */
const MAX_LIST_ENTRIES = 500

/**
 * Lists a workspace directory after the shared workspace boundary checks run.
 */
export const fsListTool: ToolDef = {
  name: 'fs_list',
  description:
    'List files and directories inside the workspace. Path defaults to the workspace root. Use this before fs_read when exploring a project; it avoids shell-specific listing mistakes.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path. Omit or pass "" for the workspace root.',
      },
    },
  },
  async handler(args, ctx) {
    const parsed = ArgsSchema.safeParse(args)
    if (!parsed.success) {
      return { ok: false, error: `Invalid args: ${parsed.error.message}` }
    }

    const workspace = await getWorkspaceForConversation(ctx.conversationId)
    if (!workspace) return { ok: false, error: 'Workspace not found' }

    try {
      const listing = listDirInWorkspace(workspace, parsed.data.path)
      if (listing.entries.length <= MAX_LIST_ENTRIES) {
        return { ok: true, value: { ...listing, truncated: false } }
      }
      return {
        ok: true,
        value: {
          ...listing,
          entries: listing.entries.slice(0, MAX_LIST_ENTRIES),
          truncated: true,
          note: `Only the first ${MAX_LIST_ENTRIES} entries are shown. List a narrower subdirectory to see the rest.`,
        },
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}
