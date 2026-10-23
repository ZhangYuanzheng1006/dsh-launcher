import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GUI_DISCOVERY_BACKGROUND_REFRESH_MS,
  GUI_DISCOVERY_CACHE_TTL_MS,
  discoveryCacheAgeMs,
  emptyGuiDiscoverySnapshot,
  isDiscoveryCacheFresh,
  readGuiDiscoveryCacheFile,
  shouldBackgroundRefresh,
  writeGuiDiscoveryCacheFile
} from '../src/main/gui-discovery-cache'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function snapshot(updatedAt: number, count = 1) {
  return {
    ...emptyGuiDiscoverySnapshot(),
    updatedAt,
    presets: Array.from({ length: count }, (_, i) => ({
      id: 'chrome' as const,
      name: `Chrome ${i}`,
      exe: 'C:\\Chrome\\chrome.exe',
      args: [],
      windowPolicy: 'chrome-newest' as const
    }))
  }
}

describe('GUI discovery cache', () => {
  it('uses a 10 minute disk TTL and a 30 second background refresh window', () => {
    const now = 1_000_000
    expect(GUI_DISCOVERY_CACHE_TTL_MS).toBe(10 * 60 * 1000)
    expect(GUI_DISCOVERY_BACKGROUND_REFRESH_MS).toBe(30 * 1000)
    expect(isDiscoveryCacheFresh(snapshot(now), now + GUI_DISCOVERY_CACHE_TTL_MS)).toBe(true)
    expect(isDiscoveryCacheFresh(snapshot(now), now + GUI_DISCOVERY_CACHE_TTL_MS + 1)).toBe(false)
    expect(shouldBackgroundRefresh(snapshot(now), now + GUI_DISCOVERY_BACKGROUND_REFRESH_MS)).toBe(true)
    expect(shouldBackgroundRefresh(snapshot(now), now + GUI_DISCOVERY_BACKGROUND_REFRESH_MS - 1)).toBe(false)
    expect(discoveryCacheAgeMs(emptyGuiDiscoverySnapshot())).toBe(Number.POSITIVE_INFINITY)
  })

  it('round-trips a cached snapshot and hides transient flags', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gui-discovery-cache-'))
    tempDirs.push(dir)
    const file = join(dir, 'cache.json')
    await writeGuiDiscoveryCacheFile(file, snapshot(Date.now()))
    const started = performance.now()
    const loaded = await readGuiDiscoveryCacheFile(file)
    const elapsed = performance.now() - started
    expect(loaded?.cached).toBe(true)
    expect(loaded?.refreshing).toBe(false)
    expect(loaded?.presets[0]?.name).toBe('Chrome 0')
    expect(elapsed).toBeLessThan(300)
  })

  it('treats malformed cache files as a cache miss', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gui-discovery-cache-'))
    tempDirs.push(dir)
    const file = join(dir, 'cache.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{not-json', 'utf8')
    expect(await readGuiDiscoveryCacheFile(file)).toBeNull()
  })
})
