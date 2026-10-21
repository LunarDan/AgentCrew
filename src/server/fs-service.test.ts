import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceRow } from '@/db/schema'

import { listDirInWorkspace, readFileInWorkspace } from './fs-service'

const roots: string[] = []

function makeWorkspace(): WorkspaceRow {
  const rootPath = mkdtempSync(path.join(tmpdir(), 'agenthub-fs-service-'))
  roots.push(rootPath)
  return {
    id: 'ws_test',
    conversationId: 'conv_test',
    rootPath,
    mode: 'sandbox',
    boundPath: null,
    createdAt: 0,
  }
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('listDirInWorkspace', () => {
  it('lists visible workspace entries with directories first', () => {
    const workspace = makeWorkspace()
    mkdirSync(path.join(workspace.rootPath, 'src'))
    writeFileSync(path.join(workspace.rootPath, 'README.md'), '# AgentHub')
    writeFileSync(path.join(workspace.rootPath, '.env'), 'SECRET=hidden')

    expect(listDirInWorkspace(workspace, '')).toMatchObject({
      relPath: '',
      absolutePath: workspace.rootPath,
      parent: null,
      entries: [
        { name: 'src', isDirectory: true },
        { name: 'README.md', isDirectory: false, size: 10 },
      ],
    })
  })

  it('caps entries when a limit is given and reports the pre-truncation total', () => {
    const workspace = makeWorkspace()
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      writeFileSync(path.join(workspace.rootPath, name), name)
    }

    const listing = listDirInWorkspace(workspace, '', { limit: 2 })

    expect(listing.entries.map((e) => e.name)).toEqual(['a.txt', 'b.txt'])
    expect(listing.entries[0]?.size).toBe(5)
    expect(listing.totalEntries).toBe(3)
  })

  it('rejects directory escapes', () => {
    const workspace = makeWorkspace()

    expect(() => listDirInWorkspace(workspace, '..')).toThrow(
      'Path ".." is outside workspace',
    )
  })

  it('reports missing paths without leaking the host path', () => {
    const workspace = makeWorkspace()

    expect(() => readFileInWorkspace(workspace, 'missing.txt')).toThrow('Path not found: missing.txt')
    expect(() => listDirInWorkspace(workspace, 'missing')).toThrow('Path not found: missing')

    try {
      readFileInWorkspace(workspace, 'missing.txt')
      expect.unreachable()
    } catch (err) {
      expect((err as Error).message).not.toContain(workspace.rootPath)
    }
  })
})
