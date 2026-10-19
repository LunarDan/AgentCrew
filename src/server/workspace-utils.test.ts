import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import type { WorkspaceRow } from '@/db/schema'

import {
  assertPathWithinWorkspace,
  getEffectiveCwd,
  isPathSafe,
  isPathWithin,
  resolveSafePath,
} from './workspace-utils'

function workspace(overrides: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    id: 'ws_test',
    conversationId: 'conv_test',
    rootPath: path.join(process.cwd(), '.tmp', 'workspace'),
    mode: 'sandbox',
    boundPath: null,
    createdAt: 0,
    ...overrides,
  }
}

describe('getEffectiveCwd', () => {
  it('uses boundPath for local workspaces when present', () => {
    const boundPath = path.join(process.cwd(), 'local-project')
    expect(getEffectiveCwd(workspace({ mode: 'local', boundPath }))).toBe(boundPath)
  })

  it('falls back to rootPath for sandbox or missing local boundPath', () => {
    const rootPath = path.join(process.cwd(), 'sandbox-root')
    expect(getEffectiveCwd(workspace({ rootPath, mode: 'sandbox', boundPath: null }))).toBe(
      rootPath,
    )
    expect(getEffectiveCwd(workspace({ rootPath, mode: 'local', boundPath: null }))).toBe(
      rootPath,
    )
  })
})

describe('isPathWithin', () => {
  it('accepts equal paths and real descendants', () => {
    const root = path.join(process.cwd(), '.tmp', 'workspace')
    expect(isPathWithin(root, root)).toBe(true)
    expect(isPathWithin(path.join(root, 'src', 'file.ts'), root)).toBe(true)
  })

  it('rejects parent escapes and prefix traps', () => {
    const root = path.join(process.cwd(), '.tmp', 'workspace')
    expect(isPathWithin(path.resolve(root, '..', 'outside.txt'), root)).toBe(false)
    expect(isPathWithin(path.join(path.dirname(root), 'workspace-evil'), root)).toBe(false)
  })

  it.runIf(process.platform === 'win32')('is case-insensitive on Windows', () => {
    const root = path.join(process.cwd(), '.tmp', 'workspace')
    expect(isPathWithin(path.join(root.toUpperCase(), 'FILE.TS'), root.toLowerCase())).toBe(true)
  })
})

describe('resolveSafePath', () => {
  it('resolves relative and absolute paths inside the workspace', () => {
    const rootPath = path.join(process.cwd(), '.tmp', 'workspace')
    const ws = workspace({ rootPath })

    expect(resolveSafePath(ws, path.join('src', 'file.ts'))).toBe(
      path.resolve(rootPath, 'src', 'file.ts'),
    )
    expect(resolveSafePath(ws, path.resolve(rootPath, 'README.md'))).toBe(
      path.resolve(rootPath, 'README.md'),
    )
  })

  it('rejects parent escapes and absolute paths outside the workspace', () => {
    const rootPath = path.join(process.cwd(), '.tmp', 'workspace')
    const ws = workspace({ rootPath })

    expect(resolveSafePath(ws, '..')).toBeNull()
    expect(resolveSafePath(ws, path.join(path.dirname(rootPath), 'outside.txt'))).toBeNull()
    expect(resolveSafePath(ws, path.join(path.dirname(rootPath), 'workspace-evil'))).toBeNull()
  })
})

describe('assertPathWithinWorkspace', () => {
  it('returns resolved paths inside the workspace', () => {
    const rootPath = path.join(process.cwd(), '.tmp', 'workspace')
    const ws = workspace({ rootPath })

    expect(assertPathWithinWorkspace(ws, 'notes.md')).toBe(path.resolve(rootPath, 'notes.md'))
  })

  it('throws with context for escapes', () => {
    const ws = workspace()
    expect(() => assertPathWithinWorkspace(ws, '../outside.txt')).toThrow(
      'Path "../outside.txt" is outside workspace',
    )
  })
})

describe('resolveSafePath symlink containment', () => {
  const roots: string[] = []

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  function makeTree() {
    const root = mkdtempSync(path.join(tmpdir(), 'agenthub-ws-'))
    roots.push(root)
    const inside = path.join(root, 'inside')
    const outside = path.join(root, 'outside')
    mkdirSync(inside)
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret.txt'), 'secret')
    const linkPath = path.join(inside, 'escape')
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    try {
      symlinkSync(outside, linkPath, linkType)
    } catch {
      return null // Windows 未开启开发者模式时可能无权限
    }
    return { inside, outside, linkPath }
  }

  it('rejects a symlinked directory that points outside the workspace', () => {
    const tree = makeTree()
    if (!tree) return
    const ws = workspace({ rootPath: tree.inside })

    expect(resolveSafePath(ws, 'escape/secret.txt')).toBeNull()
    expect(() => assertPathWithinWorkspace(ws, 'escape/secret.txt')).toThrow('outside workspace')
  })

  it('rejects writes under a symlinked directory even when the target does not exist', () => {
    const tree = makeTree()
    if (!tree) return
    const ws = workspace({ rootPath: tree.inside })

    expect(resolveSafePath(ws, 'escape/new-file.txt')).toBeNull()
  })

  it('still accepts ordinary files inside the workspace', () => {
    const tree = makeTree()
    if (!tree) return
    const ws = workspace({ rootPath: tree.inside })

    expect(resolveSafePath(ws, 'note.txt')).toBe(path.join(tree.inside, 'note.txt'))
    expect(resolveSafePath(ws, 'nested/new-file.txt')).toBe(
      path.join(tree.inside, 'nested', 'new-file.txt'),
    )
  })
})

describe('isPathSafe', () => {
  it('rejects home and sensitive home children', () => {
    const home = homedir()

    expect(isPathSafe(home)).toBe(false)
    expect(isPathSafe(path.join(home, '.ssh'))).toBe(false)
    expect(isPathSafe(path.join(home, '.ssh', 'config'))).toBe(false)
  })

  it('allows ordinary project directories', () => {
    expect(isPathSafe(path.join(homedir(), 'agenthub-project'))).toBe(true)
  })

  it.runIf(process.platform === 'win32')('rejects Windows system and UNC paths', () => {
    const systemDrive = process.env.SystemDrive ?? 'C:'
    expect(isPathSafe(`${systemDrive}\\Windows`)).toBe(false)
    expect(isPathSafe('\\\\?\\C:\\Windows')).toBe(false)
    expect(isPathSafe('\\\\server\\share\\project')).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('rejects POSIX system paths', () => {
    expect(isPathSafe('/etc')).toBe(false)
    expect(isPathSafe('/usr/bin')).toBe(false)
  })
})
