// Pure hotkey rules shared by the renderer (badges + Alt+digit) and the main
// process (WH_KEYBOARD_LL leader state machine). No DOM or Electron imports.

import type { DshInstance, Group, HarnessStatus, WebChatConfig } from './types'
import { visibleInstancesForGroup, visibleLinksForGroup } from './groups'

/** Number printed on the first ten targets. `0` is target ten. */
export const HOTKEY_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const
export type HotkeyDigit = (typeof HOTKEY_DIGITS)[number]
/** The maximum number of targets that can carry a number badge. */
export const MAX_HOTKEY_TARGETS = HOTKEY_DIGITS.length

export const LEADER_KEYS = ['apps', 'copilot', 'rightAlt', 'capsLock'] as const
export type LeaderKey = (typeof LEADER_KEYS)[number]

/** Persisted settings for window and global number shortcuts. */
export interface HotkeySettings {
  /** Master switch. Disabled means neither badges nor shortcuts are active. */
  enabled: boolean
  /** Guide keys that enter leader mode. Empty disables the global leader path. */
  leaderKeys: LeaderKey[]
  /** 接管 Copilot 键:启用时整组 Win 组合被缓冲/拦截,关闭时原样放行系统搜索。 */
  captureCopilot: boolean
  /** How long leader mode waits for a digit, in milliseconds. */
  leaderTimeoutMs: number
}

/** Approved defaults: enabled, Apps + Copilot guides, 1.5 second window. */
export const DEFAULT_HOTKEY_SETTINGS: HotkeySettings = {
  enabled: true,
  leaderKeys: ['apps', 'copilot'],
  captureCopilot: true,
  leaderTimeoutMs: 1500
}

/** Whether `value` is one of the supported guide-key identifiers. */
export function isLeaderKey(value: unknown): value is LeaderKey {
  return typeof value === 'string' && (LEADER_KEYS as readonly string[]).includes(value)
}

/**
 * Coerce persisted or partial settings into the supported range.
 *
 * Missing leader keys keep the approved default. An explicitly empty list stays
 * empty so the user can turn off global leader mode while keeping Alt+digit.
 * Timeouts are rounded and clamped to 300..5000 ms.
 *
 * @param value persisted or partial settings
 * @returns normalized settings, always a fresh object
 */
export function normalizeHotkeySettings(value?: Partial<HotkeySettings> | null): HotkeySettings {
  const rawKeys = Array.isArray(value?.leaderKeys) ? value.leaderKeys : DEFAULT_HOTKEY_SETTINGS.leaderKeys
  const leaderKeys = [...new Set(rawKeys.filter(isLeaderKey))]
  const timeout = typeof value?.leaderTimeoutMs === 'number' && Number.isFinite(value.leaderTimeoutMs)
    ? Math.min(5000, Math.max(300, Math.round(value.leaderTimeoutMs)))
    : DEFAULT_HOTKEY_SETTINGS.leaderTimeoutMs
  return {
    enabled: value?.enabled !== false,
    leaderKeys,
    captureCopilot: value?.captureCopilot !== false,
    leaderTimeoutMs: timeout
  }
}

/** A sidebar target that receives a number badge. */
export interface InstanceHotkeyTarget {
  kind: 'instance'
  id: string
  name: string
  digit: HotkeyDigit
  /** True for a process that is already up (including transitions and external). */
  running: boolean
}

/** A visible link target that receives a number badge. */
export interface LinkHotkeyTarget {
  kind: 'link'
  id: string
  name: string
  digit: HotkeyDigit
}

export type HotkeyTarget = InstanceHotkeyTarget | LinkHotkeyTarget

/** The subset of harness state used to decide whether an instance can be numbered. */
export interface HotkeyInstanceState {
  status: HarnessStatus
  /** GUI instances that are externally running only count once attached. */
  guiAttached?: boolean
}

/**
 * Whether an instance is usable by a number shortcut.
 *
 * A plain `external` process is not enough: detached GUI windows are not
 * "taken over", so only `external` with `guiAttached === true` participates.
 *
 * @param state current harness state, if the instance has reported one
 * @returns true for running/degraded or an attached external instance
 */
