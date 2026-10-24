import type { DshInstance, Profile, WebChatConfig } from './types'

/** Fixed id and persistent partition of the launcher-wide default profile. */
export const DEFAULT_PROFILE_ID = 'launcher-default'
export const DEFAULT_PROFILE_PARTITION = 'persist:launcher-default'

/** Legacy Chromium cookies live in Electron's unnamed default session. */
export const DEFAULT_SESSION_PARTITION = 'default-session'

export function createDefaultProfile(name = '默认资料（启动器）'): Profile {
  return {
    id: DEFAULT_PROFILE_ID,
    name,
    color: '#4F7DFF',
    letter: '默',
    partition: DEFAULT_SESSION_PARTITION,
    source: 'launcher',
    archived: false
  }
}

function validColor(value: string | undefined): string {
  return /^#[0-9a-f]{6}$/i.test(value ?? '') ? value! : '#4F7DFF'
}

function normalizedPartition(value: string | undefined, id: string): string {
  const raw = (value ?? '').trim()
  if (/^persist:[A-Za-z0-9._-]+$/.test(raw)) return raw
  return `persist:${id.replace(/[^A-Za-z0-9._-]/g, '-')}`
}

/**
 * Normalize persisted profile records and guarantee the fixed default profile.
 * The default is always first and keeps the stable launcher partition.
 */
export function normalizeProfiles(input: readonly Partial<Profile>[] | undefined, defaultName?: string): Profile[] {
  const out: Profile[] = []
  const seen = new Set<string>()
  for (const raw of input ?? []) {
    const id = (raw.id ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const archived = raw.archived === true
    out.push({
      id,
      name: (raw.name ?? '').trim() || id,
      color: validColor(raw.color),
      letter: Array.from((raw.letter ?? '').trim() || id)[0] ?? '资',
      partition: id === DEFAULT_PROFILE_ID ? DEFAULT_SESSION_PARTITION : normalizedPartition(raw.partition, id),
      source: raw.source === 'chrome' || raw.source === 'edge' ? raw.source : 'launcher',
      ...(archived ? { archived: true } : { archived: false })
    })
  }
  const defaultIndex = out.findIndex((profile) => profile.id === DEFAULT_PROFILE_ID)
  if (defaultIndex >= 0) {
    out[defaultIndex] = {
      ...out[defaultIndex],
      name: out[defaultIndex].name || defaultName || '默认资料（启动器）',
      color: out[defaultIndex].color || '#4F7DFF',
      letter: out[defaultIndex].letter || '默',
      partition: DEFAULT_SESSION_PARTITION,
      source: 'launcher',
      archived: false
    }
    const [defaultProfile] = out.splice(defaultIndex, 1)
    out.unshift(defaultProfile)
  } else {
    out.unshift(createDefaultProfile(defaultName))
  }
  return out
}

export function profileById(profiles: readonly Profile[], id: string | undefined): Profile {
  return profiles.find((profile) => profile.id === id && !profile.archived) ??
    profiles.find((profile) => profile.id === DEFAULT_PROFILE_ID) ??
    createDefaultProfile()
}

/**
 * Resolve a web link's optional isolated profile. No profile, the default
 * sentinel, or a missing/archived profile all mean "no isolation" and therefore
 * use Electron's legacy defaultSession. Groups never contribute a profile.
 */
export function resolveWebChatProfile(profiles: readonly Profile[], chatProfileId: string | undefined): Profile | undefined {
  if (!chatProfileId || chatProfileId === DEFAULT_PROFILE_ID) return undefined
  return profiles.find((profile) => profile.id === chatProfileId && !profile.archived)
}

/** Resolve an instance's optional isolated profile; default means legacy session. */
export function resolveInstanceProfile(profiles: readonly Profile[], instanceProfileId: string | undefined): Profile | undefined {
  if (!instanceProfileId || instanceProfileId === DEFAULT_PROFILE_ID) return undefined
  return profiles.find((profile) => profile.id === instanceProfileId && !profile.archived)
}

/** Remove an isolated profile and clear only per-link/per-instance references. */
export function removeProfileReferences(
  profiles: readonly Profile[],
  links: readonly WebChatConfig[],
  instances: readonly DshInstance[],
  profileId: string
): { profiles: Profile[]; links: WebChatConfig[]; instances: DshInstance[] } {
  if (profileId === DEFAULT_PROFILE_ID) {
    return { profiles: [...profiles], links: [...links], instances: [...instances] }
  }
  return {
    profiles: profiles.filter((profile) => profile.id !== profileId),
    links: links.map((link) => link.profileId === profileId ? { ...link, profileId: undefined } : link),
    instances: instances.map((instance) => instance.profileId === profileId ? { ...instance, profileId: undefined } : instance)
  }
}