import { describe, expect, it } from 'vitest'
import {
  cookieOpKey,
  cookieRemoveUrl,
  parseBridgeHello,
  parseCookieOp,
  shouldApplyCookieOp,
  toCookieSetDetails
} from '../src/main/bridge-protocol'
import {
  DEFAULT_COOKIE_BRIDGE_PORT,
  isChromeExtensionOrigin,
  normalizeBridgePartition,
  normalizeCookieBridgeConfig
} from '../src/shared/bridge'

function cookie(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'sid',
    value: 'secret',
    domain: '.example.com',
    path: '/',
    secure: true,
    httpOnly: true,
    hostOnly: false,
    sameSite: 'lax',
    expirationDate: 1_800_000_000,
    ...overrides
  }
}

function setOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 'dsh-cookie-bridge',
    protocolVersion: 1,
    type: 'cookie.set',
    opId: 'op-1',
    ts: 1_700_000_000_000,
    source: 'chrome',
    origin: 'https://example.com',
    cookie: cookie(),
    reason: 'change',
    cause: 'explicit',
    ...overrides
  }
}

describe('bridge hello validation', () => {
  it('accepts a one-time token with optional resume session', () => {
    expect(parseBridgeHello({
      type: 'hello',
      protocol: 'dsh-cookie-bridge',
      protocolVersion: 1,
      token: 'one-time',
      session: { id: 'session-1', resumeToken: 'resume' },
      client: { name: 'DSH Cookie Bridge', version: '1.0.0', browser: 'Chrome' }
    })).toEqual({
      type: 'hello',
      token: 'one-time',
      session: { id: 'session-1', resumeToken: 'resume' },
      clientName: 'DSH Cookie Bridge',
      clientVersion: '1.0.0',
      browser: 'Chrome'
    })
  })

  it('accepts a hello without a token for none-auth mode', () => {
    const hello = parseBridgeHello({
      type: 'hello',
      protocol: 'dsh-cookie-bridge',
      protocolVersion: 1,
      client: { name: 'DSH Cookie Bridge' }
    })
    expect(hello?.token).toBe('')
    expect(hello?.clientName).toBe('DSH Cookie Bridge')
  })

  it('rejects wrong protocol versions and malformed sessions', () => {
    expect(parseBridgeHello({ type: 'hello', protocol: 'dsh-cookie-bridge', protocolVersion: 2, token: 'x' })).toBeNull()
    expect(parseBridgeHello({
      type: 'hello',
      protocol: 'dsh-cookie-bridge',
      protocolVersion: 1,
      token: 'x',
      session: { resumeToken: 42 }
    })).toBeNull()
  })
})

describe('cookie op validation', () => {
  it('accepts a Chrome cookie.set and canonicalizes the origin', () => {
    const op = parseCookieOp(setOp({ origin: 'https://example.com/' }))
    expect(op).not.toBeNull()
    expect(op?.type).toBe('cookie.set')
    expect(op?.origin).toBe('https://example.com')
    expect(op?.cookie.name).toBe('sid')
    expect(op?.cookie.sameSite).toBe('lax')
  })

  it('accepts remove ops without a value', () => {
    const removeCookie = cookie()
    delete removeCookie.value
    const op = parseCookieOp(setOp({ type: 'cookie.remove', cookie: removeCookie }))
    expect(op?.type).toBe('cookie.remove')
    expect(op?.cookie.value).toBe('')
  })

  it('rejects reverse writes, unknown op types and mismatched domains', () => {
    expect(parseCookieOp(setOp({ source: 'launcher' }))).toBeNull()
    expect(parseCookieOp(setOp({ type: 'storage.set' }))).toBeNull()
    expect(parseCookieOp(setOp({ origin: 'https://evil.test' }))).toBeNull()
    expect(parseCookieOp(setOp({ cookie: cookie({ path: 'relative' }) }))).toBeNull()
    expect(parseCookieOp(setOp({ cookie: cookie({ name: 'bad;name' }) }))).toBeNull()
  })

  it('rejects a non-http origin', () => {
    expect(parseCookieOp(setOp({ origin: 'ws://example.com' }))).toBeNull()
    expect(parseCookieOp(setOp({ origin: 'https://example.com/path' }))).toBeNull()
  })
})

describe('cookie op ordering and Electron mapping', () => {
  it('keys cookies by partition, domain, path and name', () => {
    const op = parseCookieOp(setOp())
    expect(op).not.toBeNull()
    if (!op) return
    expect(cookieOpKey(op, 'persist:a')).not.toBe(cookieOpKey(op, 'persist:b'))
    expect(cookieOpKey(op, 'persist:a')).toContain('.example.com')
  })

  it('applies newer or equal timestamps and skips older ones', () => {
    expect(shouldApplyCookieOp(undefined, 10)).toBe(true)
    expect(shouldApplyCookieOp(10, 10)).toBe(true)
    expect(shouldApplyCookieOp(10, 9)).toBe(false)
  })

  it('omits domain for host-only cookies and includes it for domain cookies', () => {
    const hostOnly = parseCookieOp(setOp({ cookie: cookie({ domain: 'example.com', hostOnly: true }) }))
    const domain = parseCookieOp(setOp({ cookie: cookie({ hostOnly: false }) }))
    expect(hostOnly).not.toBeNull()
    expect(domain).not.toBeNull()
    if (!hostOnly || !domain) return
    expect(toCookieSetDetails(hostOnly).domain).toBeUndefined()
    expect(toCookieSetDetails(domain).domain).toBe('.example.com')
    expect(toCookieSetDetails(domain).url).toBe('https://example.com')
  })

  it('removes using the cookie path', () => {
    const op = parseCookieOp(setOp({ cookie: cookie({ path: '/app' }) }))
    expect(op).not.toBeNull()
    if (!op) return
    expect(cookieRemoveUrl(op)).toBe('https://example.com/app')
  })
})

describe('shared bridge settings', () => {
  it('recognizes only Chrome extension origins', () => {
    expect(isChromeExtensionOrigin(`chrome-extension://${'a'.repeat(32)}`)).toBe(true)
    expect(isChromeExtensionOrigin('https://example.com')).toBe(false)
    expect(isChromeExtensionOrigin(`chrome-extension://${'z'.repeat(32)}`)).toBe(false)
  })

  it('normalizes persistent partitions and ports', () => {
    expect(normalizeBridgePartition('launcher-default')).toBe('persist:launcher-default')
    expect(normalizeBridgePartition('persist:work')).toBe('persist:work')
    expect(normalizeBridgePartition('')).toBe('default-session')
    expect(normalizeCookieBridgeConfig({ port: 80 }).port).toBe(DEFAULT_COOKIE_BRIDGE_PORT)
    expect(normalizeCookieBridgeConfig({ port: 18080, partition: 'work' })).toEqual({
      enabled: true,
      port: 18080,
      partition: 'default-session',
      auth: 'none',
      token: ''
    })
  })

  it('preserves a fixed token through serialization and repeated normalization', () => {
    const first = normalizeCookieBridgeConfig({
      auth: 'token',
      token: 'fixed-token-value',
      port: 18081,
      partition: 'bridge'
    })
    const persisted = JSON.parse(JSON.stringify(first)) as typeof first
    const second = normalizeCookieBridgeConfig(persisted)
    expect(second.auth).toBe('token')
    expect(second.token).toBe('fixed-token-value')
    expect(second.port).toBe(18081)
  })
})