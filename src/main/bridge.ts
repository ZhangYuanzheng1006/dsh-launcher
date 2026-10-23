// Local chrome-extension -> Electron cookie bridge. The server binds loopback
// only, verifies the browser origin, applies the configured auth mode and then
// accepts only cookie.set/cookie.remove ops. v1 has no reverse write path.

import { app, session } from 'electron'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import {
  DEFAULT_COOKIE_BRIDGE_PARTITION,
  isChromeExtensionOrigin,
  normalizeCookieBridgeConfig,
  type CookieBridgeConfig,
  type CookieBridgeState
} from '../shared/bridge'
import { writeJsonAtomic } from './atomic-json'
import {
  cookieOpKey,
  cookieRemoveUrl,
  controlMessageType,
  parseBridgeHello,
  parseCookieOp,
  parseJsonObject,
  shouldApplyCookieOp,
  toCookieSetDetails,
  type BridgeCookieOp,
  type BridgeHello
} from './bridge-protocol'

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
const HANDSHAKE_TIMEOUT_MS = 10_000
const HEARTBEAT_INTERVAL_MS = 25_000
const STALE_CONNECTION_MS = 70_000
const MAX_SNAPSHOTS = 20
const MAX_RECENT_OPS = 10_000

interface ClientConnection {
  ws: WebSocket
  origin: string | null
  connectedAt: number
  name: string
  version: string
}


function generateSecret(): string {
  return randomBytes(32).toString('base64url')
}

function secretsEqual(left: string, right: string): boolean {
  if (!left || !right) return false
  const a = createHash('sha256').update(left).digest()
  const b = createHash('sha256').update(right).digest()
  return timingSafeEqual(a, b)
}

