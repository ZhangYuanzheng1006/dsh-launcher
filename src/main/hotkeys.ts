// Windows global leader keys. The low-level keyboard hook runs in the Electron
// main process; it defers a guide key's native action until leader mode either
// consumes a digit or cancels, in which case the original key is replayed.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import koffi from 'koffi'
import { broadcast } from './bus'
import { showLauncher } from './tray'
import {
  DEFAULT_HOTKEY_SETTINGS,
  INITIAL_LEADER_STATE,
  LLKHF_UP,
  digitForVirtualKey,
  guideKeyForEvent,
  isEscapeDown,
  isReplayEvent,
  normalizeHotkeySettings,
  reduceLeaderState,
  type HotkeyDigit,
  type HotkeySettings,
  type LeaderEffect,
  type LeaderKey,
  type LeaderState,
  type NativeKeyEvent
} from '../shared/hotkeys'

const WH_KEYBOARD_LL = 13
const KEYEVENTF_EXTENDEDKEY = 0x0001
const KEYEVENTF_KEYUP = 0x0002
const INPUT_KEYBOARD = 1
/** Marks keyboard events sent by our own deferred replay. */
const REPLAY_SIGNATURE = 0x4453484b
const VK_SHIFT = 0x10
const VK_CONTROL = 0x11
const VK_MENU = 0x12
const VK_LWIN = 0x5B
const VK_RWIN = 0x5C
const VK_S = 0x53
const VK_C = 0x43
const VK_F23 = 0x86
const VK_LSHIFT = 0xA0
const VK_RSHIFT = 0xA1
const VK_LCONTROL = 0xA2
const VK_RCONTROL = 0xA3
const VK_LMENU = 0xA4
const VK_RMENU = 0xA5
const HOTKEY_DEBUG_FLAG = 'hotkey-debug.on'

const user32 = process.platform === 'win32' ? koffi.load('user32.dll') : null
const kernel32 = process.platform === 'win32' ? koffi.load('kernel32.dll') : null

const KBDLLHOOKSTRUCT = koffi.struct('KBDLLHOOKSTRUCT', {
  vkCode: 'uint32_t',
  scanCode: 'uint32_t',
  flags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t'
})

const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32_t',
  dy: 'int32_t',
  mouseData: 'uint32_t',
  dwFlags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t'
})
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16_t',
  wScan: 'uint16_t',
  dwFlags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t'
})
const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', {
  uMsg: 'uint32_t',
  wParamL: 'uint16_t',
  wParamH: 'uint16_t'
})
const INPUT = koffi.struct('INPUT', {
  type: 'uint32_t',
  u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT })
})

const KeyboardHookProc = koffi.proto('intptr_t __stdcall KeyboardHookProc(int nCode, uintptr_t wParam, intptr_t lParam)')

const SetWindowsHookExW = user32?.func('__stdcall', 'SetWindowsHookExW', 'void *', [
  'int',
  koffi.pointer(KeyboardHookProc),
  'void *',
  'uint32_t'
]) ?? null
const UnhookWindowsHookEx = user32?.func('__stdcall', 'UnhookWindowsHookEx', 'bool', ['void *']) ?? null
const CallNextHookEx = user32?.func('__stdcall', 'CallNextHookEx', 'intptr_t', [
  'void *',
  'int',
  'uintptr_t',
  'intptr_t'
]) ?? null
const MapVirtualKeyW = user32?.func('__stdcall', 'MapVirtualKeyW', 'uint32_t', ['uint32_t', 'uint32_t']) ?? null
const SendInput = user32?.func('unsigned int __stdcall SendInput(unsigned int cInputs, INPUT *pInputs, int cbSize)') ?? null
const GetModuleHandleW = kernel32?.func('__stdcall', 'GetModuleHandleW', 'void *', ['char16_t *']) ?? null
const GetLastError = kernel32?.func('__stdcall', 'GetLastError', 'uint32_t', []) ?? null

interface SendInputEvent {
  type: number
  u: {
    ki: {
      wVk: number
      wScan: number
      dwFlags: number
      time: number
      dwExtraInfo: number
    }
  }
}

let settings: HotkeySettings = normalizeHotkeySettings(DEFAULT_HOTKEY_SETTINGS)
let hookProc: bigint | null = null
let hookHandle: bigint | null = null
let leader: LeaderState = INITIAL_LEADER_STATE
let timer: ReturnType<typeof setTimeout> | null = null
/** Physical keys currently down, used to recognize Win+Shift+F23. */
const pressed = new Set<number>()

interface CapturedPhysicalKey {
  virtualKey: number
  scanCode: number
  extended: boolean
}

