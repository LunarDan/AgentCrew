import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bootstrapDatabase, reconcileInterruptedRuns } from './bootstrap'
import { runMessageSearchMigration } from './migrate-add-message-search'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      error TEXT,
      finished_at INTEGER
    );
  `)
  return db
}

describe('reconcileInterruptedRuns', () => {
  let db: Database.Database
  beforeEach(() => {
    db = makeDb()
    db.prepare('INSERT INTO agent_runs (id, status) VALUES (?, ?)').run('r1', 'running')
    db.prepare('INSERT INTO agent_runs (id, status) VALUES (?, ?)').run('r2', 'queued')
    db.prepare('INSERT INTO agent_runs (id, status) VALUES (?, ?)').run('r3', 'complete')
    db.prepare('INSERT INTO agent_runs (id, status) VALUES (?, ?)').run('r4', 'failed')
    db.prepare('INSERT INTO messages (id, status) VALUES (?, ?)').run('m1', 'streaming')
    db.prepare('INSERT INTO messages (id, status) VALUES (?, ?)').run('m2', 'complete')
  })
  afterEach(() => {
    db.close()
  })

  it('fails queued/running runs and aborts streaming messages', () => {
    reconcileInterruptedRuns(db)

    const runs = db
      .prepare('SELECT id, status, error, finished_at FROM agent_runs ORDER BY id')
      .all() as { id: string; status: string; error: string | null; finished_at: number | null }[]
    expect(runs.map((r) => [r.id, r.status])).toEqual([
      ['r1', 'failed'],
      ['r2', 'failed'],
      ['r3', 'complete'],
      ['r4', 'failed'],
    ])
    expect(runs[0].error).toContain('重启')
    expect(runs[0].finished_at).toBeTypeOf('number')

    const messages = db.prepare('SELECT id, status FROM messages ORDER BY id').all()
    expect(messages).toEqual([
      { id: 'm1', status: 'aborted' },
      { id: 'm2', status: 'complete' },
    ])
  })

  it('is idempotent across repeated restarts', () => {
    reconcileInterruptedRuns(db)
    const first = db.prepare('SELECT id, finished_at FROM agent_runs ORDER BY id').all()
    reconcileInterruptedRuns(db)
    expect(db.prepare('SELECT id, finished_at FROM agent_runs ORDER BY id').all()).toEqual(first)
  })
})

describe('bootstrapDatabase', () => {
  it('installs the message search FTS table and triggers', () => {
    const db = new Database(':memory:')
    try {
      bootstrapDatabase(db)

      const fts = db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'messages_fts'")
        .get()
      expect(fts).toBeDefined()
      const triggers = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'messages_fts_%'")
        .all() as { name: string }[]
      expect(triggers.map((t) => t.name).sort()).toEqual([
        'messages_fts_ad',
        'messages_fts_ai',
        'messages_fts_au',
      ])
    } finally {
      db.close()
    }
  })
})

describe('runMessageSearchMigration', () => {
  function makeMessageDb(): Database.Database {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        role TEXT,
        agent_id TEXT,
        parts TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
    return db
  }

  function insertMessage(db: Database.Database, id: string, parts: unknown[], status: string): void {
    db.prepare(
      'INSERT INTO messages (id, parts, status, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, JSON.stringify(parts), status, 1)
  }

  it('merges text parts into one row per message when backfilling', () => {
    const db = makeMessageDb()
    try {
      insertMessage(
        db,
        'm1',
        [
          { type: 'text', content: 'hello world' },
          { type: 'text', content: 'second part' },
          { type: 'tool_use', content: 'ignored' },
        ],
        'complete',
      )

      runMessageSearchMigration(db)

      const rows = db.prepare('SELECT content FROM messages_fts').all() as { content: string }[]
      expect(rows).toEqual([{ content: 'hello world second part' }])
    } finally {
      db.close()
    }
  })

  it('does not duplicate the backfill when the migration runs again', () => {
    const db = makeMessageDb()
    try {
      insertMessage(db, 'm1', [{ type: 'text', content: 'hello' }], 'complete')

      runMessageSearchMigration(db)
      runMessageSearchMigration(db)

      const count = db.prepare('SELECT count(*) AS n FROM messages_fts').get() as { n: number }
      expect(count.n).toBe(1)
    } finally {
      db.close()
    }
  })
})
