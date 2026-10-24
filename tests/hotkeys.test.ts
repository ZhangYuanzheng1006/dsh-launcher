import { describe, expect, it } from 'vitest'
import type { DshInstance, Group, HarnessStatus, WebChatConfig } from '../src/shared/types'
import {
  DEFAULT_HOTKEY_SETTINGS,
  INITIAL_LEADER_STATE,
  LLKHF_EXTENDED,
  buildHotkeyTargets,
  digitForVirtualKey,
  findHotkeyTargetByDigit,
  guideKeyForEvent,
  hotkeyNumbersForTargets,
  normalizeHotkeySettings,
  parseWindowHotkeyDigit,
  reduceLeaderState,
  type LeaderKey,
  type LeaderState
} from '../src/shared/hotkeys'

function instance(id: string, enabled = true): DshInstance {
  return { id, name: id, profile: 'web', port: 0, autoStart: false, description: '', enabled }
}

function link(id: string, patch: Partial<WebChatConfig> = {}): WebChatConfig {
  return { id, name: id, description: '', url: `https://${id}.example`, hidden: false, ...patch }
}

function group(id: string, kind: Group['kind'], patch: Partial<Group> = {}): Group {
  return {
    id,
    name: id,
    char: id[0]?.toUpperCase() ?? 'G',
    color: '#4F7DFF',
    kind,
    showInTopBar: true,
    visibleInstances: [],
    visibleLinks: [],
    ...patch
  }
}

function states(entries: Record<string, HarnessStatus | { status: HarnessStatus; guiAttached?: boolean }>): Record<string, { status: HarnessStatus; guiAttached?: boolean }> {
  return Object.fromEntries(Object.entries(entries).map(([id, value]) => [id, typeof value === 'string' ? { status: value } : value]))
}

describe('hotkey numbering', () => {
  it('orders running instances then visible links and excludes stopped ones', () => {
    const g = group('g1', 'group', { visibleInstances: ['a', 'b', 'c'], visibleLinks: ['s1'] })
    const target = buildHotkeyTargets(
      g,
      [instance('a'), instance('b'), instance('c')],
      [link('s1'), link('s2'), link('p1', { groupId: 'g1' }), link('hidden', { hidden: true })],
      states({ a: 'running', b: 'stopped', c: 'external' })
    )
    expect(target.map((item) => `${item.kind}:${item.id}:${item.digit}`)).toEqual([
      'instance:a:1',
      'link:s1:2',
      'link:p1:3'
    ])
    expect(target.filter((item) => item.kind === 'instance').map((item) => item.running)).toEqual([true])
  })

  it('keeps page order and excludes transitional, error, and un-attached external instances', () => {
    const g = group('home', 'home')
    const target = buildHotkeyTargets(
      g,
      [instance('a'), instance('b'), instance('c'), instance('d'), instance('e'), instance('f')],
      [],
      states({
        a: 'running',
        b: 'starting',
        c: 'error',
        d: 'degraded',
        e: 'external',
        f: { status: 'external', guiAttached: true }
      })
    )
    expect(target.map((item) => item.id)).toEqual(['a', 'd', 'f'])
  })

  it('caps at ten targets and uses 0 for the tenth', () => {
    const instances = Array.from({ length: 8 }, (_, index) => instance(`i${index + 1}`))
    const links = Array.from({ length: 5 }, (_, index) => link(`l${index + 1}`))
    const target = buildHotkeyTargets(
      group('home', 'home'),
      instances,
      links,
      states(Object.fromEntries(instances.map((item) => [item.id, 'running' as HarnessStatus])))
    )
    expect(target).toHaveLength(10)
    expect(target[9]?.digit).toBe('0')
    expect(target.map((item) => item.id)).toEqual(['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8', 'l1', 'l2'])
  })

  it('excludes disabled instances, stopped instances, and links outside the current group', () => {
    const g = group('g1', 'group', { visibleInstances: ['visible', 'hidden'], visibleLinks: ['shared'] })
    const target = buildHotkeyTargets(
      g,
      [instance('visible'), instance('hidden', false), instance('other')],
      [link('shared'), link('private-other', { groupId: 'g2' })],
      states({ visible: 'running' })
    )
    expect(target.map((item) => item.id)).toEqual(['visible', 'shared'])
  })

  it('resolves a digit to the current target and rejects unmapped digits', () => {
    const targets = buildHotkeyTargets(
      group('home', 'home'),
      [instance('a')],
      [link('l1')],
      states({ a: 'running' })
    )
    expect(findHotkeyTargetByDigit(targets, '1')?.id).toBe('a')
    expect(findHotkeyTargetByDigit(targets, '2')?.id).toBe('l1')
    expect(findHotkeyTargetByDigit(targets, '0')).toBeUndefined()
  })

  it('projects id to badge digit maps', () => {
    const target = buildHotkeyTargets(
      group('home', 'home'),
      [instance('a'), instance('b')],
      [link('l1')],
      states({ a: 'running' })
    )
    expect(hotkeyNumbersForTargets(target)).toEqual({
      instances: { a: '1' },
      links: { l1: '2' }
    })
  })
})