export function isHotkeyRunningStatus(state: HotkeyInstanceState | undefined): boolean {
  if (!state) return false
  if (state.status === 'running' || state.status === 'degraded') return true
  return state.status === 'external' && state.guiAttached === true
}

/**
 * Build the numbered target list for the current group.
 *
 * Order is running instances in instance-page order, then every visible link in
 * sidebar order (shared links first, then private). Stopped or detached-external
 * instances do not receive numbers. Only the current group's visible, enabled,
 * non-hidden items participate.
 *
 * @param group current workspace group
 * @param instances every configured instance, in instance-page order
 * @param links every configured link
 * @param states current harness state per instance
 * @returns at most ten numbered targets, in order
 */
export function buildHotkeyTargets(
  group: Group,
  instances: readonly DshInstance[],
  links: readonly WebChatConfig[],
  states: Readonly<Record<string, HotkeyInstanceState | undefined>>
): HotkeyTarget[] {
  const running = visibleInstancesForGroup(group, instances)
    .filter((instance) => isHotkeyRunningStatus(states[instance.id]))
  const visibleLinks = visibleLinksForGroup(group, links).all.filter((link) => !link.hidden)
  const ordered: Array<Omit<InstanceHotkeyTarget, 'digit'> | Omit<LinkHotkeyTarget, 'digit'>> = [
    ...running.map((instance) => ({
      kind: 'instance' as const,
      id: instance.id,
      name: instance.name,
      running: true
    })),
    ...visibleLinks.map((link) => ({
      kind: 'link' as const,
      id: link.id,
      name: link.name
    }))
  ]
  return ordered.slice(0, MAX_HOTKEY_TARGETS).map((target, index) => ({
    ...target,
    digit: HOTKEY_DIGITS[index]
  }))
}

/** Split numbered targets into instance/link lookup maps for the sidebar badges. */
export function hotkeyNumbersForTargets(targets: readonly HotkeyTarget[]): {
  instances: Record<string, HotkeyDigit>
  links: Record<string, HotkeyDigit>
} {
  const instances: Record<string, HotkeyDigit> = {}
  const links: Record<string, HotkeyDigit> = {}
  for (const target of targets) {
    if (target.kind === 'instance') instances[target.id] = target.digit
    else links[target.id] = target.digit
  }
  return { instances, links }
}

/** Resolve the digit pressed in leader mode to its current-group target. */
export function findHotkeyTargetByDigit(targets: readonly HotkeyTarget[], digit: string): HotkeyTarget | undefined {
  return targets.find((target) => target.digit === digit)
}

/** KeyboardEvent-like fields needed to recognize the window-local Alt+digit shortcut. */
export interface WindowHotkeyEventLike {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  repeat?: boolean
}

/**
 * Return the digit pressed for the window-local shortcut, or null.
 *
 * Only the exact Alt+digit chord is accepted. Win/Ctrl/Shift combinations are
 * deliberately excluded because the Settings UI does not offer them.
 *
 * @param event DOM keyboard event (or a structurally identical test object)
 * @returns `'1'..'9'/'0'`, or null when this is not an Alt+digit chord
 */
export function parseWindowHotkeyDigit(event: WindowHotkeyEventLike): HotkeyDigit | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return null
  return (HOTKEY_DIGITS as readonly string[]).includes(event.key) ? event.key as HotkeyDigit : null
}

/** Low-level keyboard hook flags supplied by Windows. */
export interface NativeKeyEvent {
  /** Win32 virtual-key code. */
  virtualKey: number
  /** Hardware scan code. */
  scanCode: number
  /** KBDLLHOOKSTRUCT.flags. */
  flags: number
  /** Application-defined SendInput marker, used to ignore our own replays. */
  extraInfo?: number
}

export const LLKHF_EXTENDED = 0x01
export const LLKHF_INJECTED = 0x10
export const LLKHF_UP = 0x80

