import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.root, getLocale: () => 'zh' } }))
beforeEach(() => { state.root = mkdtempSync(join(tmpdir(), 'dsh-config-recovery-')); vi.resetModules() })
afterEach(() => { rmSync(state.root, { recursive: true, force: true }) })

describe('config data preservation', () => {
  it('reads a BOM-prefixed config without losing instances or login configuration', async () => {
    const first = await import('../src/main/config')
    const initial = first.getConfig()
    const file = join(state.root, 'launcher-config.json')
    writeFileSync(file, '\uFEFF' + JSON.stringify({ ...initial, activeInstanceId: initial.instances[0].id, instances: [{ ...initial.instances[0], name: 'User name' }] }))
    vi.resetModules()
    const loaded = (await import('../src/main/config')).getConfig()
    expect(loaded.instances[0].name).toBe('User name')
    expect(loaded.cookieBridge?.token).toBe(initial.cookieBridge?.token)
  })
  it('recovers a valid backup and preserves the corrupt original as evidence', async () => {
    const first = await import('../src/main/config')
    const initial = first.getConfig()
    const file = join(state.root, 'launcher-config.json')
    writeFileSync(`${file}.bak`, JSON.stringify({ ...initial, instances: [{ ...initial.instances[0], name: 'Recovered' }] }))
    writeFileSync(file, '{broken')
    vi.resetModules()
    const loaded = (await import('../src/main/config')).getConfig()
    expect(loaded.instances[0].name).toBe('Recovered')
    const retained = readdirSync(state.root).find(name => name.startsWith('launcher-config.json.corrupt-'))!
    expect(readFileSync(join(state.root, retained), 'utf8')).toBe('{broken')
    expect(JSON.parse(readFileSync(file, 'utf8')).instances[0].name).toBe('Recovered')
  })
  it('refuses to overwrite a corrupt config when no valid backup exists', async () => {
    const file = join(state.root, 'launcher-config.json')
    writeFileSync(file, '{broken')
    const cfg = await import('../src/main/config')
    expect(() => cfg.getConfig()).toThrow(/原文件已保留/)
    expect(readFileSync(file, 'utf8')).toBe('{broken')
    expect(existsSync(`${file}.bak`)).toBe(false)
  })
  it('reports failed writes and leaves the cached config unchanged', async () => {
    const cfg = await import('../src/main/config')
    const initial = cfg.getConfig()
    const file = join(state.root, 'launcher-config.json')
    mkdirSync(`${file}.tmp`)
    expect(() => cfg.setConfig({ marketPageSize: 17 })).toThrow()
    expect(cfg.getConfig().marketPageSize).toBe(initial.marketPageSize)
    expect(JSON.parse(readFileSync(file, 'utf8')).marketPageSize).toBe(initial.marketPageSize)
  })
  it('keeps the only valid backup intact when writing a recovery fails', async () => {
    const first = await import('../src/main/config')
    const initial = first.getConfig()
    const file = join(state.root, 'launcher-config.json')
    const backup = JSON.stringify({ ...initial, instances: [{ ...initial.instances[0], name: 'Only good copy' }] })
    writeFileSync(`${file}.bak`, backup)
    writeFileSync(file, '{broken')
    mkdirSync(`${file}.tmp`)
    vi.resetModules()
    const second = await import('../src/main/config')
    expect(() => second.getConfig()).toThrow(/原文件已保留/)
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe(backup)
    expect(readFileSync(file, 'utf8')).toBe('{broken')
    rmSync(`${file}.tmp`, { recursive: true })
    expect(second.getConfig().instances[0].name).toBe('Only good copy')
  })
})
