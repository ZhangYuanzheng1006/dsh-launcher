import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LauncherConfig } from '../src/shared/types'
import { config, instance, runtime } from './helpers/runtime-fixture'

const state = vi.hoisted(() => ({ cfg: null as LauncherConfig | null }))
vi.mock('electron', () => ({ app: { getVersion: () => '3.1.4' } }))
vi.mock('../src/main/config', () => ({ getConfig: () => state.cfg, setConfig: vi.fn() }))
vi.mock('../src/main/task', () => ({ runAsync: vi.fn(), taskLine: vi.fn(), taskDone: vi.fn(), outputOf: (r: { stdout?: string; stderr?: string }) => `${r.stdout ?? ''}\n${r.stderr ?? ''}` }))
import { runAsync } from '../src/main/task'
import { getInstanceRuntimeInfo, installInstanceRuntime, listDshRuntimeVersions, resolveInstanceCli } from '../src/main/instance-runtime'
import { instanceRuntimeDir, installedInstanceRuntime, validateRuntimeSelection } from '../src/main/runtime-selection'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-runtime space-'))
  state.cfg = config(root)
  const pm = join(root, 'pnpm.cjs')
  writeFileSync(pm, '// fixture')
  state.cfg.pnpm = pm
  vi.mocked(runAsync).mockReset()
})
afterEach(() => { vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }) })

