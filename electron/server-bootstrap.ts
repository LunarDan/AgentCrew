import { app } from 'electron'
import { request as httpRequest, createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

import { isCompanionProxyPath } from './companion-proxy'

/**
 * In-process 启动 Next.js standalone server。详见 Spec 12 §4.3。
 *
 * - 仅在打包后（`app.isPackaged`）使用；dev 模式跳过这里，main 直接 loadURL localhost:3000
 * - PORT 走系统分配的空闲端口，避免与 3000 / 用户已开端口冲突
 * - require 触发 standalone server.js 启动；server.js 内 createServer().listen(PORT)
 * - 探活直到 HEAD / 返回 < 500，最多 15s
 *
 * 伴随模式（Spec 14 §5.4）下 Next **仍然只监听 loopback**；对外的 0.0.0.0 端口由
 * `startCompanionProxy` 提供，且只转发 `/api/mobile/*`。把整个 Next 监听到 0.0.0.0 会让
 * 同一局域网内任何设备都能直接读写 `/api/settings`（明文 key）、`/api/conversations` 等
 * 未鉴权的桌面 API。
 */
export async function startEmbeddedServer(): Promise<number> {
  const companion = readCompanionConfig()
  const enabled = companion.companionMode !== 'off' && !!companion.mobileDeviceToken
  const port = await getFreePort('127.0.0.1')

  process.env.PORT = String(port)
  process.env.HOSTNAME = '127.0.0.1'
  process.env.AGENTHUB_INTERNAL_BASE_URL = `http://127.0.0.1:${port}`
  process.env.NEXT_TELEMETRY_DISABLED = '1'
  if (enabled && companion.mobileDeviceToken) {
    process.env.AGENTHUB_MOBILE_TOKEN = companion.mobileDeviceToken
  }

  // app.getAppPath() 在打包模式下指向 app.asar；但 Next standalone 的 server.js
  // 入口第一行就 process.chdir(__dirname)，chdir 是真实文件系统系统调用，跨不进 asar。
  // 我们已经把 .next/standalone 走 asarUnpack 解出来了，require 时直接走 .asar.unpacked
  // 路径，让 Electron asar layer 不介入 —— __dirname 才会是真实磁盘路径。
  const appPath = app.getAppPath()
  const standaloneRoot = appPath.endsWith('.asar')
    ? appPath + '.unpacked'
    : appPath
  const standaloneEntry = path.join(
    standaloneRoot,
    '.next',
    'standalone',
    'server.js',
  )

  // 用 require 触发 listen；server.js 是 Next 生成的 CommonJS 入口
  // 注意：在 ESM 上下文里要换 createRequire；当前 main 是 CJS（tsconfig module=commonjs），可直接用
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(standaloneEntry)

  await waitUntilReady(`http://127.0.0.1:${port}/`)
  if (enabled) startCompanionProxy(companion.companionPort, port)
  return port
}

/**
 * 0.0.0.0:<companionPort> → 127.0.0.1:<appPort> 的反向代理，只放行 `/api/mobile/*`。
 * 鉴权仍由每条移动端路由的 `requireMobileAuth` 完成（Bearer token）。
 */
function startCompanionProxy(listenPort: number, targetPort: number): void {
  const server = createHttpServer((req, res) => {
    if (!isCompanionProxyPath(req.url)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }

    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Bad gateway')
    })
    req.pipe(upstream)
  })

  server.on('error', (err) => {
    console.error(`[companion] failed to listen on 0.0.0.0:${listenPort}`, err)
  })
  server.listen(listenPort, '0.0.0.0', () => server.unref())
}

/** 从系统拿一个 ephemeral 端口（监听 :0 → 读 actual port → close）。 */
function getFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, host, () => {
      const addr = probe.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        probe.close(() => resolve(port))
      } else {
        probe.close()
        reject(new Error('Failed to allocate ephemeral port'))
      }
    })
  })
}

interface CompanionConfig {
  companionMode?: 'off' | 'lan' | 'tailnet'
  mobileDeviceToken?: string | null
  companionPort?: number
}

function readCompanionConfig(): Required<CompanionConfig> {
  const fallback: Required<CompanionConfig> = {
    companionMode: 'off',
    mobileDeviceToken: null,
    companionPort: 60646,
  }

  const dataDir = process.env.AGENTHUB_DATA_DIR
  if (!dataDir) return fallback

  try {
    const raw = fs.readFileSync(path.join(dataDir, 'companion.json'), 'utf8')
    const parsed = JSON.parse(raw) as CompanionConfig
    return {
      companionMode: parsed.companionMode ?? fallback.companionMode,
      mobileDeviceToken: parsed.mobileDeviceToken ?? null,
      companionPort: parsed.companionPort ?? fallback.companionPort,
    }
  } catch {
    return fallback
  }
}

/** 探活：每 200ms 打一次 HEAD；server 起来或超时（默认 15s）才返回。 */
async function waitUntilReady(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, { method: 'HEAD' })
      if (resp.status < 500) return
    } catch {
      // server 尚未起来
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Embedded server not ready at ${url} after ${timeoutMs}ms`)
}
