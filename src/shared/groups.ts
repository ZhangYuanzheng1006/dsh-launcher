import type { DshInstance, Group, HistoryEntry, WebChatConfig } from './types'

/** Stable id of the fixed first group. */
export const HOME_GROUP_ID = 'home'
/** The first eight entries stay on the top bar; the rest live in the overflow menu. */
export const MAX_TOP_BAR_GROUPS = 8
/** Upper bound for each persisted recent-history list. */
export const MAX_HISTORY_ENTRIES = 50

export const HOME_GROUP_COLOR = '#3B82F6'

/** Create the immutable home group for a configuration. */
export function createHomeGroup(instances: readonly DshInstance[], links: readonly WebChatConfig[]): Group {
  return {
    id: HOME_GROUP_ID,
    name: '首页',
    char: '首',
    color: HOME_GROUP_COLOR,
    kind: 'home',
    showInTopBar: true,
    visibleInstances: instances.map((instance) => instance.id),
    visibleLinks: links.filter((link) => !link.groupId && !link.archived).map((link) => link.id)
  }
}

function fallbackHome(): Group {
  return createHomeGroup([], [])
}

/** Resolve the selected group, falling back to the fixed home group. */
export function resolveCurrentGroup(groups: readonly Group[], activeGroupId?: string): Group {
  return groups.find((group) => group.id === activeGroupId) ?? groups.find((group) => group.kind === 'home') ?? groups[0] ?? fallbackHome()
}

/** Enabled instances visible in a group. The home group always sees every enabled instance. */
export function visibleInstancesForGroup(group: Group, instances: readonly DshInstance[]): DshInstance[] {
  const enabled = instances.filter((instance) => instance.enabled !== false)
  if (group.kind === 'home') return enabled
  const ids = new Set(group.visibleInstances)
  return enabled.filter((instance) => ids.has(instance.id))
}

export interface VisibleGroupLinks {
  shared: WebChatConfig[]
  private: WebChatConfig[]
  all: WebChatConfig[]
}

/** Links visible in a group: shared links follow the visibility matrix; private links always belong to their group. */
export function visibleLinksForGroup(group: Group, links: readonly WebChatConfig[]): VisibleGroupLinks {
  const active = links.filter((link) => !link.archived)
  const shared = active.filter((link) => !link.groupId)
  const privateLinks = group.kind === 'home' ? [] : active.filter((link) => link.groupId === group.id)
  if (group.kind === 'home') return { shared, private: privateLinks, all: shared }
  const visible = new Set(group.visibleLinks)
  const selectedShared = shared.filter((link) => visible.has(link.id))
  return { shared: selectedShared, private: privateLinks, all: [...selectedShared, ...privateLinks] }
}

/** Normalize every visibility reference against the current instance/link ids. */
export function reconcileGroupReferences(
  groups: readonly Group[],
  instances: readonly DshInstance[],
  links: readonly WebChatConfig[]
): Group[] {
  const instanceIds = new Set(instances.map((instance) => instance.id))
  const sharedLinkIds = new Set(links.filter((link) => !link.archived && !link.groupId).map((link) => link.id))
  const privateByGroup = new Map<string, string[]>()
  for (const link of links) {
    if (link.archived || !link.groupId) continue
    const list = privateByGroup.get(link.groupId) ?? []
    list.push(link.id)
    privateByGroup.set(link.groupId, list)
  }

  const hasHome = groups.some((group) => group.kind === 'home')
  const source = hasHome ? groups : [createHomeGroup(instances, links), ...groups]
  return source.map((group, index) => {
    const unique = (values: readonly string[]): string[] => [...new Set(values)]
    if (group.kind === 'home') {
      return {
        ...group,
        id: HOME_GROUP_ID,
        char: '首',
        color: HOME_GROUP_COLOR,
        showInTopBar: true,
        visibleInstances: instances.map((instance) => instance.id),
        visibleLinks: [...sharedLinkIds]
      }
    }
    return {
      ...group,
      kind: 'group',
      showInTopBar: index === 0 ? false : group.showInTopBar === true,
      visibleInstances: unique(group.visibleInstances ?? []).filter((id) => instanceIds.has(id)),
      visibleLinks: unique([
        ...(group.visibleLinks ?? []).filter((id) => sharedLinkIds.has(id)),
        ...(privateByGroup.get(group.id) ?? [])
      ])
    }
  })
}

/** Remove dangling instance/link ids from every group. */
export function cascadeGroupReferences(
  groups: readonly Group[],
  valid: { instanceIds: ReadonlySet<string>; linkIds: ReadonlySet<string> }
): Group[] {
  return groups.map((group) => ({
    ...group,
    visibleInstances: [...new Set(group.visibleInstances.filter((id) => valid.instanceIds.has(id)))],
    visibleLinks: [...new Set(group.visibleLinks.filter((id) => valid.linkIds.has(id)))]
  }))
}

