// Shared types and pure validation for the local Chrome cookie bridge.

export const DEFAULT_COOKIE_BRIDGE_PORT = 17321
export const DEFAULT_COOKIE_BRIDGE_PARTITION = 'default-session'
export const COOKIE_BRIDGE_PROTOCOL = 'dsh-cookie-bridge'
export const COOKIE_BRIDGE_PROTOCOL_VERSION = 1

export type CookieBridgeStatus = 'stopped' | 'starting' | 'listening' | 'connected' | 'error'
export type CookieBridgeAuth = 'none' | 'token'

/** User-configurable bridge settings persisted in LauncherConfig. */
export interface CookieBridgeConfig {
  enabled: boolean
  port: number
  /** Electron session partition. Persist partitions keep cookies across app restarts. */
  partition: string
  /** Localhost-only default: no shared secret. Token mode requires the fixed token. */
  auth: CookieBridgeAuth
  /** Fixed token persisted in launcher-config.json; reset only by an explicit user action. */
  token: string
}

/** Safe snapshot of bridge state for the renderer. Resume tokens never leave main. */
export interface CookieBridgeState {
  config: CookieBridgeConfig
  status: CookieBridgeStatus
  /** Fixed token shown in Settings. It changes only through the reset action. */
  token: string
  /** Pinned chrome-extension:// origin after first enrollment. */
  origin: string | null
  clientName: string | null
  clientVersion: string | null
  connectedAt: number | null
  lastOpAt: number | null
  lastError: string | null
  received: number
  applied: number
  skipped: number
  failed: number
  snapshotDir: string
}

export interface CookieBridgeConfigPatch {
  enabled?: boolean
  port?: number
  partition?: string
  auth?: CookieBridgeAuth
  token?: string
}

/** Normalize a user-entered partition into a persistent Electron partition. */
export function normalizeBridgePartition(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed === DEFAULT_COOKIE_BRIDGE_PARTITION) return DEFAULT_COOKIE_BRIDGE_PARTITION
  return trimmed.startsWith('persist:') ? trimmed : `persist:${trimmed}`
}

/** Renderer and IPC accept only persistent partitions with a conservative name. */
export function isValidBridgePartition(value: string): boolean {
  const partition = normalizeBridgePartition(value)
  return partition === DEFAULT_COOKIE_BRIDGE_PARTITION || /^persist:[A-Za-z0-9._-]{1,120}$/.test(partition)
}

/** Ports below 1024 need elevation or collide with well-known services. */
export function normalizeBridgePort(value: unknown): number {
  const port = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return DEFAULT_COOKIE_BRIDGE_PORT
  return port
}

/** Tokens are compact secrets generated with 32 random bytes (base64url). */
export function normalizeBridgeToken(value: unknown): string {
  if (typeof value !== 'string') return ''
  const token = value.trim()
  if (!token || token.length > 512 || /\s/.test(token)) return ''
  return token
}

/** Complete missing/legacy bridge settings with safe defaults. */
export function normalizeCookieBridgeConfig(raw?: Partial<CookieBridgeConfig> | null): CookieBridgeConfig {
  return {
    enabled: raw?.enabled !== false,
    port: normalizeBridgePort(raw?.port),
    // The bridge always targets the legacy defaultSession so Chrome-synced
    // cookies are visible to the already-logged-in launcher links.
    partition: DEFAULT_COOKIE_BRIDGE_PARTITION,
    auth: raw?.auth === 'token' ? 'token' : 'none',
    token: normalizeBridgeToken(raw?.token)
  }
}

/** Chrome extension origins are chrome-extension:// plus 32 chars in [a-p]. */
export function isChromeExtensionOrigin(origin: string | null | undefined): origin is string {
  return typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
}

/** Only loopback WebSocket endpoints are valid for the extension. */
export function isLoopbackBridgeUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'ws:' && parsed.hostname === '127.0.0.1' && parsed.port.length > 0
  } catch {
    return false
  }
}