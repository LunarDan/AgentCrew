import { describe, expect, it } from 'vitest'

import { collectUnavailableServers } from './mcp-status'

const expected = ['broken', 'unauthed', 'off']

describe('collectUnavailableServers', () => {
  it('reports failed, needs-auth, and disabled servers', () => {
    expect(
      collectUnavailableServers(
        [
          { name: 'broken', status: 'failed' },
          { name: 'unauthed', status: 'needs-auth' },
          { name: 'off', status: 'disabled' },
        ],
        expected,
      ),
    ).toEqual([
      { name: 'broken', status: 'failed' },
      { name: 'unauthed', status: 'needs-auth' },
      { name: 'off', status: 'disabled' },
    ])
  })

  it('ignores connected, pending, and unknown statuses', () => {
    expect(
      collectUnavailableServers(
        [
          { name: 'broken', status: 'connected' },
          { name: 'unauthed', status: 'pending' },
          { name: 'off', status: 'something-new' },
        ],
        expected,
      ),
    ).toEqual([])
  })

  it('ignores the agenthub bridge and servers not passed for this run', () => {
    expect(
      collectUnavailableServers(
        [
          { name: 'agenthub', status: 'failed' },
          { name: 'unselected', status: 'failed' },
        ],
        ['agenthub', ...expected],
      ),
    ).toEqual([])
  })

  it('dedupes repeated entries for the same server', () => {
    expect(
      collectUnavailableServers(
        [
          { name: 'broken', status: 'failed' },
          { name: 'broken', status: 'failed' },
        ],
        expected,
      ),
    ).toEqual([{ name: 'broken', status: 'failed' }])
  })

  it('tolerates malformed entries', () => {
    expect(
      collectUnavailableServers(
        [null, 'broken', { name: 1, status: 'failed' }, { name: 'broken' }],
        expected,
      ),
    ).toEqual([])
  })

  it('returns an empty list for empty input', () => {
    expect(collectUnavailableServers([], expected)).toEqual([])
    expect(collectUnavailableServers([{ name: 'broken', status: 'failed' }], [])).toEqual([])
  })
})
