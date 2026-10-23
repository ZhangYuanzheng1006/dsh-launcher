import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DshInstance, LauncherConfig } from '../src/shared/types'
import { createDefaultProfile } from '../src/shared/profiles'

const testState = vi.hoisted(() => ({
  config: null as LauncherConfig | null
}))

vi.mock('../src/main/config', () => ({
  getConfig: (): LauncherConfig => {
    if (!testState.config) throw new Error('test config not initialized')
    return testState.config
  },
  setConfig: (patch: Partial<LauncherConfig>): LauncherConfig => {
    if (!testState.config) throw new Error('test config not initialized')
    testState.config = { ...testState.config, ...patch }
    return testState.config
  }
}))

import { removeInstance } from '../src/main/instances'

let root: string | undefined

function makeConfig(instances: DshInstance[]): LauncherConfig {
  return {
    configVersion: 1,
    groups: [
      { id: 'home', name: '首页', char: '首', color: '#3B82F6', kind: 'home', showInTopBar: true, visibleInstances: instances.map((item) => item.id), visibleLinks: [] },
      { id: 'g1', name: 'G1', char: 'G', color: '#4F7DFF', kind: 'group', showInTopBar: true, visibleInstances: instances.map((item) => item.id), visibleLinks: [] }
    ],
    profiles: [createDefaultProfile()],
    installMode: 'source',
    runtimeRoot: root ?? 'C:\\runtime',
    nodeVersion: '22.20.0',
    dshVersion: '0.1.0-rc.6',
    harnessRepo: 'C:\\harness',
    harnessRepoUrl: 'https://github.com/deepseek-ai/deepseek-harness.git',
    dshHome: join(root ?? 'C:\\runtime', 'shared-home'),
    pluginDir: 'C:\\plugins',
    profile: 'web',
    port: 3080,
    nodePath: 'node',
    launchArgs: ['apps/cli/lib/bin.js'],
    buildCmd: 'pnpm run build',
    stopOnQuit: true,
    pnpm: 'pnpm',
    startupTimeoutMs: 90000,
    language: 'zh',
    closeToTray: true,
    splashEnabled: true,
    autoStartOnLaunch: false,
    floatingWhale: false,
    marketPageSize: 30,
    instances,
    activeInstanceId: instances[0]?.id ?? '',
    webChats: [],
    pluginMeta: {}
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-launcher-remove-'))
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
  testState.config = null
})

describe('removeInstance', () => {
  it('removes only config and leaves workspace, profile, and isolated home on disk', async () => {
    if (!root) throw new Error('test root missing')
    const workspace = join(root, 'workspaces', 'first')
    const home = join(root, 'homes', 'first')
    const profile = join(home, 'profiles', 'web-first')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(workspace, 'session.txt'), 'workspace data')
    writeFileSync(join(profile, 'package.json'), '{"name":"profile data"}')
    writeFileSync(join(home, '.credentials.yaml'), 'token: do-not-delete')

    const first: DshInstance = {
      id: 'first',
      name: 'first',
      profile: 'web-first',
      port: 3101,
      autoStart: false,
      description: '',
      enabled: true,
      workspace,
      dshHome: home
    }
    const second: DshInstance = {
      id: 'second',
      name: 'second',
      profile: 'web',
      port: 3102,
      autoStart: false,
      description: '',
      enabled: true
    }
    testState.config = makeConfig([first, second])

    const next = await removeInstance('first')

    expect(next.instances.map(item => item.id)).toEqual(['second'])
    expect(next.activeInstanceId).toBe('second')
    expect(next.groups.every((group) => !group.visibleInstances.includes('first'))).toBe(true)
    expect(existsSync(workspace)).toBe(true)
    expect(readFileSync(join(workspace, 'session.txt'), 'utf8')).toBe('workspace data')
    expect(existsSync(profile)).toBe(true)
    expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe('{"name":"profile data"}')
    expect(readFileSync(join(home, '.credentials.yaml'), 'utf8')).toBe('token: do-not-delete')
  })
})
