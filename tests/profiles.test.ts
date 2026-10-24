import { describe, expect, it } from 'vitest'
import type { DshInstance, Profile, WebChatConfig } from '../src/shared/types'
import {
  createDefaultProfile,
  DEFAULT_PROFILE_ID,
  DEFAULT_SESSION_PARTITION,
  normalizeProfiles,
  removeProfileReferences,
  resolveInstanceProfile,
  resolveWebChatProfile
} from '../src/shared/profiles'
import { cookieKey, cookieUrl, toCookieSetDetails } from '../src/shared/profile-cookie'
import { profilePartition } from '../src/main/profile-session'

const profile = (id: string, patch: Partial<Profile> = {}): Profile => ({
  id,
  name: id,
  color: '#7C3AED',
  letter: id[0].toUpperCase(),
  partition: `persist:${id}`,
  source: 'launcher',
  ...patch
})

const chat = (patch: Partial<WebChatConfig> = {}): WebChatConfig => ({
  id: 'link',
  name: 'Link',
  description: '',
  url: 'https://example.com',
  hidden: false,
  ...patch
})

const instance = (patch: Partial<DshInstance> = {}): DshInstance => ({
  id: 'inst',
  name: 'Instance',
  profile: 'web',
  port: 0,
  autoStart: false,
  description: '',
  enabled: true,
  ...patch
})

describe('profile resolution', () => {
  it('normalizes the fixed default profile and repairs invalid partitions', () => {
    const profiles = normalizeProfiles([
      { id: DEFAULT_PROFILE_ID, name: '', color: 'bad', letter: '', partition: '', source: 'chrome', archived: true },
      { id: 'work', name: ' Work ', partition: 'default', source: 'edge' }
    ], 'Default')

    expect(profiles[0]).toMatchObject({
      id: DEFAULT_PROFILE_ID,
      partition: DEFAULT_SESSION_PARTITION,
      source: 'launcher',
      archived: false
    })
    expect(profiles[0].name.length).toBeGreaterThan(0)
    expect(profiles[1].partition).toBe('persist:work')
  })

  it('uses explicit per-card isolation and defaultSession otherwise', () => {
    const profiles = [createDefaultProfile(), profile('card-profile')]
    expect(resolveWebChatProfile(profiles, 'card-profile')?.id).toBe('card-profile')
    expect(resolveWebChatProfile(profiles, undefined)).toBeUndefined()
    expect(resolveWebChatProfile(profiles, DEFAULT_PROFILE_ID)).toBeUndefined()
    expect(resolveInstanceProfile(profiles, 'card-profile')?.id).toBe('card-profile')
    expect(resolveInstanceProfile(profiles, undefined)).toBeUndefined()
    expect(resolveInstanceProfile(profiles, DEFAULT_PROFILE_ID)).toBeUndefined()
  })

  it('ignores archived and missing profile references', () => {
    const profiles = [createDefaultProfile(), profile('old', { archived: true })]
    expect(resolveWebChatProfile(profiles, 'old')).toBeUndefined()
    expect(resolveInstanceProfile(profiles, 'missing')).toBeUndefined()
  })

  it('removes an isolated profile and clears link/instance references only', () => {
    const profiles = [createDefaultProfile(), profile('work')]
    const result = removeProfileReferences(
      profiles,
      [chat({ profileId: 'work' })],
      [instance({ profileId: 'work' })],
      'work'
    )
    expect(result.profiles.map((item) => item.id)).toEqual([DEFAULT_PROFILE_ID])
    expect(result.links[0].profileId).toBeUndefined()
    expect(result.instances[0].profileId).toBeUndefined()
    expect(removeProfileReferences(profiles, [], [], DEFAULT_PROFILE_ID).profiles).toHaveLength(2)
  })
})

describe('view partition selection', () => {
  it('always maps the default profile to the legacy defaultSession', () => {
    expect(profilePartition(createDefaultProfile())).toBeUndefined()
    expect(profilePartition(profile('work'))).toBe('persist:work')
    expect(profilePartition(undefined)).toBeUndefined()
  })
})

describe('cookie migration helpers', () => {
  it('builds stable keys and set-cookie URLs', () => {
    const cookie = { name: 'sid', domain: '.Example.com', path: '/app', secure: true }
    expect(cookieKey(cookie)).toBe('example.com\0/app\0sid')
    expect(cookieUrl(cookie)).toBe('https://Example.com/app')
  })

  it('preserves host-only, session, expiry and sameSite semantics', () => {
    const hostOnly = toCookieSetDetails({
      name: 'sid', value: 'v', domain: 'example.com', path: '/', secure: true, httpOnly: true,
      hostOnly: true, session: true, sameSite: 'lax'
    })
    expect(hostOnly).toMatchObject({ url: 'https://example.com/', httpOnly: true, sameSite: 'lax' })
    expect(hostOnly).not.toHaveProperty('domain')
    expect(hostOnly).not.toHaveProperty('expirationDate')

    const domainCookie = toCookieSetDetails({
      name: 'pref', value: '1', domain: '.example.com', path: '/', secure: false,
      hostOnly: false, session: false, expirationDate: 12345, sameSite: 'unspecified'
    })
    expect(domainCookie).toMatchObject({ domain: '.example.com', expirationDate: 12345, sameSite: 'unspecified' })
  })
})