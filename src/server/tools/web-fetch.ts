import { lookup as dnsLookup } from 'node:dns'
import type { LookupAddress, LookupOptions } from 'node:dns'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { z } from 'zod'

import type { ToolDef, ToolResult } from './types'

const REQUEST_TIMEOUT_MS = 20_000
const MAX_REDIRECTS = 5
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_CONTENT_CHARS = 50_000
const USER_AGENT = 'AgentHub/0.1 (web_fetch)'
const TEXTUAL_CONTENT_TYPE =
  /^(text\/|application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|ld\+json)|[^;]+\+(json|xml))/i

const ArgsSchema = z.object({
  url: z.string().min(1),
})

function parseIPv4(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    bytes.push(value)
  }
  return bytes
}

function inIPv4Range(bytes: number[], network: number[], prefix: number): boolean {
  const fullBytes = Math.floor(prefix / 8)
  const remainder = prefix % 8
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== network[i]) return false
  }
  if (remainder === 0) return true
  const mask = 0xff << (8 - remainder)
  return (bytes[fullBytes] & mask) === (network[fullBytes] & mask)
}

const BLOCKED_IPV4_RANGES: Array<{ network: number[]; prefix: number }> = [
  { network: [0, 0, 0, 0], prefix: 8 },
  { network: [10, 0, 0, 0], prefix: 8 },
  { network: [100, 64, 0, 0], prefix: 10 },
  { network: [127, 0, 0, 0], prefix: 8 },
  { network: [169, 254, 0, 0], prefix: 16 },
  { network: [172, 16, 0, 0], prefix: 12 },
  { network: [192, 0, 0, 0], prefix: 24 },
  { network: [192, 0, 2, 0], prefix: 24 },
  { network: [192, 88, 99, 0], prefix: 24 },
  { network: [192, 168, 0, 0], prefix: 16 },
  { network: [198, 18, 0, 0], prefix: 15 },
  { network: [198, 51, 100, 0], prefix: 24 },
  { network: [203, 0, 113, 0], prefix: 24 },
  { network: [224, 0, 0, 0], prefix: 4 },
  { network: [240, 0, 0, 0], prefix: 4 },
]

function isBlockedIPv4(bytes: number[]): boolean {
  return BLOCKED_IPV4_RANGES.some((range) => inIPv4Range(bytes, range.network, range.prefix))
}

function parseIPv6(address: string): number[] | null {
  const raw = address.toLowerCase().replace(/%.*$/, '')
  const halves = raw.split('::')
  if (halves.length > 2) return null

  const parseHalf = (half: string): number[] | null => {
    if (half === '') return []
    const items = half.split(':')
    const groups: number[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.includes('.')) {
        if (i !== items.length - 1) return null
        const v4 = parseIPv4(item)
        if (!v4) return null
        groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3])
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(item)) return null
      groups.push(Number.parseInt(item, 16))
    }
    return groups
  }

  const head = parseHalf(halves[0])
  if (!head) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const tail = parseHalf(halves[1])
  if (!tail) return null
  if (head.length + tail.length > 7) return null
  const zeros = new Array<number>(8 - head.length - tail.length).fill(0)
  return [...head, ...zeros, ...tail]
}

function embeddedIPv4(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff]
}

function isBlockedIPv6(groups: number[]): boolean {
  if (groups.slice(0, 7).every((group) => group === 0) && (groups[7] === 0 || groups[7] === 1)) {
    return true // :: (unspecified) and ::1 (loopback)
  }
  const first = groups[0]
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if (first === 0x2001 && groups[1] === 0x0db8) return true // 2001:db8::/32 documentation

  // ::ffff:a.b.c.d IPv4-mapped
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    return isBlockedIPv4(embeddedIPv4(groups[6], groups[7]))
  }
  // 2002::/16 6to4 embeds an IPv4 address in groups 1-2
  if (first === 0x2002) {
    return isBlockedIPv4(embeddedIPv4(groups[1], groups[2]))
  }
  // 64:ff9b::/96 NAT64 embeds an IPv4 address in groups 6-7
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    return isBlockedIPv4(embeddedIPv4(groups[6], groups[7]))
  }
  return false
}

/** Returns false for anything that is not a parseable public address. */
export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const bytes = parseIPv4(address)
    return bytes !== null && !isBlockedIPv4(bytes)
  }
  if (family === 6) {
    const groups = parseIPv6(address)
    return groups !== null && !isBlockedIPv6(groups)
  }
  return false
}

export function parseFetchUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid URL: ${raw}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http:// and https:// URLs are supported (got ${url.protocol})`)
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed')
  }

  // WHATWG URL canonicalizes shorthand IPv4 forms (127.1, 2130706433, 0x7f000001).
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!hostname) throw new Error('URL must include a hostname')
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error(`Blocked host: ${hostname}`)
  }
  if (isIP(hostname) !== 0 && !isPublicIpAddress(hostname)) {
    throw new Error(`Blocked host: ${hostname} is not a public address`)
  }

  return url
}

type GuardedLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void

// Re-check every resolved address at connect time so DNS rebinding cannot reach internal hosts.
const guardedLookup: GuardedLookup = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 0)
      return
    }
    const allowed = addresses.filter((entry) => isPublicIpAddress(entry.address))
    if (allowed.length === 0) {
      callback(new Error(`Blocked host: ${hostname} resolves only to non-public addresses`), '', 0)
      return
    }
    if (options.all) {
      callback(null, allowed)
      return
    }
    const requestedFamily = typeof options.family === 'number' ? options.family : 0
    const chosen = requestedFamily
      ? allowed.find((entry) => entry.family === requestedFamily)
      : allowed[0]
    if (!chosen) {
      callback(new Error(`No usable address for host: ${hostname}`), '', 0)
      return
    }
    callback(null, chosen.address, chosen.family)
  })
}

