// Wire-level validation for the Chrome cookie bridge. Everything here is pure
// so protocol regressions can be tested without launching Electron.

import {
  COOKIE_BRIDGE_PROTOCOL,
  COOKIE_BRIDGE_PROTOCOL_VERSION
} from '../shared/bridge'

export type BridgeSameSite = 'unspecified' | 'no_restriction' | 'lax' | 'strict'

export interface BridgeCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  hostOnly: boolean
  sameSite: BridgeSameSite
  expirationDate?: number
  storeId?: string
}

export interface BridgeCookieOp {
  type: 'cookie.set' | 'cookie.remove'
  opId: string
  ts: number
  source: 'chrome'
  origin: string
  cookie: BridgeCookie
  reason?: string
  cause?: string
  snapshotId?: string
}

export interface BridgeHello {
  type: 'hello'
  token: string
  session?: { id: string; resumeToken: string }
  clientName: string
  clientVersion: string
  browser: string
}

/** Electron-compatible set details; main forwards this object to session.cookies.set. */
export interface BridgeCookieSetDetails {
  url: string
  name: string
  value: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: BridgeSameSite
  domain?: string
  expirationDate?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string, maxLength: number): string | null {
  const value = record[key]
  if (typeof value !== 'string') return null
  if (value.length > maxLength) return null
  return value
}

function readOptionalString(record: Record<string, unknown>, key: string, maxLength: number): string | undefined | null {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length > maxLength) return null
  return value
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined | null {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function parseBridgeHello(value: unknown): BridgeHello | null {
  if (!isRecord(value)) return null
  if (value.type !== 'hello') return null
  if (value.protocol !== COOKIE_BRIDGE_PROTOCOL) return null
  if (value.protocolVersion !== COOKIE_BRIDGE_PROTOCOL_VERSION) return null

  // None-auth mode sends no token at all; token mode requires a non-empty one.
  const token = value.token === undefined || value.token === null
    ? ''
    : readString(value, 'token', 512)
  if (token === null) return null

  let session: BridgeHello['session']
  if (value.session !== undefined && value.session !== null) {
    if (!isRecord(value.session)) return null
    const resumeToken = readString(value.session, 'resumeToken', 512)
    if (!resumeToken) return null
    const id = value.session.id === undefined ? '' : readString(value.session, 'id', 128)
    if (id === null) return null
    session = { id, resumeToken }
  }

  const client = isRecord(value.client) ? value.client : {}
  const clientName = readString(client, 'name', 128) ?? ''
  const clientVersion = readString(client, 'version', 64) ?? ''
  const browser = readString(client, 'browser', 512) ?? ''
  return { type: 'hello', token, session, clientName, clientVersion, browser }
}

function readSameSite(record: Record<string, unknown>): BridgeSameSite | null {
  const raw = record.sameSite
  if (raw === undefined || raw === null) return 'unspecified'
  if (raw === 'unspecified' || raw === 'no_restriction' || raw === 'lax' || raw === 'strict') return raw
  return null
}

function validCookieName(name: string): boolean {
  return name.length > 0 && name.length <= 256 && !/[\s=;,]/.test(name)
}

function validCookieDomain(domain: string): boolean {
  return domain.length > 0 && domain.length <= 255 && !/[\s/]/.test(domain)
}

function parseOrigin(raw: string): string | null {
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null
    if (parsed.pathname !== '/') return null
    return parsed.origin
  } catch {
    return null
  }
}

function parseCookie(record: Record<string, unknown>, opType: BridgeCookieOp['type']): BridgeCookie | null {
  const name = readString(record, 'name', 256)
  const domain = readString(record, 'domain', 255)
  const path = readString(record, 'path', 1024)
  if (!name || !validCookieName(name) || !domain || !validCookieDomain(domain) || !path || !path.startsWith('/')) return null

  const value = opType === 'cookie.set' ? readString(record, 'value', 65_536) : ''
  if (value === null) return null

  const sameSite = readSameSite(record)
  if (!sameSite) return null

  const expirationDate = readOptionalNumber(record, 'expirationDate')
  if (expirationDate === null) return null
  if (expirationDate !== undefined && (expirationDate <= 0 || expirationDate > 4_102_444_800)) return null

  const storeId = readOptionalString(record, 'storeId', 64)
  if (storeId === null) return null

  return {
    name,
    value,
    domain,
    path,
    secure: readBoolean(record, 'secure'),
    httpOnly: readBoolean(record, 'httpOnly'),
    hostOnly: readBoolean(record, 'hostOnly'),
    sameSite,
    expirationDate,
    storeId
  }
}

/** Validate an op from the wire and return only fields the launcher understands. */
export function parseCookieOp(value: unknown): BridgeCookieOp | null {
  if (!isRecord(value)) return null
  if (value.protocol !== COOKIE_BRIDGE_PROTOCOL) return null
  if (value.protocolVersion !== COOKIE_BRIDGE_PROTOCOL_VERSION) return null
  if (value.type !== 'cookie.set' && value.type !== 'cookie.remove') return null
  if (value.source !== 'chrome') return null

  const opId = readString(value, 'opId', 128)
  const ts = value.ts
  if (!opId || typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return null

  const originRaw = readString(value, 'origin', 2048)
  if (!originRaw) return null
  const origin = parseOrigin(originRaw)
  if (!origin) return null

  if (!isRecord(value.cookie)) return null
  const cookie = parseCookie(value.cookie, value.type)
  if (!cookie) return null

  const cookieHost = cookie.domain.replace(/^\./, '').toLowerCase()
  let parsedOrigin: URL
  try {
    parsedOrigin = new URL(origin)
  } catch {
    return null
  }
  const originHost = parsedOrigin.hostname.toLowerCase()
  if (originHost !== cookieHost && !originHost.endsWith(`.${cookieHost}`)) return null

  const reason = readOptionalString(value, 'reason', 80)
  const cause = readOptionalString(value, 'cause', 80)
  const snapshotId = readOptionalString(value, 'snapshotId', 128)
  if (reason === null || cause === null || snapshotId === null) return null

  return {
    type: value.type,
    opId,
    ts,
    source: 'chrome',
    origin,
    cookie,
    reason,
    cause,
    snapshotId
  }
}

/** Stable key for conflict ordering and duplicate suppression. */
export function cookieOpKey(op: BridgeCookieOp, partition: string): string {
  return [partition, op.cookie.domain.toLowerCase(), op.cookie.path, op.cookie.name].join('\u0000')
}

/** Newer wins; equal timestamps prefer the Chrome source (the only accepted source). */
export function shouldApplyCookieOp(previousTs: number | undefined, nextTs: number): boolean {
  return previousTs === undefined || nextTs >= previousTs
}

/** Convert a validated op into the object expected by session.cookies.set. */
export function toCookieSetDetails(op: BridgeCookieOp): BridgeCookieSetDetails {
  const details: BridgeCookieSetDetails = {
    url: op.origin,
    name: op.cookie.name,
    value: op.cookie.value,
    path: op.cookie.path,
    secure: op.cookie.secure,
    httpOnly: op.cookie.httpOnly,
    sameSite: op.cookie.sameSite
  }
  if (!op.cookie.hostOnly && op.cookie.domain) details.domain = op.cookie.domain
  if (op.cookie.expirationDate !== undefined) details.expirationDate = op.cookie.expirationDate
  return details
}

/** Electron removes by URL + name, so include the validated cookie path. */
export function cookieRemoveUrl(op: BridgeCookieOp): string {
  return new URL(op.cookie.path, op.origin).toString()
}

/** Coarse message type used before full validation. */
export function controlMessageType(value: unknown): string | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  return value.type
}