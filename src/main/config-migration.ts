import type { DshInstance, Group, HistoryEntry, LauncherConfig, WebChatConfig } from '../shared/types'
import {
  createHomeGroup,
  HOME_GROUP_ID as HOME_ID,
  MAX_HISTORY_ENTRIES,
  reconcileGroupReferences,
  resolveCurrentGroup
} from '../shared/groups'
import { DEFAULT_PROFILE_ID, normalizeProfiles } from '../shared/profiles'

/** Current persisted config schema version. Bump when a migration changes on-disk shape. */
export const CURRENT_CONFIG_VERSION = 6

/** Stable id of the fixed first group. */
export const HOME_GROUP_ID = HOME_ID

export interface ConfigMigrationResult {
  config: LauncherConfig
  /** True when the persisted file should be rewritten after migration. */
  migrated: boolean
}

interface LegacyHistoryEntry extends HistoryEntry {
  groupKind?: string
}

type LegacyConfig = LauncherConfig & {
  tempHistory?: LegacyHistoryEntry[]
  recentHistory?: LegacyHistoryEntry[]
  groups?: Array<Group & { kind: string; profileId?: string }>
}

function mergeHistory(input: LegacyConfig): HistoryEntry[] {
  const source = [...(input.recentHistory ?? []), ...(input.tempHistory ?? [])]
  const normalized = source
    .filter((entry) => entry && typeof entry.webChatId === 'string')
    .map((entry) => ({
      id: String(entry.id ?? ''),
      webChatId: entry.webChatId,
      name: String(entry.name ?? ''),
      url: String(entry.url ?? ''),
      groupId: String(entry.groupId ?? ''),
      openedAt: Number(entry.openedAt) || 0
    }))
    .sort((left, right) => right.openedAt - left.openedAt)
  return normalized
    .filter((entry, index) => normalized.findIndex((item) => item.webChatId === entry.webChatId) === index)
    .slice(0, MAX_HISTORY_ENTRIES)
}

/**
 * Bring a parsed config up to the current schema.
 *
 * v6 keeps the home group plus homogeneous normal groups, removes legacy
 * temporary/persistent semantics and temp-history buckets, drops all instance
 * profile references, and preserves explicit isolated profiles only for web
 * links in v6+ configs. Links carried over from v5 and earlier are cleared so
 * the cookie-rescue defaultSession login state is restored once on upgrade.
 */
export function migrateLauncherConfig(input: LauncherConfig): ConfigMigrationResult {
  const legacy = input as LegacyConfig
  let migrated = false
  const profiles = normalizeProfiles(input.profiles, input.language === 'en' ? 'Default (Launcher)' : '默认资料（启动器）')
  if (JSON.stringify(profiles) !== JSON.stringify(input.profiles)) migrated = true
  const usableProfileIds = new Set(profiles.filter((profile) => !profile.archived).map((profile) => profile.id))
  const rawInstances = Array.isArray(input.instances) ? input.instances : []
  const rawLinks = Array.isArray(input.webChats) ? input.webChats : []

  let groups = Array.isArray(legacy.groups) ? legacy.groups : []
  if (groups.length === 0 || !groups.some((group) => group.kind === 'home')) {
    groups = [createHomeGroup(rawInstances, rawLinks), ...groups.filter((group) => group.kind !== 'home')]
    migrated = true
  }

  const home = groups.find((group) => group.kind === 'home')!
  const ordered = [home, ...groups.filter((group) => group.id !== home.id)]
  if (ordered.some((group, index) => group.id !== groups[index]?.id)) migrated = true

  const normalized = reconcileGroupReferences(
    ordered.map((group) => {
      // Strip legacy group-private profiles on read. Groups are visibility
      // containers only; cookie isolation is chosen per web link.
      const { profileId: _legacyGroupProfileId, ...base } = group as Group & { profileId?: string }
      const isHome = base.kind === 'home'
      return {
        ...base,
        name: base.name?.trim() || (isHome ? '首页' : 'Group'),
        char: Array.from(base.char?.trim() || (isHome ? '首' : '组'))[0] ?? '组',
        color: /^#[0-9a-f]{6}$/i.test(base.color ?? '') ? base.color : (isHome ? '#3B82F6' : '#4F7DFF'),
        kind: isHome ? 'home' : 'group' as const,
        showInTopBar: isHome ? true : base.showInTopBar !== false,
        visibleInstances: Array.isArray(base.visibleInstances) ? base.visibleInstances : [],
        visibleLinks: Array.isArray(base.visibleLinks) ? base.visibleLinks : []
      } satisfies Group
    }),
    rawInstances,
    rawLinks
  )
  if (JSON.stringify(normalized) !== JSON.stringify(input.groups)) migrated = true

  // Instances never isolate: all instance views stay on defaultSession.
  const instances: DshInstance[] = rawInstances.map((instance) => {
    const { profileId: _legacyProfileId, ...base } = instance as DshInstance & { profileId?: string }
    if (instance.profileId !== undefined) migrated = true
    return base
  })

  // v5 and older were the emergency all-default session recovery. Existing
  // links arrive without profileId. New v6 links may opt into an isolated profile.
  const forceClearLinkProfiles = (input.configVersion ?? 0) < 6
  const links: WebChatConfig[] = rawLinks.map((link) => {
    const profileId = !forceClearLinkProfiles &&
      link.profileId &&
      link.profileId !== DEFAULT_PROFILE_ID &&
      usableProfileIds.has(link.profileId)
      ? link.profileId
      : undefined
    if (profileId !== link.profileId) migrated = true
    if (profileId === link.profileId) return link
    const { profileId: _legacyLinkProfileId, ...base } = link as WebChatConfig & { profileId?: string }
    return base
  })

  const recentHistory = mergeHistory(legacy)
  const { tempHistory: _legacyTempHistory, ...inputWithoutTempHistory } = legacy
  const activeGroupId = resolveCurrentGroup(normalized, input.activeGroupId).id
  const next: LauncherConfig = {
    ...inputWithoutTempHistory,
    configVersion: CURRENT_CONFIG_VERSION,
    profiles,
    groups: normalized,
    instances,
    webChats: links,
    activeGroupId,
    recentHistory
  }
  if (input.configVersion !== CURRENT_CONFIG_VERSION || input.activeGroupId !== activeGroupId ||
      legacy.tempHistory !== undefined ||
      JSON.stringify(legacy.recentHistory ?? []) !== JSON.stringify(recentHistory) ||
      JSON.stringify(input.instances) !== JSON.stringify(instances) || JSON.stringify(input.webChats) !== JSON.stringify(links) ||
      JSON.stringify(input.groups) !== JSON.stringify(normalized)) {
    migrated = true
  }
  return { config: next, migrated }
}