interface TextResponse {
  kind: 'text'
  status: number
  contentType: string
  body: Buffer
  truncated: boolean
}

interface BinaryResponse {
  kind: 'binary'
  status: number
  contentType: string
}

interface RedirectResponse {
  kind: 'redirect'
  status: number
  location: string
}

type FetchResponse = TextResponse | BinaryResponse | RedirectResponse

function isTextualContentType(value: string): boolean {
  if (!value) return true
  return TEXTUAL_CONTENT_TYPE.test(value.split(';')[0].trim())
}

function requestOnce(url: URL, signal: AbortSignal): Promise<FetchResponse> {
  return new Promise<FetchResponse>((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = request(
      url,
      {
        method: 'GET',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/json,application/xml,text/plain;q=0.9,*/*;q=0.5',
          'accept-encoding': 'identity',
        },
        lookup: guardedLookup,
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0
        const contentType = res.headers['content-type'] ?? ''
        const location = res.headers.location

        if (status >= 300 && status < 400 && location) {
          res.resume()
          resolve({ kind: 'redirect', status, location })
          return
        }
        if (!isTextualContentType(contentType)) {
          res.resume()
          resolve({ kind: 'binary', status, contentType })
          return
        }

        const chunks: Buffer[] = []
        let received = 0
        let truncated = false
        let settled = false
        const finish = (value: FetchResponse) => {
          if (settled) return
          settled = true
          resolve(value)
        }

        res.on('data', (chunk: Buffer) => {
          if (settled) return
          const remaining = MAX_RESPONSE_BYTES - received
          if (chunk.length > remaining) {
            if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
            truncated = true
            finish({ kind: 'text', status, contentType, body: Buffer.concat(chunks), truncated })
            req.destroy()
            return
          }
          received += chunk.length
          chunks.push(chunk)
        })
        res.on('end', () => {
          finish({ kind: 'text', status, contentType, body: Buffer.concat(chunks), truncated })
        })
        res.on('error', (err) => {
          if (!settled) reject(err)
        })
      },
    )

    req.on('error', reject)
    req.end()
  })
}

function decodeBody(body: Buffer, contentType: string): string {
  const charset = /charset=["']?([A-Za-z0-9._-]+)/i.exec(contentType)?.[1]?.toLowerCase()
  if (charset && charset !== 'utf-8' && charset !== 'utf8') {
    try {
      return new TextDecoder(charset).decode(body)
    } catch {
      // Unknown charset label; fall through to UTF-8.
    }
  }
  return new TextDecoder('utf-8').decode(body)
}

async function fetchDocument(rawUrl: string, signal: AbortSignal): Promise<ToolResult> {
  let current = parseFetchUrl(rawUrl)

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await requestOnce(current, signal)

    if (response.kind === 'redirect') {
      if (hop === MAX_REDIRECTS) {
        return { ok: false, error: `Too many redirects (max ${MAX_REDIRECTS})` }
      }
      current = parseFetchUrl(new URL(response.location, current).toString())
      continue
    }

    if (response.kind === 'binary') {
      return {
        ok: true,
        value: {
          url: current.toString(),
          status: response.status,
          contentType: response.contentType || null,
          content: null,
          truncated: false,
          note: 'Non-text content was not downloaded.',
        },
      }
    }

    const text = decodeBody(response.body, response.contentType)
    const clamped = text.length > MAX_CONTENT_CHARS
    const content = clamped
      ? `${text.slice(0, MAX_CONTENT_CHARS)}\n\n[truncated at ${MAX_CONTENT_CHARS} characters]`
      : text

    return {
      ok: true,
      value: {
        url: current.toString(),
        status: response.status,
        contentType: response.contentType || null,
        content,
        truncated: response.truncated || clamped,
      },
    }
  }

  return { ok: false, error: `Too many redirects (max ${MAX_REDIRECTS})` }
}

async function fetchWithinLimits(rawUrl: string, abortSignal: AbortSignal): Promise<ToolResult> {
  if (abortSignal.aborted) return { ok: false, error: 'web_fetch aborted' }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  abortSignal.addEventListener('abort', onAbort, { once: true })

  try {
    return await fetchDocument(rawUrl, controller.signal)
  } catch (err) {
    if (abortSignal.aborted) return { ok: false, error: 'web_fetch aborted' }
    if (timedOut) return { ok: false, error: `web_fetch timed out after ${REQUEST_TIMEOUT_MS / 1000}s` }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
    abortSignal.removeEventListener('abort', onAbort)
  }
}

export const webFetchTool: ToolDef = {
  name: 'web_fetch',
  description:
    'Fetch a public http:// or https:// URL and return its text content. Blocks localhost and private/internal addresses. HTML is returned raw (not converted to Markdown), content is capped at 50,000 characters, and non-text responses are not downloaded. Use this to read online documentation or pages the user links to.',
  parameters: {
    type: 'object',
    required: ['url'],
    properties: {
      url: {
        type: 'string',
        description: 'Absolute http:// or https:// URL. Private, loopback, and file:// targets are rejected.',
      },
    },
  },
  async handler(args, ctx) {
    const parsed = ArgsSchema.safeParse(args)
    if (!parsed.success) {
      return { ok: false, error: `Invalid args: ${parsed.error.message}` }
    }
    return fetchWithinLimits(parsed.data.url, ctx.abortSignal)
  },
}
