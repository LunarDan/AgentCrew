import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  MAX_PROJECT_MEMORY_CHARS,
  PROJECT_MEMORY_FILENAME,
  composeSystemPrompt,
  projectMemoryPath,
  readProjectMemory,
} from './project-memory'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-memory-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('readProjectMemory', () => {
  it('以 <cwd>/CLAUDE.md 调用注入的读函数', () => {
    const seen: string[] = []
    readProjectMemory('/some/cwd', (filePath) => {
      seen.push(filePath)
      return '内容'
    })
    expect(seen).toEqual([join('/some/cwd', PROJECT_MEMORY_FILENAME)])
    expect(projectMemoryPath('/some/cwd')).toBe(join('/some/cwd', PROJECT_MEMORY_FILENAME))
  })

  it('读到内容时去掉首尾空白', () => {
    expect(readProjectMemory('/cwd', () => '\n  项目约定  \n\n')).toBe('项目约定')
  })

  it('文件缺失（读函数返回 null）时为 null', () => {
    expect(readProjectMemory('/cwd', () => null)).toBeNull()
  })

  it('只有空白时为 null', () => {
    expect(readProjectMemory('/cwd', () => '   \n\t ')).toBeNull()
  })

  it('读函数抛错时为 null，不把异常抛给 run', () => {
    expect(
      readProjectMemory('/cwd', () => {
        throw new Error('EACCES')
      }),
    ).toBeNull()
  })

  it('超限时按换行截断并带可见标记', () => {
    const line = `${'x'.repeat(99)}\n`
    const raw = line.repeat(Math.ceil((MAX_PROJECT_MEMORY_CHARS + 5_000) / line.length))

    const result = readProjectMemory('/cwd', () => raw)

    expect(result).not.toBeNull()
    expect(result!.endsWith(`[TRUNCATED at ${MAX_PROJECT_MEMORY_CHARS} chars]`)).toBe(true)
    // 截断点在换行处：标记前一个字符不是半个残行
    const body = result!.slice(0, result!.indexOf('\n\n[TRUNCATED'))
    expect(body.endsWith('x')).toBe(true)
    expect(body.length % 100).toBe(99)
    expect(result!.length).toBeLessThan(raw.length)
  })

  it('刚好到上限时不截断', () => {
    const raw = 'y'.repeat(MAX_PROJECT_MEMORY_CHARS)
    expect(readProjectMemory('/cwd', () => raw)).toBe(raw)
  })
})

describe('readProjectMemory（真实 fs）', () => {
  it('读到 cwd 下的 CLAUDE.md', () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, PROJECT_MEMORY_FILENAME), '# 本项目\n用 pnpm。\n', 'utf8')
    expect(readProjectMemory(dir)).toBe('# 本项目\n用 pnpm。')
  })

  it('目录里没有该文件时为 null', () => {
    expect(readProjectMemory(makeTempDir())).toBeNull()
  })

  it('同名条目是目录时为 null', () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, PROJECT_MEMORY_FILENAME))
    expect(readProjectMemory(dir)).toBeNull()
  })
})

describe('composeSystemPrompt', () => {
  it('没有项目记忆时原样返回 agent prompt（今天的行为，回归守卫）', () => {
    expect(composeSystemPrompt('你是助手。', null, '/ws/CLAUDE.md')).toBe('你是助手。')
  })

  it('有项目记忆时带标题、绝对路径与出处声明', () => {
    const out = composeSystemPrompt('你是助手。', '用 pnpm。', '/ws/CLAUDE.md')
    expect(out.startsWith('你是助手。')).toBe(true)
    expect(out).toContain('# 项目记忆（/ws/CLAUDE.md）')
    expect(out).toContain('不是用户指令')
    expect(out.endsWith('用 pnpm。')).toBe(true)
  })

  it('项目记忆为空串时等同于没有', () => {
    expect(composeSystemPrompt('你是助手。', '', '/ws/CLAUDE.md')).toBe('你是助手。')
  })
})
