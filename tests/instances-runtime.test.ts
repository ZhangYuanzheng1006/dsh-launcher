import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LauncherConfig } from '../src/shared/types'
import { config, instance } from './helpers/runtime-fixture'

const state = vi.hoisted(() => ({ cfg: null as LauncherConfig | null }))
vi.mock('../src/main/config', () => ({
  getConfig: () => state.cfg,
  setConfig: (patch: Partial<LauncherConfig>) => (state.cfg = { ...state.cfg!, ...patch })
}))
import { addInstance, instanceDshHome, updateInstance } from '../src/main/instances'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-instances-')); state.cfg = config(root) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('instance data/runtime routing', () => {
  it('persists the selected shared home so boot and plugin management use the created profile', async () => {
    const selected = join(root, 'another-home')
    const cfg = await addInstance({ name: 'shared', autoStart: false, homeMode: 'shared', home: selected })
    const inst = cfg.instances[0]
    expect(inst.dshHome).toBe(selected)
    expect(instanceDshHome(inst)).toBe(selected)
    expect(existsSync(join(instanceDshHome(inst), 'profiles', inst.profile, 'package.json'))).toBe(true)
    expect(existsSync(join(cfg.dshHome, 'profiles', inst.profile, 'package.json'))).toBe(false)
  })
  it('creates a fixed-version instance without changing or copying shared profiles', async () => {
    mkdirSync(state.cfg!.dshHome, { recursive: true })
    writeFileSync(join(state.cfg!.dshHome, 'sentinel'), 'shared data')
    const cfg = await addInstance({ name: 'fixed', autoStart: false, homeMode: 'isolated', runtimeVersion: 'v0.2.1-rc.2' })
    expect(cfg.instances[0].runtimeVersion).toBe('0.2.1-rc.2')
    expect(cfg.instances[0].dshHome).not.toBe(cfg.dshHome)
    expect(existsSync(join(cfg.instances[0].dshHome!, 'sentinel'))).toBe(false)
    expect(existsSync(join(cfg.dshHome, 'sentinel'))).toBe(true)
  })
  it('rejects version pinning on shared data and stops other instances sharing a fixed home', async () => {
    await expect(addInstance({ name: 'bad', autoStart: false, runtimeVersion: '0.2.1-rc.2' })).rejects.toThrow(/独立/)
    const cfg = await addInstance({ name: 'fixed', autoStart: false, homeMode: 'isolated', runtimeVersion: '0.2.1-rc.2' })
    await expect(addInstance({ name: 'bad', autoStart: false, home: cfg.instances[0].dshHome })).rejects.toThrow(/共享/)
  })
  it('rejects duplicate edited ports and all out-of-range/partial numeric ports', async () => {
    const a = { ...instance('a', root), port: 3080 }
    const b = { ...instance('b', root), port: 3081 }
    state.cfg!.instances = [a, b]
    expect(() => updateInstance('b', { port: 3080 })).toThrow(/端口/)
    expect(state.cfg!.instances[1].port).toBe(3081)
    for (const port of [-1, 65536, 1.2, Infinity]) {
      await expect(addInstance({ name: 'bad', autoStart: false, port })).rejects.toThrow(/端口/)
    }
    state.cfg!.instances = [{ ...a, port: 65535 }]
    await expect(addInstance({ name: 'full', autoStart: false, port: 65535 })).rejects.toThrow(/端口/)
  })
  it('lets an existing dedicated instance pin, switch and unpin without changing its data home', () => {
    const a = instance('a', root)
    state.cfg!.instances = [a]
    const pinned = updateInstance('a', { runtimeVersion: '0.2.1-rc.2' }).instances[0]
    expect(pinned.runtimeVersion).toBe('0.2.1-rc.2')
    expect(pinned.dshHome).toBe(a.dshHome)
    expect(updateInstance('a', { runtimeVersion: '' }).instances[0].runtimeVersion).toBeUndefined()
  })
})