/** Toggle one instance/link reference in a group; home visibility is immutable. */
export function setGroupItemVisible(
  groups: readonly Group[],
  groupId: string,
  kind: 'instance' | 'link',
  itemId: string,
  visible: boolean
): Group[] {
  return groups.map((group) => {
    if (group.id !== groupId || group.kind === 'home') return group
    const current = kind === 'instance' ? group.visibleInstances : group.visibleLinks
    const next = visible ? [...current, itemId] : current.filter((id) => id !== itemId)
    return kind === 'instance'
      ? { ...group, visibleInstances: [...new Set(next)] }
      : { ...group, visibleLinks: [...new Set(next)] }
  })
}

/** Top-bar projection. Home is always first and at most eight groups are pinned. */
export function projectTopBarGroups(groups: readonly Group[]): { pinned: Group[]; overflow: Group[] } {
  const home = groups.find((group) => group.kind === 'home')
  const rest = groups.filter((group) => group.kind !== 'home')
  const pinnedRest = rest.filter((group) => group.showInTopBar).slice(0, MAX_TOP_BAR_GROUPS - (home ? 1 : 0))
  const pinnedIds = new Set(pinnedRest.map((group) => group.id))
  return {
    pinned: [...(home ? [home] : []), ...pinnedRest],
    overflow: rest.filter((group) => !pinnedIds.has(group.id))
  }
}

/** Move a non-home group before another non-home group while keeping home first. */
export function reorderGroups(groups: readonly Group[], sourceId: string, targetId: string): Group[] {
  const home = groups.find((group) => group.kind === 'home')
  const rest = groups.filter((group) => group.kind !== 'home')
  const from = rest.findIndex((group) => group.id === sourceId)
  const to = rest.findIndex((group) => group.id === targetId)
  if (from < 0 || to < 0 || from === to) return [...groups]
  const next = [...rest]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return home ? [home, ...next] : next
}

export interface DeleteGroupResult {
  groups: Group[]
  links: WebChatConfig[]
  archivedLinkIds: string[]
  fallbackGroupId: string
}

/** Delete a group, archive its private links, and only drop references to shared data. */
export function deleteGroupAndArchive(
  groups: readonly Group[],
  links: readonly WebChatConfig[],
  groupId: string,
  now = Date.now()
): DeleteGroupResult {
  const target = groups.find((group) => group.id === groupId)
  const home = groups.find((group) => group.kind === 'home')
  if (!target || target.kind === 'home') {
    return { groups: [...groups], links: [...links], archivedLinkIds: [], fallbackGroupId: home?.id ?? HOME_GROUP_ID }
  }
  const remaining = groups.filter((group) => group.id !== groupId)
  const archivedLinkIds: string[] = []
  const nextLinks = links.map((link) => {
    if (link.groupId !== groupId) return link
    archivedLinkIds.push(link.id)
    return {
      ...link,
      groupId: undefined,
      archived: true,
      archivedFromGroupId: groupId,
      archivedFromGroupName: target.name,
      archivedAt: now
    }
  })
  const archived = new Set(archivedLinkIds)
  const cleanedGroups = remaining.map((group) => ({
    ...group,
    visibleLinks: group.visibleLinks.filter((id) => !archived.has(id))
  }))
  return {
    groups: cleanedGroups,
    links: nextLinks,
    archivedLinkIds,
    fallbackGroupId: home?.id ?? HOME_GROUP_ID
  }
}

/** Restore one archived private link into a live group. */
export function restoreArchivedLink(
  groups: readonly Group[],
  links: readonly WebChatConfig[],
  linkId: string,
  targetGroupId?: string
): { groups: Group[]; links: WebChatConfig[] } {
  const link = links.find((item) => item.id === linkId)
  if (!link || !link.archived) return { groups: [...groups], links: [...links] }
  const target = groups.find((group) => group.id === targetGroupId) ?? groups.find((group) => group.kind === 'home')
  if (!target) return { groups: [...groups], links: [...links] }
  const isPrivateTarget = target.kind !== 'home'
  const restored: WebChatConfig = {
    ...link,
    archived: false,
    groupId: isPrivateTarget ? target.id : undefined,
    archivedAt: undefined,
    archivedFromGroupId: undefined,
    archivedFromGroupName: undefined
  }
  const nextLinks = links.map((item) => (item.id === linkId ? restored : item))
  const nextGroups = groups.map((group) => {
    if (group.id !== target.id) return group
    return group.kind === 'home' ? group : { ...group, visibleLinks: [...new Set([...group.visibleLinks, linkId])] }
  })
  return { groups: nextGroups, links: nextLinks }
}

/** Add one history entry, de-duplicated by link id and newest-first, capped for persistence. */
export function pushHistory(existing: readonly HistoryEntry[] | undefined, entry: HistoryEntry): HistoryEntry[] {
  const withoutCurrent = (existing ?? []).filter((item) => item.webChatId !== entry.webChatId)
  return [entry, ...withoutCurrent].slice(0, MAX_HISTORY_ENTRIES)
}

/** Every group shares the same recent-history list. */
export function historyForGroup(
  _group: Group,
  config: { recentHistory?: HistoryEntry[] }
): HistoryEntry[] {
  return config.recentHistory ?? []
}