describe('per-instance DSH installations', () => {
  it('runs two different versions and homes, unaffected by changes to the shared install', () => {
    const a = instance('a', root, '0.1.0-rc.7')
    const b = instance('b', root, '0.2.1-rc.2')
    state.cfg!.instances = [a, b]
    for (const inst of [a, b]) runtime(instanceRuntimeDir(state.cfg!, inst), inst.runtimeVersion!)
    runtime(join(state.cfg!.runtimeRoot, 'dsh'), '9.0.0')
    const run = (inst: typeof a) => {
      const cli = resolveInstanceCli(inst)
      return JSON.parse(execFileSync(cli.cmd, [...cli.args, 'plugin', '--profile', inst.profile, 'list'], { env: { ...process.env, ...cli.envPatch }, encoding: 'utf8', windowsHide: true }))
    }
    expect(run(a)).toMatchObject({ version: a.runtimeVersion, home: a.dshHome, args: ['plugin', '--profile', 'web', 'list'] })
    expect(run(b)).toMatchObject({ version: b.runtimeVersion, home: b.dshHome })
    expect(instanceRuntimeDir(state.cfg!, a)).not.toBe(instanceRuntimeDir(state.cfg!, b))
    runtime(join(state.cfg!.runtimeRoot, 'dsh'), '10.0.0')
    expect(run(a).version).toBe('0.1.0-rc.7')
  })
  it('never falls back to the global runtime when a fixed version is missing or incomplete', () => {
    const a = instance('a', root, '0.2.1-rc.2')
    state.cfg!.instances = [a]
    runtime(join(state.cfg!.runtimeRoot, 'dsh'), '0.2.1-rc.2')
    expect(() => resolveInstanceCli(a)).toThrow(/未安装/)
    const dir = instanceRuntimeDir(state.cfg!, a)
    runtime(dir, a.runtimeVersion!)
    rmSync(join(dir, 'launcher-runtime.json'))
    expect(installedInstanceRuntime(state.cfg!, a)).toBe(false)
    expect(() => resolveInstanceCli(a)).toThrow()
  })
  it('rejects shared homes, including aliases and attempts to share a pinned home later', () => {
    const a = instance('a', root, '0.2.1-rc.2')
    state.cfg!.instances = [a]
    a.dshHome = state.cfg!.dshHome
    expect(() => validateRuntimeSelection(state.cfg!)).toThrow(/独立/)
    a.dshHome = join(root, 'own')
    mkdirSync(a.dshHome)
    const alias = join(root, 'alias')
    symlinkSync(a.dshHome, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const b = { ...instance('b', root), dshHome: alias }
    state.cfg!.instances.push(b)
    expect(() => validateRuntimeSelection(state.cfg!)).toThrow(/共享/)
  })
  it('installs the exact version without renaming pnpm junctions or changing global config', async () => {
    const a = instance('a', root, '0.2.1-rc.2')
    state.cfg!.instances = [a]
    const before = JSON.stringify(state.cfg)
    vi.mocked(runAsync).mockImplementation(async (_cmd, args, cwd) => {
      if (args.includes('--eval')) return { ok: true, code: 0, stdout: '22.20.0' }
      expect(args).toContain('--save-exact')
      expect(args).toContain('@deepseek-ai/dsh@0.2.1-rc.2')
      runtime(cwd, '0.2.1-rc.2')
      rmSync(join(cwd, 'launcher-runtime.json'))
      const source = join(cwd, '.pnpm', 'fixture')
      mkdirSync(source, { recursive: true })
      writeFileSync(join(source, 'sentinel'), 'kept')
      symlinkSync(source, join(cwd, 'absolute-junction'), process.platform === 'win32' ? 'junction' : 'dir')
      expect(installedInstanceRuntime(state.cfg!, a)).toBe(false)
      return { ok: true, code: 0 }
    })
    expect((await installInstanceRuntime(a)).ok).toBe(true)
    const dir = instanceRuntimeDir(state.cfg!, a)
    expect(readFileSync(join(dir, 'absolute-junction', 'sentinel'), 'utf8')).toBe('kept')
    expect(JSON.stringify(state.cfg)).toBe(before)
    expect(getInstanceRuntimeInfo(a)).toMatchObject({ mode: 'fixed', installed: true, installedVersion: a.runtimeVersion })
    vi.mocked(runAsync).mockClear()
    expect((await installInstanceRuntime(a)).ok).toBe(true)
    expect(runAsync).not.toHaveBeenCalled()
  })
  it('does not publish a wrong version and preserves an earlier version when installation fails', async () => {
    const a = instance('a', root, '0.2.1-rc.2')
    state.cfg!.instances = [a]
    const old = instanceRuntimeDir(state.cfg!, a, '0.1.0-rc.7')
    runtime(old, '0.1.0-rc.7')
    vi.mocked(runAsync).mockImplementation(async (_cmd, args, cwd) => {
      if (args.includes('--eval')) return { ok: true, code: 0, stdout: '22.20.0' }
      runtime(cwd, '0.1.0-rc.6')
      return { ok: true, code: 0 }
    })
    const result = await installInstanceRuntime(a)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/校验/)
    expect(existsSync(instanceRuntimeDir(state.cfg!, a))).toBe(false)
    expect(existsSync(join(old, 'launcher-runtime.json'))).toBe(true)
  })
  it('explains an unpublished version and leaves no incomplete runtime behind', async () => {
    const a = instance('unpublished', root, '0.2.0')
    state.cfg!.instances = [a]
    vi.mocked(runAsync).mockImplementation(async (_cmd, args) => args.includes('--eval')
      ? { ok: true, code: 0, stdout: '22.20.0' }
      : { ok: false, code: 1, stdout: 'ERR_PNPM_NO_MATCHING_VERSION No matching version found' })
    expect(await installInstanceRuntime(a)).toMatchObject({ ok: false, error: expect.stringContaining('尚未发布') })
    expect(existsSync(instanceRuntimeDir(state.cfg!, a))).toBe(false)
  })
  it('offers a cached list of exact published versions with release tags', async () => {
    const request = vi.fn(async () => ({ ok: true, json: async () => ({ versions: { '0.2.1-rc.2': {}, '0.2.0-rc.2': {}, '0.2.1-alpha.5': {}, '../bad': {} }, 'dist-tags': { latest: '0.2.1-rc.2', alpha: '0.2.1-alpha.5', bad: 12 } }) }))
    vi.stubGlobal('fetch', request)
    expect(await listDshRuntimeVersions()).toEqual({ versions: ['0.2.1-rc.2', '0.2.1-alpha.5', '0.2.0-rc.2'], tags: { latest: '0.2.1-rc.2', alpha: '0.2.1-alpha.5' } })
    await listDshRuntimeVersions()
    expect(request).toHaveBeenCalledTimes(1)
  })
})
