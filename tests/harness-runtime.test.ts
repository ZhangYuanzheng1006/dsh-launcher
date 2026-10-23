import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LauncherConfig } from '../src/shared/types'
import { config, instance, runtime } from './helpers/runtime-fixture'

const state = vi.hoisted(() => ({ cfg: null as LauncherConfig | null, repair: vi.fn(async () => {}) }))
vi.mock('electron', () => ({ app: { getVersion: () => '3.1.4' } }))
vi.mock('../src/main/config', () => ({ getConfig: () => state.cfg, setConfig: (patch: Partial<LauncherConfig>) => (state.cfg = { ...state.cfg!, ...patch }) }))
vi.mock('../src/main/bus', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/browser-guard', () => ({ watchPort: vi.fn() }))
vi.mock('../src/main/gui-view', () => ({ detachGuiInstance: vi.fn(), isGuiInstanceWindowAlive: () => false, detachAllGuiInstances: vi.fn() }))
vi.mock('../src/main/gui-discovery', () => ({ discoverGuiApps: vi.fn() }))
vi.mock('../src/main/gui-win32', () => ({ findProcessIdsByImagePath: () => [] }))
vi.mock('../src/main/plugins', () => ({ ensureRuntimeLinks: state.repair, healBrokenDeps: () => [], missingProfilePlugin: () => null, removeBrokenPlugin: () => false }))
import { getLog, getState, startInstance, stopAllSync, stopInstance } from '../src/main/harness'
import { instanceRuntimeDir } from '../src/main/runtime-selection'
import { acquireRuntimeWrite } from '../src/main/runtime-activity'

let root: string
let listener: Server | undefined
const fixture = `const http = require('node:http');
const version = require('../package.json').version;
const server = http.createServer((_req,res)=>res.end(JSON.stringify({version, home:process.env.DSH_HOME})));
server.listen(0,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+server.address().port));`
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-harness-runtime-'))
  const a = instance(`a-${Date.now()}`, root, '0.1.0-rc.7')
  const b = instance(`b-${Date.now()}`, root, '0.2.1-rc.2')
  state.cfg = config(root, [a, b])
  for (const inst of state.cfg.instances) {
    mkdirSync(inst.dshHome!, { recursive: true })
    runtime(instanceRuntimeDir(state.cfg, inst), inst.runtimeVersion!, fixture)
  }
  state.repair.mockReset().mockResolvedValue(undefined)
})
afterEach(async () => {
  for (const inst of state.cfg?.instances ?? []) await stopInstance(inst.id)
  stopAllSync()
  if (listener) await new Promise<void>(resolve => listener!.close(() => resolve()))
  listener = undefined
  rmSync(root, { recursive: true, force: true })
})

describe('harness runtime isolation with real child processes', () => {
  it('starts two versions concurrently, and stopping one leaves the other available', async () => {
    const [a, b] = state.cfg!.instances
    expect(await Promise.all([startInstance(a.id), startInstance(b.id)])).toEqual([{ ok: true }, { ok: true }])
    await vi.waitFor(() => {
      expect(getState(a.id).status).toBe('running')
      expect(getState(b.id).status).toBe('running')
    }, { timeout: 8000 })
    const read = async (id: string) => (await fetch(`http://127.0.0.1:${getState(id).port}`)).json()
    expect(await read(a.id)).toEqual({ version: a.runtimeVersion, home: a.dshHome })
    expect(await read(b.id)).toEqual({ version: b.runtimeVersion, home: b.dshHome })
    await stopInstance(a.id)
    expect(getState(a.id).status).toBe('stopped')
    expect(await read(b.id)).toEqual({ version: b.runtimeVersion, home: b.dshHome })
  }, 20000)
  it('does not spawn after the user stops during asynchronous preflight repair', async () => {
    const a = state.cfg!.instances[0]
    let finish!: () => void
    state.repair.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const starting = startInstance(a.id)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(getState(a.id).status).toBe('starting')
    await stopInstance(a.id)
    finish()
    expect((await starting).ok).toBe(false)
    expect(getState(a.id)).toMatchObject({ status: 'stopped', pid: null, ready: false })
    expect(getLog(a.id).some(line => line.line.includes('[launcher] DSH '))).toBe(false)
  })
  it('leaves an unrelated listener alive after failed start and stop', async () => {
    listener = createServer((_req, res) => res.end('unrelated'))
    await new Promise<void>(resolve => listener!.listen(0, '127.0.0.1', resolve))
    const port = (listener.address() as { port: number }).port
    const a = state.cfg!.instances[0]
    a.port = port
    expect((await startInstance(a.id)).ok).toBe(false)
    await stopInstance(a.id)
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('unrelated')
  })
  it('rejects startup while this instance runtime is being installed', async () => {
    const a = state.cfg!.instances[0]
    const done = acquireRuntimeWrite(a.id)
    try {
      expect((await startInstance(a.id)).ok).toBe(false)
      expect(getState(a.id).pid).toBeNull()
      expect(state.repair).not.toHaveBeenCalled()
    } finally { done() }
  })
})