/** Modifier state at the time of a hook event (tracked from the event stream). */
export interface NativeModifierState {
  win: boolean
  shift: boolean
  ctrl: boolean
  alt: boolean
}

/** Map a top-row or numpad virtual key to a hotkey digit. */
export function digitForVirtualKey(virtualKey: number): HotkeyDigit | null {
  if (virtualKey >= 0x31 && virtualKey <= 0x39) return String(virtualKey - 0x30) as HotkeyDigit
  if (virtualKey === 0x30) return '0'
  if (virtualKey >= 0x61 && virtualKey <= 0x69) return String(virtualKey - 0x60) as HotkeyDigit
  if (virtualKey === 0x60) return '0'
  return null
}

/**
 * Identify a configured guide-key press.
 *
 * @param event raw key event
 * @param settings current hotkey settings
 * @param modifiers tracked modifier state (needed for Win+Shift+F23 Copilot)
 * @returns the guide key, or null for an ordinary key
 */
export function guideKeyForEvent(
  event: NativeKeyEvent,
  settings: HotkeySettings,
  modifiers: NativeModifierState
): LeaderKey | null {
  if ((event.flags & LLKHF_UP) !== 0) return null
  if (event.virtualKey === 0x5D) return settings.leaderKeys.includes('apps') ? 'apps' : null
  if (event.virtualKey === 0x12 && (event.flags & LLKHF_EXTENDED) !== 0) {
    return settings.leaderKeys.includes('rightAlt') ? 'rightAlt' : null
  }
  if (event.virtualKey === 0x14) return settings.leaderKeys.includes('capsLock') ? 'capsLock' : null
  if (!settings.captureCopilot || !settings.leaderKeys.includes('copilot')) return null
  // Standard Copilot keys send Win+Shift+F23. Some OEM firmware maps the same
  // hardware key to Win+S (Windows Search) or Win+C. The no-extra-modifier guard
  // keeps Win+Shift+S (Snipping Tool) and Ctrl/Alt chords out of this capture.
  const plainWinOnly = modifiers.win && !modifiers.shift && !modifiers.ctrl && !modifiers.alt
  if (event.virtualKey === 0x86 && modifiers.win && !modifiers.ctrl && !modifiers.alt) return 'copilot'
  if ((event.virtualKey === 0x53 || event.virtualKey === 0x43) && plainWinOnly) return 'copilot'
  return null
}

/** Whether the raw event is the Escape key going down. */
export function isEscapeDown(event: NativeKeyEvent): boolean {
  return event.virtualKey === 0x1B && (event.flags & LLKHF_UP) === 0
}

/** Whether the raw event belongs to our own synthetic replay. */
export function isReplayEvent(event: NativeKeyEvent, signature: number): boolean {
  return (event.flags & LLKHF_INJECTED) !== 0 && event.extraInfo === signature
}

/** Immutable state consumed by {@link reduceLeaderState}. */
export interface LeaderState {
  active: boolean
  guideKey: LeaderKey | null
  /** True while the physical guide key is still down; timeout is paused then. */
  guideHeld: boolean
  /** Keys whose down event was swallowed and whose up event must also be swallowed. */
  capturedVirtualKeys: number[]
}

export const INITIAL_LEADER_STATE: LeaderState = {
  active: false,
  guideKey: null,
  guideHeld: false,
  capturedVirtualKeys: []
}

export type LeaderEvent =
  | { type: 'guide-down'; guideKey: LeaderKey; virtualKey: number }
  | { type: 'digit-down'; digit: HotkeyDigit; virtualKey: number }
  | { type: 'escape-down'; virtualKey: number }
  | { type: 'key-up'; virtualKey: number }
  | { type: 'timeout' }
  | { type: 'disable' }

export type LeaderEffect =
  | { type: 'leader-active'; guideKey: LeaderKey }
  | { type: 'leader-inactive'; reason: 'digit' | 'escape' | 'timeout' | 'disable' }
  | { type: 'timer-start' }
  | { type: 'timer-clear' }
  | { type: 'trigger'; digit: HotkeyDigit }
  | { type: 'replay-guide'; guideKey: LeaderKey }

