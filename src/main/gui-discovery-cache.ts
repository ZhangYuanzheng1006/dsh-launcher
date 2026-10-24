import { readFile, writeFile } from 'node:fs/promises'
import type { GuiAppDiscoverySnapshot } from '../shared/types'

/** Disk cache is authoritative for ten minutes. */
export const GUI_DISCOVERY_CACHE_TTL_MS = 10 * 60 * 1000
/** Fresh cache may still be refreshed in the background after this age. */
export const GUI_DISCOVERY_BACKGROUND_REFRESH_MS = 30 * 1000

export function emptyGuiDiscoverySnapshot(refreshing = false): GuiAppDiscoverySnapshot {
  return {
    presets: [],
    cached: false,
    refreshing,
    timedOut: false,
    error: null,
    updatedAt: null,
    timings: {}
  }
}

export function discoveryCacheAgeMs(snapshot: GuiAppDiscoverySnapshot, now = Date.now()): number {
  return snapshot.updatedAt === null ? Number.POSITIVE_INFINITY : Math.max(0, now - snapshot.updatedAt)
}

export function isDiscoveryCacheFresh(snapshot: GuiAppDiscoverySnapshot, now = Date.now()): boolean {
  return discoveryCacheAgeMs(snapshot, now) <= GUI_DISCOVERY_CACHE_TTL_MS
}

export function shouldBackgroundRefresh(snapshot: GuiAppDiscoverySnapshot, now = Date.now()): boolean {
  return snapshot.presets.length === 0 || discoveryCacheAgeMs(snapshot, now) >= GUI_DISCOVERY_BACKGROUND_REFRESH_MS
}

function isSnapshot(value: unknown): value is Partial<GuiAppDiscoverySnapshot> {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return Array.isArray(candidate.presets) && typeof candidate.updatedAt === 'number'
}

/** Read a persisted discovery snapshot; malformed files behave like no cache. */
export async function readGuiDiscoveryCacheFile(file: string): Promise<GuiAppDiscoverySnapshot | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!isSnapshot(parsed)) return null
    return {
      presets: parsed.presets ?? [],
      cached: true,
      refreshing: false,
      timedOut: Boolean(parsed.timedOut),
      error: typeof parsed.error === 'string' ? parsed.error : null,
      updatedAt: parsed.updatedAt ?? null,
      timings: parsed.timings && typeof parsed.timings === 'object' ? parsed.timings : {}
    }
  } catch {
    return null
  }
}

/** Persist only stable fields; transient cached/refreshing flags are omitted. */
export async function writeGuiDiscoveryCacheFile(file: string, snapshot: GuiAppDiscoverySnapshot): Promise<void> {
  const payload = {
    presets: snapshot.presets,
    timedOut: snapshot.timedOut,
    error: snapshot.error,
    updatedAt: snapshot.updatedAt,
    timings: snapshot.timings
  }
  await writeFile(file, JSON.stringify(payload), 'utf8')
}
