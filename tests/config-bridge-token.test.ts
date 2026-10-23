import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.DSH_CONFIG_TEST_DIR ?? process.cwd(),
    getLocale: () => 'zh'
  }
}))

describe('fixed bridge token persistence', () => {
  let testDir = ''

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'dsh-config-token-'))
    process.env.DSH_CONFIG_TEST_DIR = testDir
    vi.resetModules()
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
    delete process.env.DSH_CONFIG_TEST_DIR
  })

  it('keeps the same fixed token across a simulated app restart', async () => {
    const firstModule = await import('../src/main/config')
    const first = firstModule.getConfig()
    const firstToken = first.cookieBridge?.token ?? ''
    expect(first.cookieBridge?.auth).toBe('none')
    expect(firstToken.length).toBeGreaterThan(20)
    expect(existsSync(join(testDir, 'launcher-config.json'))).toBe(true)

    // A fresh module import is the closest unit-level analogue of an app restart.
    vi.resetModules()
    const secondModule = await import('../src/main/config')
    const second = secondModule.getConfig()
    expect(second.cookieBridge?.token).toBe(firstToken)

    const changed = secondModule.setConfig({
      cookieBridge: {
        ...second.cookieBridge!,
        token: 'manual-reset-token-value'
      }
    })
    expect(changed.cookieBridge?.token).toBe('manual-reset-token-value')

    vi.resetModules()
    const thirdModule = await import('../src/main/config')
    const third = thirdModule.getConfig()
    expect(third.cookieBridge?.token).toBe('manual-reset-token-value')
  })
})