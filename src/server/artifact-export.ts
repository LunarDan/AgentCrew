import { eq } from 'drizzle-orm'
import JSZip from 'jszip'

import { db, schema } from '@/db/client'
import { normalizeDeploymentFilePath } from '@/server/deployment-service'
import { getWorkspaceForConversation } from '@/server/fs-service'
import { zipProjectFromWorkspace } from '@/server/project-artifact'
import { getEffectiveCwd } from '@/server/workspace-utils'
import type { ArtifactContent } from '@/shared/types'

/**
 * 产物一键导出（桌面 `/api/artifacts/:id/export` 与移动端共用）。
 *
 * 按 type 分发：
 *  - web_app  → ZIP 含所有源码文件，文件名 `<title>-v<version>.zip`
 *  - document → 单 Markdown 文件 `<title>-v<version>.md`
 *  - image    → 302 跳转到 image.url（外部图片）
 *  - diagram  → Mermaid 源码 `<title>-v<version>.mmd`
 *  - ppt      → pptxgenjs 生成真 .pptx 二进制；mode=visual 预留给图片型高保真导出
 *  - code_file / diff / 其它 → JSON dump
 */
export async function exportArtifactResponse(
  id: string,
  exportMode: string | null,
): Promise<Response> {
  if (exportMode !== null && exportMode !== 'editable' && exportMode !== 'visual') {
    return jsonResponse({ error: `Unsupported export mode: ${exportMode}` }, 400)
  }
  const mode = exportMode ?? 'editable'

  const row = await db.query.artifacts.findFirst({
    where: eq(schema.artifacts.id, id),
  })
  if (!row) {
    return jsonResponse({ error: 'Artifact not found' }, 404)
  }

  const safeTitle = sanitizeFileName(row.title) || 'artifact'
  const baseName = `${safeTitle}-v${row.version}`
  const content = row.content as ArtifactContent

  if (content.type === 'web_app') {
    const zip = new JSZip()
    for (const [name, body] of Object.entries(content.files)) {
      // 文件名来自 LLM / 用户输入，导出 ZIP 时同样要防 zip-slip（../ 或绝对路径）
      const safeName = normalizeDeploymentFilePath(name)
      if (!safeName) {
        return jsonResponse({ error: `Artifact contains an unsafe file path: ${name}` }, 400)
      }
      zip.file(safeName, body)
    }
    // README 提示如何打开
    zip.file(
      'README.txt',
      `Artifact: ${row.title}\nVersion: v${row.version}\nEntry: ${content.entry}\n\n` +
        `打开 ${content.entry} 即可在浏览器中查看。\n` +
        `导出时间: ${new Date().toISOString()}\n`,
    )
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    return new Response(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(baseName)}.zip"`,
      },
    })
  }

  if (content.type === 'document') {
    return new Response(content.content, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(baseName)}.md"`,
      },
    })
  }

  if (content.type === 'image') {
    // 外部 URL：直接 302 让浏览器走原 URL
    return new Response(null, { status: 302, headers: { Location: content.url } })
  }

  if (content.type === 'diagram') {
    return new Response(content.source, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(baseName)}.mmd"`,
      },
    })
  }

  if (content.type === 'ppt') {
    if (mode === 'visual') {
      return jsonResponse(
        {
          error:
            'Visual-priority PPTX export is not enabled yet. Use the default editable PPTX export instead.',
        },
        501,
      )
    }
    const { slidesToPptxBuffer } = await import('@/server/ppt-export')
    const buf = await slidesToPptxBuffer(content, row.title)
    return new Response(new Uint8Array(buf), {
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(baseName)}.pptx"`,
      },
    })
  }

  if (content.type === 'project') {
    const workspace = await getWorkspaceForConversation(row.conversationId)
    if (!workspace) {
      return jsonResponse({ error: 'Workspace not found' }, 404)
    }
    const buf = await zipProjectFromWorkspace(
      getEffectiveCwd(workspace),
      content.files,
      row.title,
      new Date().toISOString(),
    )
    return new Response(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(baseName)}.zip"`,
      },
    })
  }

  // 兜底：原始 JSON
  return new Response(JSON.stringify(content, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(baseName)}.json"`,
    },
  })
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 60)
    .trim()
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
