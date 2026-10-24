import { describe, expect, it } from 'vitest'
import { CURRENT_CONFIG_VERSION, HOME_GROUP_ID, migrateLauncherConfig } from '../src/main/config-migration'
import type { DshInstance, Group, LauncherConfig, WebChatConfig } from '../src/shared/types'
import { createDefaultProfile } from '../src/shared/profiles'

function instance(id: string): DshInstance {
  return {
    id,
    name: id,
    profile: 'web',
    port: 0,
    autoStart: false,
    description: '',
    enabled: true
  }
}

function webChat(id: string): WebChatConfig {
  return { id, name: id, description: '', url: `https://${id}.example`, hidden: false }
}

function makeConfig(overrides: Partial<LauncherConfig> = {}): LauncherConfig {
  return {
    configVersion: CURRENT_CONFIG_VERSION,
    groups: [],
    profiles: [createDefaultProfile()],
    installMode: 'source',
    runtimeRoot: 'C:\\runtime',
    nodeVersion: '22.20.0',
    dshVersion: '0.1.0-rc.6',
    harnessRepo: 'C:\\harness',
    harnessRepoUrl: 'https://github.com/deepseek-ai/deepseek-harness.git',
    dshHome: 'C:\\dsh-home',
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
    instances: [],
    activeInstanceId: '',
    webChats: [],
    ...overrides
  }
}

describe('launcher config migration', () => {
  it('creates the home group and marks legacy web chats shared', () => {
    const result = migrateLauncherConfig(makeConfig({
      configVersion: 0,
      groups: [],
      instances: [instance('first'), instance('second')],
      activeInstanceId: 'first',
      webChats: [webChat('default'), webChat('custom')]
    }))

    expect(result.migrated).toBe(true)
    expect(result.config.configVersion).toBe(CURRENT_CONFIG_VERSION)
    expect(result.config.groups).toEqual([{
      id: HOME_GROUP_ID,
      name: '首页',
      char: '首',
      color: '#3B82F6',
      kind: 'home',
      showInTopBar: true,
      visibleInstances: ['first', 'second'],
      visibleLinks: ['default', 'custom']
    }])
    expect(result.config.webChats?.every(chat => chat.groupId === undefined)).toBe(true)
  })

  it('is idempotent when run on its own output', () => {
    const first = migrateLauncherConfig(makeConfig({
      configVersion: 0,
      groups: [],
      instances: [instance('first')],
      activeInstanceId: 'first',
      webChats: [webChat('default')]
    }))
    const second = migrateLauncherConfig(first.config)

    expect(second.migrated).toBe(false)
    expect(second.config).toEqual(first.config)
  })

  it('strips legacy group profiles and keeps default links unisolated', () => {
    const baseGroup = {
      id: HOME_GROUP_ID,
      name: '首页',
      char: '首',
      color: '#3B82F6',
      kind: 'home' as const,
      showInTopBar: true,
      visibleInstances: ['first'],
      visibleLinks: ['default']
    }
    const groupsWithLegacyProfile = [{ ...baseGroup, profileId: 'profile-legacy' }]
    const legacyInstance = { ...instance('first'), profileId: 'launcher-default' }
    const legacyLink = { ...webChat('default'), profileId: 'launcher-default' }
    const result = migrateLauncherConfig(makeConfig({
      configVersion: 3,
      groups: groupsWithLegacyProfile,
      instances: [legacyInstance],
      activeInstanceId: 'first',
      webChats: [legacyLink],
      activeGroupId: 'home',
      recentHistory: [],
    }))

    expect(result.migrated).toBe(true)
    expect(result.config.groups).toEqual([baseGroup])
    expect(result.config.groups[0]).not.toHaveProperty('profileId')
    expect(result.config.webChats?.[0].profileId).toBeUndefined()
    expect(result.config.instances[0].profileId).toBeUndefined()
  })

  it('pre-v6 clears valid isolated profiles from every link and instance', () => {
    const work = {
      id: 'profile-work',
      name: 'Work',
      color: '#7C3AED',
      letter: 'W',
      partition: 'persist:profile-work',
      source: 'launcher' as const,
      archived: false
    }
    const result = migrateLauncherConfig(makeConfig({
      configVersion: 4,
      profiles: [createDefaultProfile(), work],
      groups: [],
      instances: [{ ...instance('first'), profileId: 'profile-work' }],
      activeInstanceId: 'first',
      webChats: [{ ...webChat('default'), profileId: 'profile-work' }]
    }))

    expect(result.migrated).toBe(true)
    expect(result.config.configVersion).toBe(6)
    expect(result.config.instances[0]).not.toHaveProperty('profileId')
    expect(result.config.webChats?.[0]).not.toHaveProperty('profileId')
    expect(result.config.profiles.some((profile) => profile.id === 'profile-work')).toBe(true)
  })

  it('v6 preserves isolated link profiles while stripping instance profiles', () => {
    const work = {
      id: 'profile-work', name: 'Work', color: '#7C3AED', letter: 'W',
      partition: 'persist:profile-work', source: 'launcher' as const, archived: false
    }
    const result = migrateLauncherConfig(makeConfig({
      configVersion: 6,
      profiles: [createDefaultProfile(), work],
      instances: [{ ...instance('first'), profileId: 'profile-work' }],
      activeInstanceId: 'first',
      webChats: [{ ...webChat('default'), profileId: 'profile-work' }]
    }))
    expect(result.config.webChats?.[0].profileId).toBe('profile-work')
    expect(result.config.instances[0]).not.toHaveProperty('profileId')
  })

  it('normalizes legacy persistent/temporary groups to homogeneous normal groups', () => {
    const legacy = {
      id: 'g1', name: 'G1', char: 'G', color: '#4F7DFF',
      kind: 'temporary', showInTopBar: true, visibleInstances: [], visibleLinks: []
    } as unknown as Group
    const result = migrateLauncherConfig(makeConfig({ configVersion: 5, groups: [legacy], instances: [], webChats: [] }))
    expect(result.config.groups.find((group) => group.id === 'g1')?.kind).toBe('group')
  })

})