function isAbsentOrigin(origin: string | null | undefined): boolean {
  const value = String(origin ?? '').trim().toLowerCase()
  return value === '' || value === 'null'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stoppedState(config: CookieBridgeConfig, snapshotDir: string): CookieBridgeState {
  return {
    config,
    status: 'stopped',
    token: config.token,
    origin: null,
    clientName: null,
    clientVersion: null,
    connectedAt: null,
    lastOpAt: null,
    lastError: null,
    received: 0,
    applied: 0,
    skipped: 0,
    failed: 0,
    snapshotDir
  }
}

export class CookieBridgeService {
  private config: CookieBridgeConfig
  private state: CookieBridgeState
  private wss: WebSocketServer | null = null
  private targetSession: Electron.Session | null = null
  private client: ClientConnection | null = null
  private pinnedOrigin: string | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private lastActivity = new WeakMap<WebSocket, number>()
  private recentOpIds = new Set<string>()
  private lastApplied = new Map<string, number>()
  private lastSnapshotKey = ''
  private snapshotCounter = 0
  private connectionCounter = 0
  private opChain: Promise<void> = Promise.resolve()
  private acceptOps = false
  private readonly snapshotDir: string

  constructor(rawConfig?: Partial<CookieBridgeConfig> | null) {
    this.config = normalizeCookieBridgeConfig(rawConfig)
    if (!this.config.token) this.config.token = generateSecret()
    this.snapshotDir = join(app.getPath('userData'), 'cookie-bridge', 'snapshots')
    this.state = stoppedState(this.config, this.snapshotDir)
  }

  getState(): CookieBridgeState {
    return {
      ...this.state,
      config: { ...this.state.config }
    }
  }

  isRunning(): boolean {
    return this.wss !== null
  }

  async start(): Promise<CookieBridgeState> {
    if (!this.config.enabled) {
      this.state.status = 'stopped'
      return this.getState()
    }
    if (this.wss) return this.getState()

    this.state.status = 'starting'
    this.state.lastError = null
    this.state.config = { ...this.config }
    this.state.token = this.config.token

    try {
      // The bridge is fixed to defaultSession: Chrome-synced cookies must be
      // visible to existing launcher links without an extra isolated partition.
      this.targetSession = session.defaultSession
      await this.targetSession.cookies.get({})
    } catch (error) {
      this.state.status = 'error'
      this.state.lastError = `无法打开资料分区 ${this.config.partition}: ${errorText(error)}`
      this.targetSession = null
      return this.getState()
    }

    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: this.config.port,
      maxPayload: MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
      verifyClient: (info, done) => {
        const origin = info.req.headers.origin
        if (!isAbsentOrigin(origin) && !isChromeExtensionOrigin(origin)) {
          this.rejectOrigin(origin, 'not a chrome-extension:// origin')
          done(false, 403, 'Forbidden origin')
          return
        }
        if (this.pinnedOrigin && !isAbsentOrigin(origin) && origin !== this.pinnedOrigin) {
          this.rejectOrigin(origin, 'origin differs from the enrolled extension')
          done(false, 403, 'Origin is not enrolled')
          return
        }
        done(true)
      }
    })
    this.wss = server

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }

      const onStartupError = (error: Error): void => {
        this.state.status = 'error'
        this.state.lastError = `无法监听 127.0.0.1:${this.config.port}: ${errorText(error)}`
        this.wss = null
        this.targetSession = null
        finish()
      }

      server.once('error', onStartupError)
      server.once('listening', () => {
        server.off('error', onStartupError)
        server.on('error', (error) => {
          this.state.lastError = `桥服务错误: ${errorText(error)}`
        })
        server.on('connection', (ws, req) => this.onConnection(ws, req))
        this.acceptOps = true
        this.state.status = 'listening'
        this.state.lastError = null
        this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS)
        this.heartbeatTimer.unref()
        finish()
      })
    })

    return this.getState()
  }

  async stop(): Promise<void> {
    this.acceptOps = false
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.client = null
    const server = this.wss
    this.wss = null
    if (server) {
      for (const ws of server.clients) {
        try {
          ws.terminate()
        } catch {
          // The socket may already be closing.
        }
      }
      await new Promise<void>((resolve) => {
        let finished = false
        const done = (): void => {
          if (finished) return
          finished = true
          resolve()
        }
        const timer = setTimeout(done, 800)
        timer.unref()
        server.close(() => {
          clearTimeout(timer)
          done()
        })
      })
    }
    this.targetSession = null
    this.state.status = 'stopped'
    this.state.connectedAt = null
  }

  async updateConfig(rawConfig: Partial<CookieBridgeConfig>): Promise<CookieBridgeState> {
    const next = normalizeCookieBridgeConfig(rawConfig)
    // The fixed token is part of the persisted config. Never rotate it merely
    // because the port or auth mode changed; only resetToken() may replace it.
    if (!next.token) next.token = this.config.token
    if (!next.token) next.token = generateSecret()
    const partitionChanged = next.partition !== this.config.partition
    this.config = next
    this.state.config = { ...next }
    this.state.token = next.token
    await this.stop()
    if (!next.enabled) return this.getState()

    if (partitionChanged) {
      this.lastApplied.clear()
      this.lastSnapshotKey = ''
    }
    return this.start()
  }

  async regenerateToken(): Promise<CookieBridgeState> {
    const wasEnabled = this.config.enabled
    await this.stop()
    this.config = { ...this.config, token: generateSecret() }
    this.state.config = { ...this.config }
    this.state.token = this.config.token
    this.state.origin = null
    this.state.clientName = null
    this.state.clientVersion = null
    this.state.connectedAt = null
    this.state.lastError = null
    this.pinnedOrigin = null
    if (wasEnabled) return this.start()
    return this.getState()
  }
  private heartbeat(): void {
    const server = this.wss
    if (!server) return
    const now = Date.now()
    for (const ws of server.clients) {
      const last = this.lastActivity.get(ws) ?? now
      if (now - last > STALE_CONNECTION_MS) {
        try {
          ws.terminate()
        } catch {
          // Closing a dead socket is best effort.
        }
        continue
      }
      if (ws.readyState === WebSocket.OPEN) {
        this.send(ws, { type: 'ping', ts: now })
      }
    }
  }

  private send(ws: WebSocket, payload: Record<string, unknown>): void {
    if (ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(payload))
    } catch (error) {
      this.state.lastError = `发送 WebSocket 消息失败: ${errorText(error)}`
    }
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const rawOrigin = req.headers.origin
    let origin: string | null = null
    if (!isAbsentOrigin(rawOrigin)) {
      if (!isChromeExtensionOrigin(rawOrigin)) {
        this.rejectOrigin(rawOrigin, 'not a chrome-extension:// origin')
        ws.close(1008, 'invalid origin')
        return
      }
      origin = rawOrigin
    }

    const connectionId = ++this.connectionCounter
    this.lastActivity.set(ws, Date.now())
    let authenticated = false
    const handshakeTimer = setTimeout(() => {
      if (!authenticated) ws.close(1008, 'handshake timeout')
    }, HANDSHAKE_TIMEOUT_MS)
    handshakeTimer.unref()

    ws.on('message', (raw, isBinary) => {
      this.lastActivity.set(ws, Date.now())
      if (isBinary) {
        ws.close(1003, 'binary messages are not supported')
        return
      }
      const parsed = parseJsonObject(raw.toString())
      if (!parsed) {
        this.send(ws, { type: 'error', code: 'invalid_json', message: 'Expected a JSON object' })
        return
      }

      const type = controlMessageType(parsed)
      if (type === 'hello') {
        const hello = parseBridgeHello(parsed)
        if (!hello) {
          this.send(ws, { type: 'hello.error', code: 'invalid_hello', message: 'Invalid hello message' })
          ws.close(1008, 'invalid hello')
          return
        }
        authenticated = this.acceptHello(ws, origin, hello)
        if (authenticated) {
          clearTimeout(handshakeTimer)
          this.acceptOps = true
        }
        return
      }

      if (!authenticated || !this.client || this.client.ws !== ws) {
        this.send(ws, { type: 'hello.error', code: 'not_authenticated', message: 'Send hello first' })
        ws.close(1008, 'not authenticated')
        return
      }

      if (type === 'ping') {
        this.send(ws, { type: 'pong', ts: Date.now() })
        return
      }
      if (type === 'pong') return

      const op = parseCookieOp(parsed)
      if (!op) {
        this.state.failed += 1
        this.state.lastError = '拒绝了一条格式不合法的 Cookie 操作'
        this.send(ws, { type: 'ack', opId: '', ok: false, error: 'invalid_op' })
        return
      }
      this.state.received += 1
      this.enqueueOp(ws, op, connectionId)
    })

    ws.on('close', () => {
      clearTimeout(handshakeTimer)
      if (this.client?.ws === ws) {
        this.client = null
        this.state.status = this.wss ? 'listening' : 'stopped'
        this.state.connectedAt = null
        this.lastSnapshotKey = ''
      }
    })
    ws.on('error', (error) => {
      this.state.lastError = `WebSocket 连接错误: ${errorText(error)}`
    })
  }

  private acceptHello(ws: WebSocket, origin: string | null, hello: BridgeHello): boolean {
    // Default none-auth accepts any saved/old token (or no token at all).
    // Token mode requires the fixed shared secret persisted in launcher config.
    const authOk = this.config.auth === 'none' || secretsEqual(hello.token, this.config.token)
    if (!authOk) {
      this.send(ws, {
        type: 'hello.error',
        code: 'invalid_token',
        message: 'Token authentication failed'
      })
      ws.close(1008, 'invalid token')
      return false
    }

    if (origin) {
      if (this.pinnedOrigin && this.pinnedOrigin !== origin) {
        this.rejectOrigin(origin, 'origin differs from the enrolled extension')
        this.send(ws, { type: 'hello.error', code: 'invalid_origin', message: 'Origin is not enrolled' })
        ws.close(1008, 'invalid origin')
        return false
      }
      if (!this.pinnedOrigin) this.pinnedOrigin = origin
    }

    if (this.client && this.client.ws !== ws) {
      try {
        this.client.ws.close(4001, 'replaced by a newer connection')
      } catch {
        // The old connection is already gone.
      }
    }

    this.client = {
      ws,
      origin,
      connectedAt: Date.now(),
      name: hello.clientName,
      version: hello.clientVersion
    }
    this.state.status = 'connected'
    this.state.origin = origin
    this.state.clientName = hello.clientName || null
    this.state.clientVersion = hello.clientVersion || null
    this.state.connectedAt = this.client.connectedAt
    this.state.lastError = null

    this.send(ws, {
      type: 'hello.ok',
      protocol: 'dsh-cookie-bridge',
      protocolVersion: 1,
      serverName: 'DSH Launcher Cookie Bridge',
      serverTime: Date.now(),
      auth: this.config.auth
    })
    return true
  }

  private rejectOrigin(origin: string | null | undefined, reason: string): void {
    const shown = origin === undefined || origin === null ? '<missing>' : JSON.stringify(origin)
    console.warn(`[DSH Cookie Bridge] rejected origin ${shown}: ${reason}`)
    this.state.lastError = `拒绝来源 ${shown}: ${reason}`
  }

  private enqueueOp(ws: WebSocket, op: BridgeCookieOp, connectionId: number): void {
    const run = async (): Promise<void> => {
      try {
        await this.applyOp(ws, op, connectionId)
      } catch (error) {
        this.state.failed += 1
        this.state.lastError = `Cookie 操作失败: ${errorText(error)}`
        this.send(ws, { type: 'ack', opId: op.opId, ok: false, error: 'operation_failed' })
      }
    }
    this.opChain = this.opChain.then(run)
  }

  private async applyOp(ws: WebSocket, op: BridgeCookieOp, connectionId: number): Promise<void> {
    if (!this.acceptOps || !this.targetSession) return
    if (this.client?.ws !== ws) return

    if (this.recentOpIds.has(op.opId)) {
      this.state.skipped += 1
      this.send(ws, { type: 'ack', opId: op.opId, ok: true, skipped: 'duplicate' })
      return
    }
    this.rememberOpId(op.opId)

    const key = cookieOpKey(op, this.config.partition)
    const previousTs = this.lastApplied.get(key)
    if (!shouldApplyCookieOp(previousTs, op.ts)) {
      this.state.skipped += 1
      this.send(ws, { type: 'ack', opId: op.opId, ok: true, skipped: 'older' })
      return
    }

    try {
      await this.ensureSnapshot(op, connectionId)
      if (op.type === 'cookie.set') {
        await this.targetSession.cookies.set(toCookieSetDetails(op))
      } else {
        await this.targetSession.cookies.remove(cookieRemoveUrl(op), op.cookie.name)
      }
      this.lastApplied.set(key, op.ts)
      this.state.applied += 1
      this.state.lastOpAt = Date.now()
      this.state.lastError = null
      this.send(ws, { type: 'ack', opId: op.opId, ok: true })
    } catch (error) {
      this.state.failed += 1
      this.state.lastError = `${op.type} ${op.cookie.domain}${op.cookie.path}${op.cookie.name}: ${errorText(error)}`
      this.send(ws, { type: 'ack', opId: op.opId, ok: false, error: 'cookie_write_failed' })
    }
  }

  private rememberOpId(opId: string): void {
    this.recentOpIds.add(opId)
    if (this.recentOpIds.size <= MAX_RECENT_OPS) return
    const first = this.recentOpIds.values().next().value
    if (typeof first === 'string') this.recentOpIds.delete(first)
  }

  private async ensureSnapshot(op: BridgeCookieOp, connectionId: number): Promise<void> {
    const key = op.snapshotId ? `batch:${op.snapshotId}` : `connection:${connectionId}`
    if (this.lastSnapshotKey === key) return
    await this.writeSnapshot(op.snapshotId ? 'sync-batch' : 'connection-open', op.snapshotId)
    this.lastSnapshotKey = key
  }

  private async writeSnapshot(reason: string, snapshotId?: string): Promise<void> {
    if (!this.targetSession) throw new Error('target session is unavailable')
    const cookies = await this.targetSession.cookies.get({})
    mkdirSync(this.snapshotDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const seq = String(++this.snapshotCounter).padStart(4, '0')
    const file = join(this.snapshotDir, `${stamp}-${seq}.json`)
    writeJsonAtomic(file, {
      version: 1,
      createdAt: new Date().toISOString(),
      partition: this.config.partition,
      reason,
      snapshotId: snapshotId ?? null,
      cookies
    })
    this.pruneSnapshots()
  }

  private pruneSnapshots(): void {
    if (!existsSync(this.snapshotDir)) return
    const files = readdirSync(this.snapshotDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
    for (const name of files.slice(0, Math.max(0, files.length - MAX_SNAPSHOTS))) {
      try {
        unlinkSync(join(this.snapshotDir, name))
      } catch {
        // Pruning is best effort; a locked backup must not block the write.
      }
    }
  }
}

let service: CookieBridgeService | null = null

export function getCookieBridgeState(): CookieBridgeState {
  if (service) return service.getState()
  const config = normalizeCookieBridgeConfig()
  return stoppedState(config, join(app.getPath('userData'), 'cookie-bridge', 'snapshots'))
}

export async function initCookieBridge(rawConfig?: Partial<CookieBridgeConfig> | null): Promise<CookieBridgeState> {
  if (!service) service = new CookieBridgeService(rawConfig)
  await service.start()
  return service.getState()
}

export async function updateCookieBridgeConfig(rawConfig: Partial<CookieBridgeConfig>): Promise<CookieBridgeState> {
  if (!service) service = new CookieBridgeService(normalizeCookieBridgeConfig(rawConfig))
  return service.updateConfig(normalizeCookieBridgeConfig(rawConfig))
}

export async function regenerateCookieBridgeToken(): Promise<CookieBridgeState> {
  if (!service) service = new CookieBridgeService()
  return service.regenerateToken()
}

export async function stopCookieBridge(): Promise<void> {
  if (service) await service.stop()
}

export function defaultCookieBridgePartition(): string {
  return DEFAULT_COOKIE_BRIDGE_PARTITION
}