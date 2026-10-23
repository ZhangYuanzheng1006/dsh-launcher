import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:net'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const electronMocks = vi.hoisted(() => ({
  get: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  set: vi.fn(async (_details: Record<string, unknown>): Promise<void> => {}),
  remove: vi.fn(async (_url: string, _name: string): Promise<void> => {})
}))

vi.mock('electron', () => ({
  app: { getPath: () => process.env.DSH_BRIDGE_TEST_DIR ?? process.cwd() },
  session: {
    defaultSession: {
      cookies: {
        get: electronMocks.get,
        set: electronMocks.set,
        remove: electronMocks.remove
      }
    },
    fromPartition: () => ({
      cookies: {
        get: electronMocks.get,
        set: electronMocks.set,
        remove: electronMocks.remove
      }
    })
  }
}))

import { CookieBridgeService } from '../src/main/bridge'

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readType(message: Record<string, unknown>): string {
  return typeof message.type === 'string' ? message.type : ''
}

function readCode(message: Record<string, unknown>): string {
  return typeof message.code === 'string' ? message.code : ''
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), 3000)
    ws.once('message', (raw) => {
      clearTimeout(timer)
      try {
        const parsed: unknown = JSON.parse(raw.toString())
        const message = record(parsed)
        if (!message) reject(new Error('non-object message'))
        else resolve(message)
      } catch (error) {
        reject(error)
      }
    })
    ws.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function connect(port: number, origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = origin === undefined
      ? new WebSocket(`ws://127.0.0.1:${port}`)
      : new WebSocket(`ws://127.0.0.1:${port}`, { origin })
    ws.once('open', () => resolve(ws))
    ws.once('unexpected-response', (_request, response) => {
      reject(new Error(`unexpected response ${response.statusCode}`))
    })
    ws.once('error', reject)
  })
}

function helloPayload(token?: string): Record<string, unknown> {
  const hello: Record<string, unknown> = {
    type: 'hello',
    protocol: 'dsh-cookie-bridge',
    protocolVersion: 1,
    client: { name: 'DSH Cookie Bridge', version: '1.0.0', browser: 'Chrome' }
  }
  if (token !== undefined) hello.token = token
  return hello
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('no test port')
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe('none-auth bridge', () => {
  let service: CookieBridgeService
  let port = 0
  let testDir = ''

  beforeAll(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-none-'))
    process.env.DSH_BRIDGE_TEST_DIR = testDir
    port = await freePort()
    service = new CookieBridgeService({
      enabled: true,
      port,
      partition: 'persist:test-none',
      auth: 'none',
      token: 'fixed-none-token-value'
    })
    const state = await service.start()
    if (state.status !== 'listening') throw new Error(state.lastError ?? `bridge status ${state.status}`)
  })

  afterAll(async () => {
    await service.stop()
    rmSync(testDir, { recursive: true, force: true })
    delete process.env.DSH_BRIDGE_TEST_DIR
  })

  it('rejects a non-extension origin before the WebSocket upgrade and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(connect(port, 'https://example.com')).rejects.toThrow(/unexpected response 403/)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('https://example.com'))
    } finally {
      warn.mockRestore()
    }
  })

  it('accepts missing and literal null Origin headers', async () => {
    for (const origin of [undefined, 'null']) {
      const ws = await connect(port, origin)
      ws.send(JSON.stringify(helloPayload()))
      const welcome = await nextMessage(ws)
      expect(readType(welcome)).toBe('hello.ok')
      ws.terminate()
    }
  })

  it('accepts a no-token hello and writes a cookie op with a pre-write snapshot', async () => {
    const ws = await connect(port, ORIGIN)
    ws.send(JSON.stringify(helloPayload()))
    const welcome = await nextMessage(ws)
    expect(readType(welcome)).toBe('hello.ok')
    expect(welcome.auth).toBe('none')

    ws.send(JSON.stringify({
      protocol: 'dsh-cookie-bridge',
      protocolVersion: 1,
      type: 'cookie.set',
      opId: 'none-op-1',
      ts: Date.now(),
      source: 'chrome',
      origin: 'https://example.com',
      cookie: {
        name: 'sid',
        value: 'secret',
        domain: '.example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        hostOnly: false,
        sameSite: 'lax',
        expirationDate: 1_900_000_000
      },
      snapshotId: 'none-snapshot-1'
    }))
    const ack = await nextMessage(ws)
    expect(readType(ack)).toBe('ack')
    expect(ack.ok).toBe(true)
    expect(electronMocks.set).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://example.com',
      name: 'sid',
      value: 'secret'
    }))
    expect(service.getState().applied).toBeGreaterThan(0)
    const snapshots = readdirSync(join(testDir, 'cookie-bridge', 'snapshots'))
    expect(snapshots.length).toBeGreaterThan(0)
    ws.terminate()
  })

  it('accepts a stale saved token in none-auth mode', async () => {
    const ws = await connect(port, ORIGIN)
    ws.send(JSON.stringify(helloPayload('old-token-from-an-earlier-version')))
    const welcome = await nextMessage(ws)
    expect(readType(welcome)).toBe('hello.ok')
    expect(welcome.auth).toBe('none')
    ws.terminate()
  })
})

describe('fixed-token bridge', () => {
  let service: CookieBridgeService
  let port = 0
  let testDir = ''

  beforeAll(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-token-'))
    process.env.DSH_BRIDGE_TEST_DIR = testDir
    port = await freePort()
    service = new CookieBridgeService({
      enabled: true,
      port,
      partition: 'persist:test-token',
      auth: 'token',
      token: 'fixed-token-value'
    })
    const state = await service.start()
    if (state.status !== 'listening') throw new Error(state.lastError ?? `bridge status ${state.status}`)
  })

  afterAll(async () => {
    await service.stop()
    rmSync(testDir, { recursive: true, force: true })
    delete process.env.DSH_BRIDGE_TEST_DIR
  })

  it('rejects a missing or wrong token', async () => {
    for (const token of [undefined, 'wrong-token']) {
      const ws = await connect(port, ORIGIN)
      ws.send(JSON.stringify(helloPayload(token)))
      const error = await nextMessage(ws)
      expect(readType(error)).toBe('hello.error')
      expect(readCode(error)).toBe('invalid_token')
      ws.terminate()
    }
  })

  it('accepts the persisted fixed token', async () => {
    const ws = await connect(port, ORIGIN)
    ws.send(JSON.stringify(helloPayload('fixed-token-value')))
    const welcome = await nextMessage(ws)
    expect(readType(welcome)).toBe('hello.ok')
    expect(welcome.auth).toBe('token')
    expect(service.getState().token).toBe('fixed-token-value')
    ws.terminate()
  })
})