describe('hotkey settings', () => {
  it('fills approved defaults and clamps timeout', () => {
    expect(normalizeHotkeySettings()).toEqual(DEFAULT_HOTKEY_SETTINGS)
    expect(normalizeHotkeySettings({ leaderTimeoutMs: 50 }).leaderTimeoutMs).toBe(300)
    expect(normalizeHotkeySettings({ leaderTimeoutMs: 9000 }).leaderTimeoutMs).toBe(5000)
    expect(normalizeHotkeySettings({ leaderKeys: ['capsLock', 'capsLock', 'bad' as never] }).leaderKeys).toEqual(['capsLock'])
  })

  it('defaults Copilot takeover on and preserves an explicit opt-out', () => {
    expect(DEFAULT_HOTKEY_SETTINGS.captureCopilot).toBe(true)
    expect(normalizeHotkeySettings({ captureCopilot: false }).captureCopilot).toBe(false)
  })

  it('keeps an explicitly empty leader list', () => {
    expect(normalizeHotkeySettings({ leaderKeys: [] }).leaderKeys).toEqual([])
  })
})

describe('key parsing', () => {
  it('accepts only the exact window-local Alt+digit chord', () => {
    const base = { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }
    expect(parseWindowHotkeyDigit({ ...base, key: '1' })).toBe('1')
    expect(parseWindowHotkeyDigit({ ...base, key: '0' })).toBe('0')
    expect(parseWindowHotkeyDigit({ ...base, key: 'a' })).toBeNull()
    expect(parseWindowHotkeyDigit({ ...base, key: '1', ctrlKey: true })).toBeNull()
    expect(parseWindowHotkeyDigit({ ...base, key: '1', shiftKey: true })).toBeNull()
    expect(parseWindowHotkeyDigit({ ...base, key: '1', repeat: true })).toBeNull()
    expect(parseWindowHotkeyDigit({ ...base, altKey: false, key: '1' })).toBeNull()
  })

  it('maps both top-row and numpad digits', () => {
    expect(digitForVirtualKey(0x31)).toBe('1')
    expect(digitForVirtualKey(0x39)).toBe('9')
    expect(digitForVirtualKey(0x30)).toBe('0')
    expect(digitForVirtualKey(0x61)).toBe('1')
    expect(digitForVirtualKey(0x60)).toBe('0')
    expect(digitForVirtualKey(0x41)).toBeNull()
  })

  it('recognizes configured guide keys and rejects left Alt', () => {
    const allGuides = { ...DEFAULT_HOTKEY_SETTINGS, leaderKeys: ['apps', 'copilot', 'rightAlt', 'capsLock'] as LeaderKey[] }
    const mods = (win = false, shift = false, ctrl = false, alt = false) => ({ win, shift, ctrl, alt })
    expect(guideKeyForEvent({ virtualKey: 0x5d, scanCode: 0, flags: 0 }, allGuides, mods())).toBe('apps')
    expect(guideKeyForEvent({ virtualKey: 0x12, scanCode: 0, flags: LLKHF_EXTENDED }, allGuides, mods())).toBe('rightAlt')
    expect(guideKeyForEvent({ virtualKey: 0x12, scanCode: 0, flags: 0 }, allGuides, mods())).toBeNull()
    expect(guideKeyForEvent({ virtualKey: 0x14, scanCode: 0, flags: 0 }, allGuides, mods())).toBe('capsLock')
    expect(guideKeyForEvent({ virtualKey: 0x86, scanCode: 0, flags: 0 }, allGuides, mods(true, true))).toBe('copilot')
    expect(guideKeyForEvent({ virtualKey: 0x86, scanCode: 0, flags: 0 }, allGuides, mods(true, false))).toBe('copilot')
    expect(guideKeyForEvent({ virtualKey: 0x53, scanCode: 0, flags: 0 }, allGuides, mods(true))).toBe('copilot')
    expect(guideKeyForEvent({ virtualKey: 0x43, scanCode: 0, flags: 0 }, allGuides, mods(true))).toBe('copilot')
    expect(guideKeyForEvent({ virtualKey: 0x53, scanCode: 0, flags: 0 }, allGuides, mods(true, true))).toBeNull()
    expect(guideKeyForEvent({ virtualKey: 0x53, scanCode: 0, flags: 0 }, allGuides, mods(true, false, true))).toBeNull()
    expect(guideKeyForEvent({ virtualKey: 0x5d, scanCode: 0, flags: 0 }, { ...DEFAULT_HOTKEY_SETTINGS, leaderKeys: [] }, mods())).toBeNull()
    expect(guideKeyForEvent({ virtualKey: 0x5d, scanCode: 0, flags: 0 }, DEFAULT_HOTKEY_SETTINGS, mods())).toBe('apps')
    expect(guideKeyForEvent({ virtualKey: 0x12, scanCode: 0, flags: LLKHF_EXTENDED }, DEFAULT_HOTKEY_SETTINGS, mods())).toBeNull()
    expect(guideKeyForEvent({ virtualKey: 0x86, scanCode: 0, flags: 0 }, { ...DEFAULT_HOTKEY_SETTINGS, captureCopilot: false, leaderKeys: ['apps', 'copilot'] }, mods(true, true))).toBeNull()
  })
})