/** A Windows key is held back until we know whether this is the Copilot chord. */
let bufferedWin: CapturedPhysicalKey | null = null
/** Physical keys whose down/up pair must not reach the shell. */
const swallowedPhysicalKeys = new Set<number>()
/** Modifiers that already reached the shell and must be released safely. */
const forwardedCopilotModifiers = new Set<number>()
/** Exact physical sequence to replay when leader mode times out / is cancelled. */
let copilotReplayKeys: number[] = []
let debugEnabled = false
let debugUntil = 0
let debugLines: string[] = []
let debugTimer: ReturnType<typeof setTimeout> | null = null
function isWindowsKey(virtualKey: number): boolean {
  return virtualKey === VK_LWIN || virtualKey === VK_RWIN
}

function isModifierKey(virtualKey: number): boolean {
  return virtualKey === VK_SHIFT || virtualKey === VK_CONTROL || virtualKey === VK_MENU ||
    virtualKey === VK_LSHIFT || virtualKey === VK_RSHIFT ||
    virtualKey === VK_LCONTROL || virtualKey === VK_RCONTROL ||
    virtualKey === VK_LMENU || virtualKey === VK_RMENU
}

function shouldCaptureCopilotKey(): boolean {
  return settings.enabled && settings.captureCopilot && settings.leaderKeys.includes('copilot')
}

function capturedKey(event: NativeKeyEvent): CapturedPhysicalKey {
  return {
    virtualKey: event.virtualKey,
    scanCode: event.scanCode,
    extended: (event.flags & 0x01) !== 0
  }
}

function debugLogPath(): string {
  return join(app.getPath('userData'), 'hotkey-debug.log')
}
function flushDebugLog(reason: string): void {
  if (debugTimer) clearTimeout(debugTimer)
  debugTimer = null
  if (!debugEnabled || debugLines.length === 0) return
  const text = '--- ' + new Date().toISOString() + ' ' + reason + ' ---\n' + debugLines.join('\n') + '\n'
  debugLines = []
  try {
    appendFileSync(debugLogPath(), text, 'utf8')
  } catch (error) {
    console.warn('[hotkeys] debug log write failed:', error)
  }
}

function scheduleDebugFlush(reason: string): void {
  if (!debugEnabled) return
  if (debugTimer) clearTimeout(debugTimer)
  debugTimer = setTimeout(() => flushDebugLog(reason), 900)
}

function recordDebugEvent(event: NativeKeyEvent, guide?: LeaderKey): void {
  if (!debugEnabled || Date.now() > debugUntil) return
  const up = (event.flags & LLKHF_UP) !== 0
  debugLines.push(
    Date.now() + ' vk=0x' + event.virtualKey.toString(16) +
    ' scan=0x' + event.scanCode.toString(16) +
    ' flags=0x' + event.flags.toString(16) +
    ' ' + (up ? 'up' : 'down') + (guide ? ' guide=' + guide : '')
  )
  scheduleDebugFlush(guide ? 'guide:' + guide : 'chord')
}