export interface LeaderTransition {
  state: LeaderState
  effects: LeaderEffect[]
  /** True when the low-level hook must return 1 instead of forwarding the key. */
  swallow: boolean
}

function transition(state: LeaderState, effects: LeaderEffect[], swallow: boolean): LeaderTransition {
  return { state, effects, swallow }
}

/**
 * Pure leader-mode state machine.
 *
 * Guide key downs are captured and held; badges stay active while the key is
 * held and for one timeout after release. A digit consumes the capture and
 * fires an action. Escape/timeout releases the capture by asking the caller to
 * replay the original guide key. Subsequent up events for captured keys are
 * swallowed so the OS never sees half a key press.
 *
 * @param state current machine state
 * @param event one hook/timer event
 * @returns next state plus side-effect instructions for the caller
 */
export function reduceLeaderState(state: LeaderState, event: LeaderEvent): LeaderTransition {
  if (event.type === 'key-up') {
    if (!state.capturedVirtualKeys.includes(event.virtualKey)) return transition(state, [], false)
    const capturedVirtualKeys = state.capturedVirtualKeys.filter((key) => key !== event.virtualKey)
    // Keep the badges up for a full timeout after the guide key is released;
    // while the key is held, the timer is paused instead of cancelling.
    const releasedGuide = state.active && state.guideHeld
    return transition({
      ...state,
      guideHeld: releasedGuide ? false : state.guideHeld,
      capturedVirtualKeys
    }, releasedGuide ? [{ type: 'timer-start' }] : [], true)
  }
  if (event.type === 'disable') {
    if (!state.active && state.capturedVirtualKeys.length === 0) return transition(state, [], false)
    return transition(INITIAL_LEADER_STATE, [
      { type: 'timer-clear' },
      ...(state.active ? [{ type: 'leader-inactive' as const, reason: 'disable' as const }] : [])
    ], false)
  }
  if (event.type === 'timeout') {
    if (!state.active) return transition(state, [], false)
    // A held guide key keeps the badge visible; only release starts the
    // 1.5s window for pressing a digit.
    if (state.guideHeld) return transition(state, [{ type: 'timer-start' }], false)
    return transition({
      active: false,
      guideKey: null,
      guideHeld: false,
      // Keep the physical guide key captured until its key-up so the OS never
      // sees half a press after the deferred replay completes.
      capturedVirtualKeys: state.capturedVirtualKeys
    }, [
      { type: 'timer-clear' },
      { type: 'leader-inactive', reason: 'timeout' },
      ...(state.guideKey ? [{ type: 'replay-guide' as const, guideKey: state.guideKey }] : [])
    ], false)
  }
  if (event.type === 'guide-down') {
    if (state.active) return transition(state, [], true)
    return transition({
      active: true,
      guideKey: event.guideKey,
      guideHeld: true,
      capturedVirtualKeys: [...state.capturedVirtualKeys, event.virtualKey]
    }, [
      { type: 'leader-active', guideKey: event.guideKey },
      { type: 'timer-start' }
    ], true)
  }
  if (event.type === 'digit-down') {
    if (!state.active) return transition(state, [], false)
    return transition({
      ...state,
      active: false,
      guideKey: null,
      guideHeld: false,
      capturedVirtualKeys: [...state.capturedVirtualKeys, event.virtualKey]
    }, [
      { type: 'timer-clear' },
      { type: 'leader-inactive', reason: 'digit' },
      { type: 'trigger', digit: event.digit }
    ], true)
  }
  // escape-down
  if (!state.active) return transition(state, [], false)
  return transition({
    ...state,
    active: false,
    guideKey: null,
    guideHeld: false,
    capturedVirtualKeys: [...state.capturedVirtualKeys, event.virtualKey]
  }, [
    { type: 'timer-clear' },
    { type: 'leader-inactive', reason: 'escape' },
    ...(state.guideKey ? [{ type: 'replay-guide' as const, guideKey: state.guideKey }] : [])
  ], true)
}