describe('leader state machine', () => {
  function activated(): LeaderState {
    return reduceLeaderState(INITIAL_LEADER_STATE, {
      type: 'guide-down',
      guideKey: 'apps',
      virtualKey: 0x5d
    }).state
  }

  it('activates on a guide key and consumes a digit', () => {
    const start = reduceLeaderState(INITIAL_LEADER_STATE, {
      type: 'guide-down',
      guideKey: 'apps',
      virtualKey: 0x5d
    })
    expect(start.swallow).toBe(true)
    expect(start.state.active).toBe(true)
    expect(start.state.guideHeld).toBe(true)
    expect(start.effects).toContainEqual({ type: 'leader-active', guideKey: 'apps' })
    expect(start.effects).toContainEqual({ type: 'timer-start' })

    const digit = reduceLeaderState(start.state, { type: 'digit-down', digit: '4', virtualKey: 0x34 })
    expect(digit.swallow).toBe(true)
    expect(digit.state.active).toBe(false)
    expect(digit.state.guideHeld).toBe(false)
    expect(digit.state.capturedVirtualKeys).toEqual([0x5d, 0x34])
    expect(digit.effects).toContainEqual({ type: 'trigger', digit: '4' })
  })

  it('cancels on Escape and replays the swallowed guide key', () => {
    const escape = reduceLeaderState(activated(), { type: 'escape-down', virtualKey: 0x1b })
    expect(escape.swallow).toBe(true)
    expect(escape.state.active).toBe(false)
    expect(escape.state.capturedVirtualKeys).toEqual([0x5d, 0x1b])
    expect(escape.effects).toContainEqual({ type: 'replay-guide', guideKey: 'apps' })
  })

  it('pauses timeout while held, then keeps the badge for one timeout after release', () => {
    const held = activated()
    const pause = reduceLeaderState(held, { type: 'timeout' })
    expect(pause.state).toBe(held)
    expect(pause.state.active).toBe(true)
    expect(pause.effects).toEqual([{ type: 'timer-start' }])

    const release = reduceLeaderState(held, { type: 'key-up', virtualKey: 0x5d })
    expect(release.swallow).toBe(true)
    expect(release.state.active).toBe(true)
    expect(release.state.guideHeld).toBe(false)
    expect(release.state.capturedVirtualKeys).toEqual([])
    expect(release.effects).toEqual([{ type: 'timer-start' }])

    const timeout = reduceLeaderState(release.state, { type: 'timeout' })
    expect(timeout.state.active).toBe(false)
    expect(timeout.effects).toContainEqual({ type: 'leader-inactive', reason: 'timeout' })
    expect(timeout.effects).toContainEqual({ type: 'replay-guide', guideKey: 'apps' })
  })

  it('swallows only captured key-ups and ignores duplicate guide downs', () => {
    const state = activated()
    expect(reduceLeaderState(state, { type: 'key-up', virtualKey: 0x41 }).swallow).toBe(false)
    expect(reduceLeaderState(state, { type: 'key-up', virtualKey: 0x5d }).swallow).toBe(true)
    const duplicate = reduceLeaderState(state, { type: 'guide-down', guideKey: 'apps', virtualKey: 0x5d })
    expect(duplicate.swallow).toBe(true)
    expect(duplicate.state).toBe(state)
    expect(duplicate.effects).toEqual([])
  })

  it('ignores digits when inactive', () => {
    const result = reduceLeaderState(INITIAL_LEADER_STATE, { type: 'digit-down', digit: '1', virtualKey: 0x31 })
    expect(result.swallow).toBe(false)
    expect(result.effects).toEqual([])
  })
})