function clearTimer(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

function armTimer(): void {
  clearTimer()
  timer = setTimeout(() => {
    timer = null
    const transition = reduceLeaderState(leader, { type: 'timeout' })
    leader = transition.state
    applyEffects(transition.effects)
    if (transition.swallow) {
      // The timeout path has no native event to swallow; this branch is here to
      // make the reducer contract explicit.
    }
  }, settings.leaderTimeoutMs)
}

function makeKeyEvent(virtualKey: number, down: boolean, extended = false): SendInputEvent {
  const scan = MapVirtualKeyW ? Number(MapVirtualKeyW(virtualKey, 0)) : 0
  const flags = (down ? 0 : KEYEVENTF_KEYUP) | (extended ? KEYEVENTF_EXTENDEDKEY : 0)
  return {
    type: INPUT_KEYBOARD,
    u: {
      ki: {
        wVk: virtualKey,
        wScan: scan,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: REPLAY_SIGNATURE
      }
    }
  }
}

function sendEvents(events: SendInputEvent[]): void {
  if (!SendInput || events.length === 0) return
  const inserted = Number(SendInput(events.length, events, koffi.sizeof(INPUT)))
  if (inserted !== events.length) {
    console.warn('[hotkeys] replay inserted ' + inserted + '/' + events.length + ' events')
  }
}

/** Release modifiers that already reached the shell without replaying their down events. */
function releaseCopilotModifiers(): void {
  if (forwardedCopilotModifiers.size === 0) return
  const events: SendInputEvent[] = []
  for (const virtualKey of forwardedCopilotModifiers) {
    events.push(makeKeyEvent(virtualKey, false))
  }
  forwardedCopilotModifiers.clear()
  sendEvents(events)
}

/** Replay the exact captured Copilot chord (Win+Shift+F23, Win+S, or Win+C). */
function replayCopilotChord(): void {
  const keys = copilotReplayKeys.length > 0 ? copilotReplayKeys : [VK_LWIN, VK_SHIFT, VK_F23]
  const events: SendInputEvent[] = []
  for (const virtualKey of keys) events.push(makeKeyEvent(virtualKey, true))
  for (const virtualKey of [...keys].reverse()) events.push(makeKeyEvent(virtualKey, false))
  sendEvents(events)
}

function replayNormalWinChord(event: NativeKeyEvent): boolean {
  if (!bufferedWin) return false
  const win = bufferedWin
  bufferedWin = null
  swallowedPhysicalKeys.add(event.virtualKey)
  const extended = (event.flags & 0x01) !== 0
  sendEvents([
    makeKeyEvent(win.virtualKey, true, win.extended),
    makeKeyEvent(event.virtualKey, true, extended),
    makeKeyEvent(event.virtualKey, false, extended),
    makeKeyEvent(win.virtualKey, false, win.extended)
  ])
  return true
}

function beginCopilotCapture(win: CapturedPhysicalKey | null, event: NativeKeyEvent): void {
  const winKeys = win ? [win.virtualKey] : [...pressed].filter(isWindowsKey)
  const shiftDown = pressed.has(VK_SHIFT)
  copilotReplayKeys = [...winKeys, ...(shiftDown ? [VK_SHIFT] : []), event.virtualKey]
  for (const virtualKey of copilotReplayKeys) swallowedPhysicalKeys.add(virtualKey)
  if (!win) {
    for (const virtualKey of winKeys) forwardedCopilotModifiers.add(virtualKey)
  }
  if (shiftDown) forwardedCopilotModifiers.add(VK_SHIFT)
  bufferedWin = null
}

/** Re-emit the guide key as a complete keystroke so the original action runs. */
/** Re-emit the guide key as a complete keystroke so the original action runs. */
function replayGuideKey(guideKey: LeaderKey): void {
  if (guideKey === 'copilot') {
    replayCopilotChord()
    return
  }
  let events: SendInputEvent[]
  switch (guideKey) {
    case 'apps':
      events = [makeKeyEvent(0x5D, true, true), makeKeyEvent(0x5D, false, true)]
      break
    case 'capsLock':
      events = [makeKeyEvent(0x14, true), makeKeyEvent(0x14, false)]
      break
    case 'rightAlt':
      events = [makeKeyEvent(0x12, true, true), makeKeyEvent(0x12, false, true)]
      break
  }
  sendEvents(events)
}

function applyEffects(effects: readonly LeaderEffect[]): void {
  for (const effect of effects) {
    switch (effect.type) {
      case 'timer-start':
        armTimer()
        break
      case 'timer-clear':
        clearTimer()
        break
      case 'leader-active':
        broadcast({ type: 'hotkey-leader', active: true })
        break
      case 'leader-inactive':
        releaseCopilotModifiers()
        if (effect.reason === 'digit') {
          copilotReplayKeys = []
          scheduleDebugFlush('digit-consumed')
        }
        broadcast({ type: 'hotkey-leader', active: false })
        break
      case 'replay-guide':
        releaseCopilotModifiers()
        replayGuideKey(effect.guideKey)
        if (effect.guideKey === 'copilot') {
          copilotReplayKeys = []
          scheduleDebugFlush('copilot-replayed')
        }
        break
      case 'trigger':
        // Focus first, then ask the renderer to resolve the digit against its
        // current group. setImmediate keeps the low-level hook fast.
        setImmediate(() => {
          showLauncher()
          broadcast({ type: 'hotkey-trigger', digit: effect.digit })
        })
        break
    }
  }
}

function modifiers(): { win: boolean; shift: boolean; ctrl: boolean; alt: boolean } {
  return {
    win: pressed.has(VK_LWIN) || pressed.has(VK_RWIN),
    shift: pressed.has(VK_SHIFT) || pressed.has(VK_LSHIFT) || pressed.has(VK_RSHIFT),
    ctrl: pressed.has(VK_CONTROL) || pressed.has(VK_LCONTROL) || pressed.has(VK_RCONTROL),
    alt: pressed.has(VK_MENU) || pressed.has(VK_LMENU) || pressed.has(VK_RMENU)
  }
}

/** Feed one physical (or externally injected) event to the leader machine. */
function handleKeyEvent(event: NativeKeyEvent): boolean {
  if (isReplayEvent(event, REPLAY_SIGNATURE)) return false
  const isUp = (event.flags & LLKHF_UP) !== 0
  if (isUp) {
    pressed.delete(event.virtualKey)
    recordDebugEvent(event)

    // Win was buffered with no chord key: replay a normal Win tap so Start and
    // standard Win shortcuts keep working.
    if (bufferedWin && event.virtualKey === bufferedWin.virtualKey) {
      const win = bufferedWin
      bufferedWin = null
      swallowedPhysicalKeys.delete(event.virtualKey)
      sendEvents([makeKeyEvent(win.virtualKey, true, win.extended), makeKeyEvent(win.virtualKey, false, win.extended)])
      scheduleDebugFlush('plain-win-tap')
      return true
    }

    // Keys that were already swallowed cannot leak a lone key-up to the shell.
    if (swallowedPhysicalKeys.has(event.virtualKey)) {
      if (forwardedCopilotModifiers.has(event.virtualKey)) {
        sendEvents([makeKeyEvent(event.virtualKey, false)])
        forwardedCopilotModifiers.delete(event.virtualKey)
      }
      if (leader.active || leader.capturedVirtualKeys.includes(event.virtualKey)) {
        const transition = reduceLeaderState(leader, { type: 'key-up', virtualKey: event.virtualKey })
        leader = transition.state
        applyEffects(transition.effects)
      }
      swallowedPhysicalKeys.delete(event.virtualKey)
      return true
    }

    const transition = reduceLeaderState(leader, { type: 'key-up', virtualKey: event.virtualKey })
    leader = transition.state
    applyEffects(transition.effects)
    return transition.swallow
  }

  if (swallowedPhysicalKeys.has(event.virtualKey)) return true
  pressed.add(event.virtualKey)

  if (debugEnabled && shouldCaptureCopilotKey() && isWindowsKey(event.virtualKey)) {
    debugUntil = Date.now() + 3000
    debugLines = []
    recordDebugEvent(event)
  }

  recordDebugEvent(event)
  // Capture the whole Win sequence while Copilot takeover is enabled. The Win
  // key down is never sent to the shell, which prevents Search, Start, and the
  // Win+digit taskbar chord from leaking through.
  if (shouldCaptureCopilotKey() && isWindowsKey(event.virtualKey) && !leader.active) {
    if (!bufferedWin) {
      bufferedWin = capturedKey(event)
      swallowedPhysicalKeys.add(event.virtualKey)
    }
    return true
  }

  if (bufferedWin) {
    const guide = guideKeyForEvent(event, settings, modifiers())
    if (guide === 'copilot') {
      beginCopilotCapture(bufferedWin, event)
      debugUntil = Date.now() + 1500
      scheduleDebugFlush('guide:copilot')
      const transition = reduceLeaderState(leader, {
        type: 'guide-down',
        guideKey: 'copilot',
        virtualKey: event.virtualKey
      })
      leader = transition.state
      applyEffects(transition.effects)
      return true
    }
    // Shift/Ctrl/Alt are allowed to reach the shell so normal Win+modifier
    // shortcuts (for example Win+Shift+S) retain their native behavior.
    if (isModifierKey(event.virtualKey)) return false
    replayNormalWinChord(event)
    scheduleDebugFlush('normal-win-chord')
    return true
  }

  const guide = guideKeyForEvent(event, settings, modifiers())
  if (guide) {
    if (guide === 'copilot') {
      beginCopilotCapture(null, event)
      debugUntil = Date.now() + 1500
      scheduleDebugFlush('guide:copilot')
    }
    // Recover if a previous key-up was lost (focus switch, UAC desktop, or an
    // injected key event). A fresh guide press must still be usable.
    if (!leader.active && leader.capturedVirtualKeys.includes(event.virtualKey)) {
      leader = {
        ...leader,
        capturedVirtualKeys: leader.capturedVirtualKeys.filter((key) => key !== event.virtualKey)
      }
    }
    const transition = reduceLeaderState(leader, {
      type: 'guide-down',
      guideKey: guide,
      virtualKey: event.virtualKey
    })
    leader = transition.state
    applyEffects(transition.effects)
    return true
  }

  if (!leader.active) return false
  if (isEscapeDown(event)) {
    const transition = reduceLeaderState(leader, { type: 'escape-down', virtualKey: event.virtualKey })
    leader = transition.state
    applyEffects(transition.effects)
    return transition.swallow
  }
  const digit = digitForVirtualKey(event.virtualKey)
  if (digit) {
    const transition = reduceLeaderState(leader, {
      type: 'digit-down',
      digit,
      virtualKey: event.virtualKey
    })
    leader = transition.state
    applyEffects(transition.effects)
    return transition.swallow
  }
  return false
}

function keyboardHookCallback(nCode: number, wParam: number | bigint, lParam: number | bigint): number | bigint {
  if (nCode < 0 || !CallNextHookEx) {
    return CallNextHookEx ? Number(CallNextHookEx(null, nCode, wParam, lParam)) : 0
  }
  try {
    // The hook is global for a single input desktop. Reading KBDLLHOOKSTRUCT
    // is safe for HC_ACTION; other codes are forwarded untouched.
    if (nCode === 0) {
      const data = koffi.decode(lParam, KBDLLHOOKSTRUCT) as {
        vkCode: number
        scanCode: number
        flags: number
        dwExtraInfo: number | bigint
      }
      const event: NativeKeyEvent = {
        virtualKey: Number(data.vkCode),
        scanCode: Number(data.scanCode),
        flags: Number(data.flags),
        extraInfo: Number(data.dwExtraInfo)
      }
      if (handleKeyEvent(event)) return 1
    }
    return Number(CallNextHookEx(null, nCode, wParam, lParam))
  } catch (error) {
    console.error('[hotkeys] hook callback failed:', error)
    try {
      return Number(CallNextHookEx(null, nCode, wParam, lParam))
    } catch {
      return 0
    }
  }
}

function installHook(): void {
  if (process.platform !== 'win32' || hookHandle || !settings.enabled || settings.leaderKeys.length === 0) return
  if (!SetWindowsHookExW) return
  debugEnabled = existsSync(join(app.getPath('userData'), HOTKEY_DEBUG_FLAG))
  try {
    hookProc = koffi.register((nCode: number, wParam: number | bigint, lParam: number | bigint) =>
      keyboardHookCallback(nCode, wParam, lParam), koffi.pointer(KeyboardHookProc))
    const moduleHandle = GetModuleHandleW ? GetModuleHandleW(null) : null
    hookHandle = SetWindowsHookExW(WH_KEYBOARD_LL, hookProc, moduleHandle, 0)
    if (!hookHandle) {
      const code = GetLastError ? GetLastError() : -1
      throw new Error(`SetWindowsHookExW(WH_KEYBOARD_LL) failed (Win32 error ${code})`)
    }
    console.info('[hotkeys] WH_KEYBOARD_LL installed')
    if (debugEnabled) {
      try {
        mkdirSync(app.getPath('userData'), { recursive: true })
        writeFileSync(debugLogPath(), '--- hook installed ' + new Date().toISOString() + ' ---\n', 'utf8')
      } catch (error) {
        console.warn('[hotkeys] debug log init failed:', error)
      }
    }
  } catch (error) {
    console.error('[hotkeys] global hook unavailable:', error)
    if (hookHandle && UnhookWindowsHookEx) {
      try { UnhookWindowsHookEx(hookHandle) } catch { /* already gone */ }
    }
    hookHandle = null
    if (hookProc) {
      try { koffi.unregister(hookProc) } catch { /* already released */ }
    }
    hookProc = null
  }
}

function uninstallHook(): void {
  clearTimer()
  if (hookHandle && UnhookWindowsHookEx) {
    try { UnhookWindowsHookEx(hookHandle) } catch { /* process is exiting */ }
  }
  hookHandle = null
  if (hookProc) {
    try { koffi.unregister(hookProc) } catch { /* already released */ }
  }
  hookProc = null
  pressed.clear()
  const wasActive = leader.active
  leader = INITIAL_LEADER_STATE
  if (wasActive) broadcast({ type: 'hotkey-leader', active: false })
}

/**
 * Apply persisted hotkey settings. Called at startup and after the Settings
 * page saves a new value. Installs/removes the global hook as needed.
 *
 * @param value partial or persisted hotkey settings
 */
export function applyHotkeyConfig(value?: Partial<HotkeySettings> | null): void {
  settings = normalizeHotkeySettings(value)
  if (!settings.enabled || settings.leaderKeys.length === 0) {
    uninstallHook()
    return
  }
  // Settings changes must not leave a stale leader mode holding a guide key.
  if (leader.active) {
    clearTimer()
    leader = INITIAL_LEADER_STATE
    broadcast({ type: 'hotkey-leader', active: false })
  }
  installHook()
}

/** Remove the global hook (app shutdown). */
export function shutdownHotkeys(): void {
  settings = { ...settings, enabled: false }
  uninstallHook()
}
