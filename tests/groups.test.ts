import { describe, expect, it } from 'vitest'
import type { DshInstance, Group, WebChatConfig } from '../src/shared/types'
import {
  cascadeGroupReferences,
  createHomeGroup,
  deleteGroupAndArchive,
  historyForGroup,
  MAX_TOP_BAR_GROUPS,
  projectTopBarGroups,
  pushHistory,
  reconcileGroupReferences,
  reorderGroups,
  restoreArchivedLink,
  setGroupItemVisible,
  visibleInstancesForGroup,
  visibleLinksForGroup
} from '../src/shared/groups'

function instance(id: string, enabled = true): DshInstance {
  return { id, name: id, profile: 'web', port: 0, autoStart: false, description: '', enabled }
}
function link(id: string, groupId?: string): WebChatConfig {
  return { id, name: id, description: '', url: `https://${id}.example`, hidden: false, ...(groupId ? { groupId } : {}) }
}
function group(id: string, kind: Group['kind'], patch: Partial<Group> = {}): Group {
  return {
    id,
    name: id,
    char: id[0].toUpperCase(),
    color: '#4F7DFF',
    kind,
    showInTopBar: true,
    visibleInstances: [],
    visibleLinks: [],
    ...patch
  }
}

describe('group visibility', () => {
  it('shows every enabled instance and shared link in Home', () => {
    const home = createHomeGroup([instance('a'), instance('b', false)], [link('s1'), link('s2'), link('p1', 'g1')])
    expect(visibleInstancesForGroup(home, [instance('a'), instance('b', false)]).map((item) => item.id)).toEqual(['a'])
    const visible = visibleLinksForGroup(home, [link('s1'), link('s2'), link('p1', 'g1')])
    expect(visible.shared.map((item) => item.id)).toEqual(['s1', 's2'])
    expect(visible.private).toEqual([])
  })

  it('filters a normal group by its matrix and always includes its private links', () => {
    const g = group('g1', 'group', { visibleInstances: ['b'], visibleLinks: ['s2'] })
    const visible = visibleLinksForGroup(g, [link('s1'), link('s2'), link('p1', 'g1')])
    expect(visibleInstancesForGroup(g, [instance('a'), instance('b')]).map((item) => item.id)).toEqual(['b'])
    expect(visible.all.map((item) => item.id)).toEqual(['s2', 'p1'])
  })

  it('toggles references without mutating the source groups', () => {
    const source = [group('g1', 'group')]
    const visible = setGroupItemVisible(source, 'g1', 'link', 's1', true)
    expect(visible[0].visibleLinks).toEqual(['s1'])
    expect(source[0].visibleLinks).toEqual([])
    expect(setGroupItemVisible(visible, 'g1', 'link', 's1', false)[0].visibleLinks).toEqual([])
  })
})

describe('group reference maintenance', () => {
  it('cascades deleted instance and link ids out of every group', () => {
    const groups = [
      group('home', 'home', { visibleInstances: ['i1', 'i2'], visibleLinks: ['l1', 'l2'] }),
      group('g1', 'group', { visibleInstances: ['i1', 'i2'], visibleLinks: ['l1', 'l2'] })
    ]
    const next = cascadeGroupReferences(groups, { instanceIds: new Set(['i1']), linkIds: new Set(['l2']) })
    expect(next.every((item) => item.visibleInstances.includes('i2') === false)).toBe(true)
    expect(next.every((item) => item.visibleLinks.includes('l1') === false)).toBe(true)
    expect(next[0].visibleInstances).toEqual(['i1'])
    expect(next[1].visibleLinks).toEqual(['l2'])
  })

  it('archives private links and preserves shared links when deleting a group', () => {
    const groups = [group('home', 'home'), group('g1', 'group', { visibleLinks: ['shared', 'private'] })]
    const links = [link('shared'), link('private', 'g1')]
    const result = deleteGroupAndArchive(groups, links, 'g1', 42)
    expect(result.groups.map((item) => item.id)).toEqual(['home'])
    expect(result.links.find((item) => item.id === 'shared')?.archived).toBeUndefined()
    expect(result.links.find((item) => item.id === 'private')).toMatchObject({
      archived: true,
      archivedFromGroupId: 'g1',
      archivedFromGroupName: 'g1',
      archivedAt: 42
    })
    expect(result.archivedLinkIds).toEqual(['private'])
  })

  it('restores an archived private link to a live group', () => {
    const archived = { ...link('private'), archived: true, archivedFromGroupId: 'g1', archivedFromGroupName: 'g1' }
    const restored = restoreArchivedLink([group('home', 'home')], [archived], 'private')
    expect(restored.links[0].archived).toBe(false)
    expect(restored.links[0].groupId).toBeUndefined()
  })

  it('reconciles stale ids and backfills home visibility', () => {
    const groups = [
      group('home', 'home', { visibleInstances: ['stale'], visibleLinks: ['stale'] }),
      group('g1', 'group', { visibleInstances: ['a', 'stale'], visibleLinks: ['s1', 'p1'] })
    ]
    const next = reconcileGroupReferences(groups, [instance('a')], [link('s1'), link('p1', 'g1')])
    expect(next[0].visibleInstances).toEqual(['a'])
    expect(next[0].visibleLinks).toEqual(['s1'])
    expect(next[1].visibleInstances).toEqual(['a'])
    expect(next[1].visibleLinks).toEqual(['s1', 'p1'])
  })
})

describe('top bar projection and history', () => {
  it('keeps Home first and caps pinned groups at eight', () => {
    const groups = [group('home', 'home'), ...Array.from({ length: 10 }, (_, index) => group(`g${index}`, 'group'))]
    const projected = projectTopBarGroups(groups)
    expect(projected.pinned).toHaveLength(MAX_TOP_BAR_GROUPS)
    expect(projected.pinned[0].id).toBe('home')
    expect(projected.overflow.map((item) => item.id)).toEqual(['g7', 'g8', 'g9'])
  })

  it('reorders groups while keeping Home fixed first', () => {
    const groups = [group('home', 'home'), group('a', 'group'), group('b', 'group'), group('c', 'group')]
    const next = reorderGroups(groups, 'c', 'b')
    expect(next.map((item) => item.id)).toEqual(['home', 'a', 'c', 'b'])
  })
  it('shares one recent-history list and de-duplicates entries by link id', () => {
    const target = group('g1', 'group')
    const list = pushHistory([{ id: 'old', webChatId: 'w1', name: 'Old', url: 'https://old', groupId: 'g', openedAt: 1 }], {
      id: 'new', webChatId: 'w1', name: 'New', url: 'https://new', groupId: 'g1', openedAt: 2
    })
    expect(list.map((item) => item.id)).toEqual(['new'])
    expect(historyForGroup(target, { recentHistory: list })).toEqual(list)
  })
})