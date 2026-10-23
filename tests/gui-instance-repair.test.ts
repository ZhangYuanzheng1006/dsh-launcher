import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

import { updateInstance } from '../src/main/instances'
import { resolveGuiExecutable } from '../src/main/gui-path-repair'

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
  testState.config = null
})

function makeConfig(instances: DshInstance[]): LauncherConfig {
  return {
    configVersion: 1,
    groups: [],
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
    launchArgs: [],
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

describe('GUI instance path repair write-back', () => {
  it('persists the re-discovered executable and preset id on the instance', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-gui-instance-repair-'))
    const newExe = join(root, 'WindowsApps', 'OpenAI.Codex_26.1013.4894.0_x64__test', 'app', 'ChatGPT.exe')
    mkdirSync(join(newExe, '..'), { recursive: true })
    writeFileSync(newExe, 'MZ')
    const instance: DshInstance = {
      id: 'codex-instance',
      name: 'Codex',
      profile: 'gui',
      port: 0,
      autoStart: false,
      description: '',
      enabled: true,
      kind: 'gui',
      exe: join(root, 'WindowsApps', 'OpenAI.Codex_26.1007.9446.0_x64__test', 'app', 'ChatGPT.exe'),
      guiPresetId: 'codex'
    }
    testState.config = makeConfig([instance])
    const repaired = await resolveGuiExecutable(
      { exe: instance.exe!, guiPresetId: instance.guiPresetId },
      async () => ({
        presets: [{ id: 'codex', name: 'Codex', exe: newExe, args: [], windowPolicy: 'codex-multi' }],
        timings: {},
        timedOut: false
      })
    )
    expect(repaired.newExe).toBe(newExe)
    const next = updateInstance(instance.id, { exe: repaired.newExe!, guiPresetId: repaired.presetId! })
    expect(next.instances[0].exe).toBe(newExe)
    expect(next.instances[0].guiPresetId).toBe('codex')
  })

  it('locks an explicitly set manual icon and preserves it across executable repair', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-gui-icon-lock-'))
    const manualIcon = join(root, 'icons', 'antigravity.png')
    mkdirSync(join(manualIcon, '..'), { recursive: true })
    writeFileSync(manualIcon, 'png')
    const instance: DshInstance = {
      id: 'agy',
      name: 'Antigravity',
      profile: 'gui',
      port: 0,
      autoStart: false,
      description: '',
      enabled: true,
      kind: 'gui',
      exe: join(root, 'Antigravity.exe'),
      icon: manualIcon,
      iconLocked: true
    }
    testState.config = makeConfig([instance])
    const repaired = updateInstance(instance.id, { exe: join(root, 'Antigravity-new.exe') })
    expect(repaired.instances[0].icon).toBe(manualIcon)
    expect(repaired.instances[0].iconLocked).toBe(true)

    const replaced = updateInstance(instance.id, { icon: join(root, 'icons', 'replacement.png') })
    expect(replaced.instances[0].icon).toBe(join(root, 'icons', 'replacement.png'))
    expect(replaced.instances[0].iconLocked).toBe(true)
  })
})
