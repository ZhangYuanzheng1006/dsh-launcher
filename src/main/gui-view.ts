// Owns GUI instances after spawn: locate their top-level HWND(s), make the
// selected window an owned tool window, and keep it glued to the launcher
// content area. Pure selection/style/retry helpers live in
// gui-window-pure.ts so they stay testable without Electron or koffi.

import { BrowserWindow, screen } from 'electron'
import { existsSync } from 'node:fs'
import {
  computeGuiContentBox,
  computeGuiDegradedStyle,
  classifyGuiNativeDuration,
  computeGuiEmbedStyle,
  computeGuiTaskbarHygieneStyle,
  guiWindowStyleRestored,
  hasGuiWindowFrame,
  guiStyleRetryDelay,
  guiWindowSignature,
  isGuiDegradedStyleIntact,
  isGuiEmbedStyleIntact,
  isGuiTaskbarHygieneIntact,
  isUsableGuiWindow,
  normalizeWindowsPath,
  repairGuiWindowStyleSnapshot,
  repairWeChatWindowStyleSnapshot,
  guiPolicyStopMode,
  guiPolicyUsesClientInsetFix,
  resolveGuiWindowPolicy,
  selectCodexSatelliteWindows,
  selectGuiPolicyWindow,
  selectWeChatMainWindow,
  selectWeChatTaskbarHygieneWindows,
  type GuiContentInsets,
  type GuiWindowCandidate,
  type GuiWindowPolicy,
  type GuiWindowQuery,
  type GuiWindowRect,
  type GuiWindowStyleSnapshot
} from './gui-window-pure'
import {
  applyWindowEmbedding,
  closeWindow,
  clearWindowRegion,
  enumerateTopLevelWindowHandles,
  ensureWindowClientRegion,
  enumerateTopLevelWindows,
  enumerateTopLevelWindowsByPids,
  findProcessIdsByImagePath,
  focusWindow,
  getForegroundWindow,
  getProcessPath,
  getWindowCandidate,
  getWindowEmbedState,
  isWindow,
  positionWindow,
  restoreForegroundWindow,
  positionWindowRaw,
  showWindow,
  windowRectForContent
} from './gui-win32'
import { t } from './i18n'

const POLL_MS = 120
const WINDOW_POLL_MS = 250
const STABLE_POLL_MS = 200
const STARTUP_STABLE_MS = 2000
const STYLE_CHECK_MS = 1000
const SATELLITE_SCAN_MS = 500
const SHOW_VERIFY_MS = 300
const STABLE_STYLE_RESET_MS = 3000
const MAX_STYLE_RETRIES = 5
const SIDEBAR_ANIM_MS = 150

const sessions = new Map<string, GuiSession>()
const firstSeenAt = new Map<number, number>()
const processPathCache = new Map<number, string>()
let host: BrowserWindow | null = null
let hostHwnd = 0
let hostVisible = true
let activeId: string | null = null
let sidebarWidth = 260
let sidebarTarget = 260
let contentInsets: GuiContentInsets = { top: 0, right: 0, bottom: 0 }
let layoutTimer: ReturnType<typeof setTimeout> | null = null
let hostPollTimer: ReturnType<typeof setInterval> | null = null
let styleTimer: ReturnType<typeof setInterval> | null = null
let satelliteTimer: ReturnType<typeof setInterval> | null = null
let sidebarTimer: ReturnType<typeof setTimeout> | null = null
let lastHostGeometry = ''

interface GuiSatellite {
  hwnd: number
  title: string
  className: string
  lastStyledAt: number
}

interface GuiSession {
  instanceId: string
  rootPid: number
  targetPid: number
  exePath: string
  windowTitle?: string
  windowClass?: string
  policy: GuiWindowPolicy
  baselineHwnds?: number[]
  hwnd: number
  title: string
  visible: boolean
  /** Original frame styles, used to restore the title bar in degraded mode. */
  originalStyle: number
  originalExStyle: number
  /** Exact pre-embedding attributes for every HWND this session touched. */
  managedWindows: Map<number, GuiWindowStyleSnapshot>
  satellites: Map<number, GuiSatellite>
  degraded: boolean
  degradedReported: boolean
  styleInFlight: boolean
  styleQueued: boolean
  styleWorkTimer: ReturnType<typeof setTimeout> | null
  styleRetryTimer: ReturnType<typeof setTimeout> | null
  styleRetryCount: number
  lastStyleAppliedAt: number
  warningLogged: boolean
  failureReported: boolean
  missingChecks: number
  onLog: (line: string) => void
  onError: (message: string) => void
  onDegraded?: (message: string) => void
}

export interface GuiAttachOptions {
  instanceId: string
  rootPid: number
  exePath: string
  windowTitle?: string
  windowClass?: string
  windowPolicy?: GuiWindowPolicy
  /** HWNDs captured immediately before spawn; Chrome only accepts a missing HWND. */
  baselineHwnds?: number[]
  timeoutMs: number
  isAlive: () => boolean
  /** Chrome/AppX may hand off to another process; keep polling after root exit. */
  keepPollingAfterRootExit?: boolean
  /** Stop behavior for an adopted existing app: restore window but leave process running. */
  stopMode?: 'tree' | 'window' | 'detach'
  /** Abort gracefully when the user stops the instance during attach. */
  shouldAbort?: () => boolean
  /** Window that was foreground immediately before this launch, for focus restoration. */
  foregroundBeforeSpawn?: number
  onLog: (line: string) => void
  onError: (message: string) => void
  onDegraded?: (message: string) => void
}

export interface GuiAttachResult {
  ok: boolean
  hwnd?: number
  pid?: number
  title?: string
  hiddenInitially?: boolean
  degraded?: boolean
  degradedReason?: string
  stopMode?: 'tree' | 'window' | 'detach'
  error?: string
}

interface NativeJob {
  label: string
  session?: GuiSession
  run: () => void
}

interface NativeResult<T> {
  timedOut: boolean
  elapsedMs: number
  value?: T
  error?: unknown
}

let guiPauseDepth = 0
const nativeQueue: NativeJob[] = []
let nativePumpTimer: ReturnType<typeof setTimeout> | null = null
let nativeBusy = false

interface StyleOutcome {
  ok: boolean
  error?: string
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** True while a native modal dialog owns the application's main thread. */
export function isGuiViewWorkPaused(): boolean {
  return guiPauseDepth > 0
}

/** Pause every GUI Win32 timer/queue before entering a modal native dialog. */
export function pauseGuiViewWork(reason = 'dialog'): void {
  guiPauseDepth++
  if (guiPauseDepth === 1) console.info(`[gui] native work paused for ${reason}`)
}

/** Resume GUI work and stagger the first post-dialog batch onto a later tick. */
export function resumeGuiViewWork(): void {
  if (guiPauseDepth > 0) guiPauseDepth--
  if (guiPauseDepth !== 0) return
  console.info('[gui] native work resumed')
  lastHostGeometry = ''
  scheduleLayout()
  for (const session of sessions.values()) {
    if (!session.degraded) requestStyleCheck(session, 'resume')
  }
}

/** Run a modal Electron dialog while all synchronous GUI Win32 work is paused. */
export async function withGuiViewPaused<T>(fn: () => Promise<T>): Promise<T> {
  pauseGuiViewWork('native dialog')
  try {
    return await fn()
  } finally {
    resumeGuiViewWork()
  }
}

function pumpNativeQueue(): void {
  if (nativePumpTimer || nativeBusy) return
  if (guiPauseDepth > 0) {
    nativePumpTimer = setTimeout(() => {
      nativePumpTimer = null
      pumpNativeQueue()
    }, 200)
    nativePumpTimer.unref?.()
    return
  }
  nativePumpTimer = setTimeout(() => {
    nativePumpTimer = null
    const job = nativeQueue.shift()
    if (!job) return
    nativeBusy = true
    const started = performance.now()
    try {
      job.run()
    } finally {
      nativeBusy = false
      const elapsed = performance.now() - started
      const cls = classifyGuiNativeDuration(elapsed)
      if (cls === 'slow') {
        console.warn(`[gui] native ${job.label} took ${elapsed.toFixed(1)}ms (>${16}ms)`)
      } else if (cls === 'timeout') {
        const warning = `[gui] native ${job.label} took ${elapsed.toFixed(1)}ms (>${2000}ms); skipped this cycle`
        console.warn(warning)
        job.session?.onLog(warning)
      }
      pumpNativeQueue()
    }
  }, 0)
  nativePumpTimer.unref?.()
}

/** Queue one native batch; only one batch may run per timer tick. */
function scheduleNativeTask(label: string, session: GuiSession | undefined, run: () => void): void {
  nativeQueue.push({ label, session, run })
  pumpNativeQueue()
}

function runNativeTask<T>(
  label: string,
  session: GuiSession | undefined,
  task: () => T
): Promise<NativeResult<T>> {
  return new Promise((resolve) => {
    scheduleNativeTask(label, session, () => {
      const started = performance.now()
      try {
        const value = task()
        const elapsedMs = performance.now() - started
        resolve({ timedOut: classifyGuiNativeDuration(elapsedMs) === 'timeout', elapsedMs, value })
      } catch (error) {
        const elapsedMs = performance.now() - started
        resolve({ timedOut: classifyGuiNativeDuration(elapsedMs) === 'timeout', elapsedMs, error })
      }
    })
  })
}

function toNumber(handle: bigint | number | null): number {
  if (handle === null) return 0
  return typeof handle === 'bigint' ? Number(handle) : handle
}

function nativeWindowHandle(win: BrowserWindow): number {
  const raw = win.getNativeWindowHandle()
  if (raw.length >= 8) return Number(raw.readBigUInt64LE(0))
  if (raw.length >= 4) return raw.readUInt32LE(0)
  throw new Error('launcher HWND is unavailable')
}

function observedWindows(): GuiWindowCandidate[] {
  const now = Date.now()
  const all = enumerateTopLevelWindows()
  for (const candidate of all) {
    if (!firstSeenAt.has(candidate.hwnd)) firstSeenAt.set(candidate.hwnd, now)
  }
  return all.map((candidate) => ({ ...candidate, firstSeenAt: firstSeenAt.get(candidate.hwnd) }))
}

function cachedProcessPath(pid: number): string {
  const cached = processPathCache.get(pid)
  if (cached) return cached
  const path = getProcessPath(pid)
  if (path) processPathCache.set(pid, path)
  return path
}

function sessionQuery(session: Pick<GuiSession, 'rootPid' | 'exePath' | 'windowTitle' | 'windowClass' | 'baselineHwnds'>): GuiWindowQuery {
  return {
    rootPid: session.rootPid,
    exePath: session.exePath,
    windowTitle: session.windowTitle,
    windowClass: session.windowClass,
    ownerHwnd: hostHwnd || undefined,
    baselineHwnds: session.baselineHwnds
  }
}

function pickCandidate(
  candidates: readonly GuiWindowCandidate[],
  query: GuiWindowQuery,
  policy: GuiWindowPolicy
): GuiWindowCandidate | null {
  return selectGuiPolicyWindow(candidates, query, policy)
}

/**
 * Find a window for this instance. Root-PID candidates are checked first; when
 * none qualify, executable-path matches are accepted so single-instance apps
 * and Chrome's shared browser process can hand off a window.
 */
function resolveWindow(
  query: GuiWindowQuery,
  policy: GuiWindowPolicy
): { window: GuiWindowCandidate; viaPath: boolean } | null {
  const all = observedWindows()
  // Chrome must be scoped to chrome.exe PIDs: Codex/other Electron apps also
  // expose Chrome_WidgetWin_1, and a post-baseline Codex window must never be
  // mistaken for Chrome's new window.
  const chromePids = policy === 'chrome-newest' ? findProcessIdsByImagePath(query.exePath) : null
  const scopedAll = policy === 'chrome-newest'
    ? all.filter((candidate) => chromePids?.includes(candidate.pid) ?? false)
    : all
  const directPids = query.rootPid > 0
    ? new Set([query.rootPid])
    : new Set(findProcessIdsByImagePath(query.exePath))
  const directCandidates = policy === 'chrome-newest'
    ? scopedAll
    : scopedAll
        .filter((candidate) => directPids.has(candidate.pid))
        .map((candidate) => ({ ...candidate, processPath: candidate.processPath || query.exePath }))
  const direct = pickCandidate(directCandidates, query, policy)
  if (direct) return { window: direct, viaPath: false }

  const expected = normalizeWindowsPath(query.exePath)
  const fallback: GuiWindowCandidate[] = []
  for (const candidate of scopedAll) {
    if (candidate.pid === query.rootPid || !isUsableGuiWindow(candidate)) continue
    const path = cachedProcessPath(candidate.pid)
    if (!path || normalizeWindowsPath(path) !== expected) continue
    fallback.push({ ...candidate, processPath: path })
  }
  const match = pickCandidate(fallback, query, policy)
  return match ? { window: match, viaPath: true } : null
}

function targetPhysicalRect(): GuiWindowRect | null {
  if (!host || host.isDestroyed() || !hostVisible || host.isMinimized()) return null
  const dipBox = computeGuiContentBox(host.getContentBounds(), sidebarWidth, contentInsets)
  if (dipBox.width <= 0 || dipBox.height <= 0) return null
  const physical = screen.dipToScreenRect(host, dipBox)
  return { left: physical.x, top: physical.y, right: physical.x + physical.width, bottom: physical.y + physical.height }
}

function placeSession(session: GuiSession): boolean {
  const rect = targetPhysicalRect()
  if (!rect) {
    if (session.visible) {
      try { showWindow(session.hwnd, false) } catch { /* window may be gone */ }
      session.visible = false
    }
    return false
  }
  const width = rect.right - rect.left
  const height = rect.bottom - rect.top
  if (width <= 0 || height <= 0) return false
  try {
    const box = { x: rect.left, y: rect.top, width, height }
    if (guiPolicyUsesClientInsetFix(session.policy)) positionWindow(session.hwnd, box)
    else positionWindowRaw(session.hwnd, box)
    return true
  } catch (err) {
    session.onLog(`[gui] ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/** Capture a window's exact pre-embed style/owner before this session touches it. */
function rememberManagedWindow(
  session: GuiSession,
  candidate: GuiWindowCandidate,
  repairFrame = false
): GuiWindowStyleSnapshot {
  const existing = session.managedWindows.get(candidate.hwnd)
  if (existing) return existing
  const state = getWindowEmbedState(candidate.hwnd)
  const exact: GuiWindowStyleSnapshot = {
    hwnd: candidate.hwnd,
    style: state.style >>> 0,
    exStyle: state.exStyle >>> 0,
    owner: state.owner,
    visible: candidate.visible,
    iconic: candidate.iconic
  }
  const leftByLauncher = isGuiTaskbarHygieneIntact(exact.exStyle) || exact.owner !== 0
  const canRepair = repairFrame && session.policy !== 'chrome-newest'
  const shouldRepair = canRepair && (!hasGuiWindowFrame(exact.style) || leftByLauncher)
  const snapshot = repairFrame && session.policy === 'wechat-main'
    ? repairWeChatWindowStyleSnapshot(exact)
    : shouldRepair
      ? repairGuiWindowStyleSnapshot(exact)
      : exact
  if (snapshot.style !== exact.style || snapshot.exStyle !== exact.exStyle) {
    session.onLog(t(
      '[gui] 检测到上次残留的无边框样式；停止时将补全标题栏和最小化/最大化按钮。',
      '[gui] Found a caption-less style left by an earlier run; restoring a standard title bar and min/max buttons on stop.'
    ))
  }
  session.managedWindows.set(candidate.hwnd, snapshot)
  return snapshot
}

/** Restore every HWND this session modified; optionally reveal the main window. */
function restoreSessionWindows(session: GuiSession, revealMain = false, revealAux = false): boolean {
  let failures = 0
  let firstError = ''
  for (const [hwnd, snapshot] of [...session.managedWindows]) {
    if (!isWindow(hwnd)) {
      session.managedWindows.delete(hwnd)
      continue
    }
    try {
      applyWindowEmbedding(hwnd, snapshot.owner, snapshot.style, snapshot.exStyle)
      const current = getWindowEmbedState(hwnd)
      if (!guiWindowStyleRestored(snapshot, current)) {
        throw new Error(`style/owner mismatch (style=${current.style} ex=${current.exStyle} owner=${current.owner})`)
      }
      if (hwnd === session.hwnd) clearWindowRegion(hwnd)
      if (revealAux && snapshot.visible && hwnd !== session.hwnd) {
        try { showWindow(hwnd, true) } catch { /* window may be gone */ }
      }
    } catch (error) {
      failures++
      if (!firstError) firstError = error instanceof Error ? error.message : String(error)
    }
  }
  if (revealMain && isWindow(session.hwnd)) {
    try { showWindow(session.hwnd, true) } catch { /* window may be gone */ }
  }
  if (failures > 0) {
    session.onLog(
      t(
        `[gui] 窗口样式还原失败 (${failures}/${session.managedWindows.size})${firstError ? `: ${firstError}` : ''}`,
        `[gui] Failed to restore window style (${failures}/${session.managedWindows.size})${firstError ? `: ${firstError}` : ''}`
      )
    )
    return false
  }
  return true
}

function hideSatellites(session: GuiSession): void {
  for (const satellite of session.satellites.values()) {
    if (!isWindow(satellite.hwnd)) continue
    try { showWindow(satellite.hwnd, false) } catch { /* window may be gone */ }
  }
}

function hideSession(session: GuiSession | undefined): void {
  if (!session) return
  clearSessionStyleTimers(session)
  hideSatellites(session)
  // Hide first so restoring the normal frame cannot briefly flash a taskbar
  // button while the window is still visible.
  if (isWindow(session.hwnd)) {
    try { showWindow(session.hwnd, false) } catch { /* already gone */ }
  }
  session.visible = false
  // Switching away or hiding the launcher must not leave a stripped frame or
  // launcher owner behind on the app's normal top-level window.
  restoreSessionWindows(session)
}

function hideActive(): void {
  if (!activeId) return
  hideSession(sessions.get(activeId))
}

function reportSessionError(session: GuiSession, message: string): void {
  session.onError(message)
  if (!session.failureReported) {
    session.failureReported = true
    session.onLog(`[gui] ${message}`)
  }
  hideSession(session)
}

function applyNormalStyleOnce(session: GuiSession): StyleOutcome {
  if (!isWindow(session.hwnd)) return { ok: false, error: t('目标窗口已消失', 'the target window is gone') }
  const state = getWindowEmbedState(session.hwnd)
  if (isGuiEmbedStyleIntact(state.style, state.exStyle, state.owner, hostHwnd)) return { ok: true }
  try {
    const style = computeGuiEmbedStyle(state.style, state.exStyle)
    applyWindowEmbedding(session.hwnd, hostHwnd, style.style, style.exStyle)
    const after = getWindowEmbedState(session.hwnd)
    return isGuiEmbedStyleIntact(after.style, after.exStyle, after.owner, hostHwnd)
      ? { ok: true }
      : { ok: false, error: t('窗口样式未生效', 'the window style did not stick') }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function applyDegradedStyleOnce(session: GuiSession): StyleOutcome {
  if (!isWindow(session.hwnd)) return { ok: false, error: t('目标窗口已消失', 'the target window is gone') }
  const state = getWindowEmbedState(session.hwnd)
  if (isGuiDegradedStyleIntact(state.exStyle, state.owner, hostHwnd)) return { ok: true }
  try {
    // Build from the pre-embedding frame, not from a caption-less style that an
    // earlier normal attempt may have left behind.
    const style = computeGuiDegradedStyle(session.originalStyle, session.originalExStyle)
    applyWindowEmbedding(session.hwnd, hostHwnd, style.style, style.exStyle)
    const after = getWindowEmbedState(session.hwnd)
    return isGuiDegradedStyleIntact(after.exStyle, after.owner, hostHwnd)
      ? { ok: true }
      : { ok: false, error: t('降级样式未生效', 'the degraded window style did not stick') }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function clearSessionStyleTimers(session: GuiSession): void {
  if (session.styleWorkTimer) clearTimeout(session.styleWorkTimer)
  if (session.styleRetryTimer) clearTimeout(session.styleRetryTimer)
  session.styleWorkTimer = null
  session.styleRetryTimer = null
  session.styleInFlight = false
  session.styleQueued = false
}

function runStyleTask(session: GuiSession, task: () => StyleOutcome): Promise<StyleOutcome> {
  session.styleInFlight = true
  return runNativeTask('style-check', session, task).then((result) => {
    session.styleInFlight = false
    session.styleWorkTimer = null
    if (result.timedOut) {
      clearSessionStyleTimers(session)
      return { ok: false, error: t('单次窗口操作超过 2 秒，已跳过本次', 'one native window operation exceeded 2s and was skipped') }
    }
    if (result.error) {
      return { ok: false, error: result.error instanceof Error ? result.error.message : String(result.error) }
    }
    return result.value ?? { ok: false, error: t('窗口操作没有返回结果', 'native window operation returned no result') }
  })
}

function enterDegraded(session: GuiSession, reason: string): void {
  if (session.degraded) return
  session.degraded = true
  clearSessionStyleTimers(session)
  const message = t(
    `桌面应用嵌入降级：保留标题栏，仅定位与显隐。原因：${reason}`,
    `Desktop-app embedding degraded: keeping the title bar and using positioning/visibility only. Reason: ${reason}`
  )
  if (!session.degradedReported) {
    session.degradedReported = true
    session.onLog(`[gui] ${message}`)
    session.onDegraded?.(message)
  }
  // Apply the owned/tool-window bits once, but never strip the caption.
  scheduleNativeTask('apply-degraded-style', session, () => {
    if (!isWindow(session.hwnd)) return
    const outcome = applyDegradedStyleOnce(session)
    if (!outcome.ok) session.onLog(`[gui] ${t('降级样式应用失败', 'failed to apply degraded style')}: ${outcome.error ?? ''}`)
    if (activeId === session.instanceId && hostVisible && session.visible) placeSession(session)
  })
}

function scheduleStyleCheck(session: GuiSession, delayMs: number): void {
  if (session.degraded || !isWindow(session.hwnd)) return
  if (session.styleRetryTimer) clearTimeout(session.styleRetryTimer)
  session.styleRetryTimer = setTimeout(() => {
    session.styleRetryTimer = null
    requestStyleCheck(session, 'retry')
  }, Math.max(0, delayMs))
  session.styleRetryTimer.unref?.()
}

function performStyleCheck(session: GuiSession, reason: string): StyleOutcome {
  if (session.degraded || !isWindow(session.hwnd)) return { ok: true }
  if (!session.visible && activeId !== session.instanceId) return { ok: true }

  const state = getWindowEmbedState(session.hwnd)
  const now = Date.now()
  if (isGuiEmbedStyleIntact(state.style, state.exStyle, state.owner, hostHwnd)) {
    if (session.styleRetryCount > 0 && now - session.lastStyleAppliedAt >= STABLE_STYLE_RESET_MS) {
      session.styleRetryCount = 0
      session.warningLogged = false
      session.onLog(t('[gui] 窗口样式已稳定。', '[gui] Window styles are stable again.'))
    }
    return { ok: true }
  }

  if (session.styleRetryCount >= 3) {
    enterDegraded(
      session,
      t('连续 3 次重贴窗口样式后仍被应用改回', 'the app reverted the owned-window style after three reapply attempts')
    )
    return { ok: false, error: 'style reverted after three reapplies' }
  }

  if (!session.warningLogged) {
    session.warningLogged = true
    session.onLog(
      t(
        `[gui] 检测到应用重设窗口样式 (${reason})，按退避策略重新应用…`,
        `[gui] The app reset its window style (${reason}); reapplying with backoff…`
      )
    )
  }

  const outcome = applyNormalStyleOnce(session)
  session.styleRetryCount++
  session.lastStyleAppliedAt = now
  if (outcome.ok) {
    if (activeId === session.instanceId && hostVisible && session.visible) placeSession(session)
    const retryDelay = guiStyleRetryDelay(Math.max(0, session.styleRetryCount - 1)) ?? 8000
    scheduleStyleCheck(session, retryDelay)
    return outcome
  }

  if (session.styleRetryCount >= MAX_STYLE_RETRIES) {
    enterDegraded(
      session,
      t(
        `连续 ${session.styleRetryCount} 次样式重贴失败：${outcome.error ?? ''}`,
        `${session.styleRetryCount} consecutive style attempts failed: ${outcome.error ?? ''}`
      )
    )
    return outcome
  }
  const retryDelay = guiStyleRetryDelay(Math.max(0, session.styleRetryCount - 1)) ?? 8000
  scheduleStyleCheck(session, retryDelay)
  return outcome
}

function requestStyleCheck(session: GuiSession, reason: string): void {
  if (session.degraded || !sessions.has(session.instanceId)) return
  if (guiPauseDepth > 0) {
    session.styleQueued = true
    return
  }
  if (session.styleInFlight) {
    session.styleQueued = true
    return
  }
  void runStyleTask(session, () => performStyleCheck(session, reason)).finally(() => {
    if (!session.styleQueued || session.degraded) return
    session.styleQueued = false
    requestStyleCheck(session, 'queued')
  })
}

function takeoverSatellite(session: GuiSession, candidate: GuiWindowCandidate, force: boolean): void {
  if (candidate.hwnd === session.hwnd || !isWindow(candidate.hwnd)) return
  rememberManagedWindow(session, candidate)
  const state = getWindowEmbedState(candidate.hwnd)
  const intact = session.degraded
    ? isGuiDegradedStyleIntact(state.exStyle, state.owner, hostHwnd)
    : isGuiEmbedStyleIntact(state.style, state.exStyle, state.owner, hostHwnd)
  if (force || !intact) {
    try {
      const style = session.degraded
        ? computeGuiDegradedStyle(state.style, state.exStyle)
        : computeGuiEmbedStyle(state.style, state.exStyle)
      applyWindowEmbedding(candidate.hwnd, hostHwnd, style.style, style.exStyle)
    } catch (err) {
      session.onLog(t(
        `[gui] 接管附属窗口 HWND=${candidate.hwnd} 失败: ${String(err)}`,
        `[gui] Failed to take over auxiliary window HWND=${candidate.hwnd}: ${String(err)}`
      ))
    }
  }
  try { showWindow(candidate.hwnd, false) } catch { /* window may be gone */ }
  session.satellites.set(candidate.hwnd, {
    hwnd: candidate.hwnd,
    title: candidate.title,
    className: candidate.className,
    lastStyledAt: Date.now()
  })
}

/** Codex can create extra Chromium/tool top-level windows; take them all over. */
function refreshSatellitesNow(session: GuiSession): void {
  if (session.policy !== 'codex-multi' || !session.visible) return
  const all = enumerateTopLevelWindowsByPids([session.targetPid])
  const main = all.find((candidate) => candidate.hwnd === session.hwnd)
  if (!main) return
  const candidates = selectCodexSatelliteWindows(main, all)
  const alive = new Set<number>()
  for (const candidate of candidates) {
    alive.add(candidate.hwnd)
    const existing = session.satellites.get(candidate.hwnd)
    const visibleNow = candidate.visible
    const force = !existing || visibleNow
    takeoverSatellite(session, candidate, force)
    if (!existing && (candidate.title || visibleNow)) {
      session.onLog(t(
        `[gui] 已接管 Codex 附属顶层窗口 HWND=${candidate.hwnd} class=${candidate.className} title="${candidate.title}"`,
        `[gui] Took over Codex auxiliary top-level window HWND=${candidate.hwnd} class=${candidate.className} title="${candidate.title}"`
      ))
    }
  }
  for (const hwnd of [...session.satellites.keys()]) {
    if (!alive.has(hwnd) || !isWindow(hwnd)) session.satellites.delete(hwnd)
  }
}

function refreshSatellites(session: GuiSession): void {
  if (session.policy !== 'codex-multi' || !session.visible || guiPauseDepth > 0) return
  void runNativeTask('satellite-scan', session, () => refreshSatellitesNow(session)).then((result) => {
    if (result.timedOut) session.onLog('[gui] satellite scan exceeded 2s; skipped this cycle')
    else if (result.error) session.onLog(`[gui] satellite scan failed: ${String(result.error)}`)
  })
}

/** WeChat auxiliary top-level windows must never create their own taskbar entry. */
function refreshWeChatTaskbarHygieneNow(session: GuiSession): void {
  if (session.policy !== 'wechat-main' || !session.visible) return
  let all = enumerateTopLevelWindowsByPids([session.targetPid])
  let preferred = selectWeChatMainWindow(all, sessionQuery(session))
  if (!preferred && !isWindow(session.hwnd)) {
    // WeChat login can replace the whole process, not just the HWND. Resolve
    // same-exe PIDs and retry against the process that currently owns a window.
    const pids = findProcessIdsByImagePath(session.exePath)
    if (pids.length > 0) {
      all = enumerateTopLevelWindowsByPids(pids)
      preferred = selectWeChatMainWindow(all, { ...sessionQuery(session), rootPid: pids[0] })
      if (preferred) session.targetPid = preferred.pid
    }
  }
  if (preferred && preferred.hwnd !== session.hwnd) {
    if (reattachBrokenSession(session, preferred)) return
  }
  if (!isWindow(session.hwnd)) return
  const main = all.find((candidate) => candidate.hwnd === session.hwnd)
  if (!main) return

  const mainState = getWindowEmbedState(session.hwnd)
  const mainIntact = session.degraded
    ? isGuiDegradedStyleIntact(mainState.exStyle, mainState.owner, hostHwnd)
    : isGuiEmbedStyleIntact(mainState.style, mainState.exStyle, mainState.owner, hostHwnd)
  if (!mainIntact) {
    const style = session.degraded
      ? computeGuiDegradedStyle(session.originalStyle, session.originalExStyle)
      : computeGuiEmbedStyle(mainState.style, mainState.exStyle)
    applyWindowEmbedding(session.hwnd, hostHwnd, style.style, style.exStyle)
    const after = getWindowEmbedState(session.hwnd)
    if (session.degraded
      ? !isGuiDegradedStyleIntact(after.exStyle, after.owner, hostHwnd)
      : !isGuiEmbedStyleIntact(after.style, after.exStyle, after.owner, hostHwnd)) {
      session.onLog(t('[gui] 微信主窗口任务栏样式未生效', '[gui] WeChat main-window taskbar style did not stick'))
    }
  }

  for (const candidate of selectWeChatTaskbarHygieneWindows(main, all)) {
    rememberManagedWindow(session, candidate)
    const state = getWindowEmbedState(candidate.hwnd)
    if (!isGuiTaskbarHygieneIntact(state.exStyle) || state.owner !== hostHwnd) {
      try {
        const style = computeGuiTaskbarHygieneStyle(state.style, state.exStyle)
        applyWindowEmbedding(candidate.hwnd, hostHwnd, style.style, style.exStyle)
        const after = getWindowEmbedState(candidate.hwnd)
        if (!isGuiTaskbarHygieneIntact(after.exStyle) || after.owner !== hostHwnd) {
          throw new Error(`after style=${after.style} ex=${after.exStyle} owner=${after.owner}`)
        }
      } catch (error) {
        session.onLog(t(
          `[gui] 微信辅助窗口任务栏样式失败 HWND=${candidate.hwnd}: ${String(error)}`,
          `[gui] Failed to hide WeChat auxiliary window from taskbar HWND=${candidate.hwnd}: ${String(error)}`
        ))
      }
    }
    try { showWindow(candidate.hwnd, false) } catch { /* window may be gone */ }
    const existing = session.satellites.get(candidate.hwnd)
    session.satellites.set(candidate.hwnd, {
      hwnd: candidate.hwnd,
      title: candidate.title,
      className: candidate.className,
      lastStyledAt: Date.now()
    })
    if (!existing) {
      session.onLog(t(
        `[gui] 微信任务栏卫生: 已隐藏辅助顶层窗 HWND=${candidate.hwnd} class=${candidate.className} title="${candidate.title}"`,
        `[gui] WeChat taskbar hygiene: hid auxiliary top-level window HWND=${candidate.hwnd} class=${candidate.className} title="${candidate.title}"`
      ))
    }
  }
}

function refreshWeChatTaskbarHygiene(session: GuiSession): void {
  if (session.policy !== 'wechat-main' || !session.visible || guiPauseDepth > 0) return
  void runNativeTask('wechat-taskbar-hygiene', session, () => refreshWeChatTaskbarHygieneNow(session)).then((result) => {
    if (result.timedOut) session.onLog('[gui] WeChat taskbar hygiene exceeded 2s; skipped this cycle')
    else if (result.error) session.onLog(`[gui] WeChat taskbar hygiene failed: ${String(result.error)}`)
  })
}

function showSession(session: GuiSession): void {
  clearSessionStyleTimers(session)
  if (!isWindow(session.hwnd)) return
  // hideSession() restores the original frame/owner, so re-embed synchronously
  // before the window becomes visible again; otherwise it flashes in the taskbar.
  const styleOutcome = session.degraded ? applyDegradedStyleOnce(session) : applyNormalStyleOnce(session)
  if (!styleOutcome.ok) {
    session.onLog(
      t(
        `[gui] 显示前重新嵌入失败: ${styleOutcome.error ?? ''}`,
        `[gui] Failed to re-embed before showing: ${styleOutcome.error ?? ''}`
      )
    )
    if (!session.degraded) requestStyleCheck(session, 'show')
  }
  if (!placeSession(session)) return
  try {
    showWindow(session.hwnd, true)
    session.visible = true
    if (host && !host.isDestroyed() && (host.isFocused() || getForegroundWindow() === hostHwnd)) {
      // Caption-less Chromium/Electron windows only get a composited surface once
      // the user-select action activates them. Never focus a background launch.
      focusWindow(session.hwnd)
    }
    refreshSatellites(session)
    refreshWeChatTaskbarHygiene(session)
    hideSatellites(session)
    if (!session.degraded) {
      requestStyleCheck(session, 'show')
      scheduleStyleCheck(session, SHOW_VERIFY_MS)
    }
  } catch (err) {
    reportSessionError(session, t(`显示附属窗口失败: ${String(err)}`, `failed to show the app window: ${String(err)}`))
  }
}

function relayout(): void {
  if (!host || host.isDestroyed()) return
  if (!hostVisible || host.isMinimized()) {
    hideActive()
    return
  }
  if (!activeId) return
  const session = sessions.get(activeId)
  if (!session) return
  if (!isWindow(session.hwnd)) {
    hideSession(session)
    return
  }
  if (!session.visible) return
  placeSession(session)
}

function scheduleLayout(): void {
  if (layoutTimer) clearTimeout(layoutTimer)
  layoutTimer = setTimeout(() => {
    layoutTimer = null
    scheduleNativeTask('relayout', undefined, relayout)
  }, 16)
}

/** Snap an embedded window back if the app/user moves or resizes it. */
function enforceActiveSessionBounds(): void {
  if (guiPauseDepth > 0 || !host || host.isDestroyed() || !hostVisible || host.isMinimized() || !activeId) return
  const session = sessions.get(activeId)
  if (!session?.visible || !isWindow(session.hwnd)) return
  const target = targetPhysicalRect()
  const current = getWindowCandidate(session.hwnd)
  if (!target || !current) return
  const targetRect = {
    x: target.left,
    y: target.top,
    width: Math.max(1, target.right - target.left),
    height: Math.max(1, target.bottom - target.top)
  }
  const usesClientFix = guiPolicyUsesClientInsetFix(session.policy)
  const expected = usesClientFix
    ? windowRectForContent(session.hwnd, targetRect)
    : { x: targetRect.x, y: targetRect.y, width: targetRect.width, height: targetRect.height }
  const tolerance = 2
  const matches =
    Math.abs(current.rect.left - expected.x) <= tolerance &&
    Math.abs(current.rect.top - expected.y) <= tolerance &&
    Math.abs(current.rect.right - (expected.x + expected.width)) <= tolerance &&
    Math.abs(current.rect.bottom - (expected.y + expected.height)) <= tolerance
  try {
    if (matches) {
      if (usesClientFix) ensureWindowClientRegion(session.hwnd)
    } else if (usesClientFix) {
      positionWindow(session.hwnd, targetRect)
    } else {
      positionWindowRaw(session.hwnd, targetRect)
    }
  } catch {
    // The normal style/maintenance loop will report a vanished/recreated window.
  }
}

function hostGeometryChanged(): void {
  if (guiPauseDepth > 0) return
  if (!host || host.isDestroyed()) return
  const visible = host.isVisible() && !host.isMinimized()
  if (visible !== hostVisible) {
    hostVisible = visible
    if (!hostVisible) hideActive()
  }
  const box = host.getContentBounds()
  const signature = `${box.x},${box.y},${box.width},${box.height},${visible ? 1 : 0}`
  if (signature === lastHostGeometry) {
    enforceActiveSessionBounds()
    return
  }
  lastHostGeometry = signature
  scheduleLayout()
  enforceActiveSessionBounds()
}

function reattachBrokenSession(session: GuiSession, forced?: GuiWindowCandidate): boolean {
  const found = forced
    ? { window: forced, viaPath: false }
    : resolveWindow(sessionQuery(session), session.policy)
  if (!found || (!forced && found.window.hwnd === session.hwnd)) return false
  const previous = session.hwnd
  clearSessionStyleTimers(session)
  restoreSessionWindows(session)
  for (const hwnd of session.managedWindows.keys()) {
    if (isWindow(hwnd)) {
      try { showWindow(hwnd, false) } catch { /* window may be gone */ }
    }
  }
  session.hwnd = found.window.hwnd
  session.targetPid = found.window.pid
  session.title = found.window.title
  session.visible = false
  session.managedWindows.clear()
  session.satellites.clear()
  const snapshot = rememberManagedWindow(session, found.window, true)
  session.originalStyle = snapshot.style
  session.originalExStyle = snapshot.exStyle
  session.missingChecks = 0
  session.failureReported = false
  session.warningLogged = false
  session.styleRetryCount = 0
  session.lastStyleAppliedAt = 0
  session.onLog(
    t(
      `[gui] 主窗口已更换 (HWND ${previous} → ${session.hwnd})，已重新接管。`,
      `[gui] Main window changed (HWND ${previous} → ${session.hwnd}); re-attached.`
    )
  )
  // Re-apply immediately so a replaced window cannot keep APPWINDOW/taskbar
  // visibility even briefly after re-attachment.
  const outcome = session.degraded ? applyDegradedStyleOnce(session) : applyNormalStyleOnce(session)
  if (!outcome.ok) {
    session.onLog(
      t(
        `[gui] 重新接管后样式应用失败: ${outcome.error ?? ''}`,
        `[gui] Failed to apply style after re-attach: ${outcome.error ?? ''}`
      )
    )
    if (!session.degraded) requestStyleCheck(session, 'reattach')
  } else {
    session.lastStyleAppliedAt = Date.now()
  }
  refreshSatellites(session)
  refreshWeChatTaskbarHygiene(session)
  if (activeId === session.instanceId && hostVisible) showSession(session)
  return true
}

/** Attach the host launcher window and start following its bounds. */
export function registerGuiView(win: BrowserWindow): void {
  host = win
  hostHwnd = nativeWindowHandle(win)
  hostVisible = win.isVisible() && !win.isMinimized()
  lastHostGeometry = ''
  sidebarWidth = sidebarTarget

  win.on('move', scheduleLayout)
  win.on('resize', scheduleLayout)
  win.on('maximize', scheduleLayout)
  win.on('unmaximize', scheduleLayout)
  win.on('enter-full-screen', scheduleLayout)
  win.on('leave-full-screen', scheduleLayout)
  win.on('show', () => {
    hostVisible = true
    const session = activeId ? sessions.get(activeId) : undefined
    if (session) showSession(session)
    else scheduleLayout()
  })
  win.on('hide', () => {
    hostVisible = false
    hideActive()
  })
  win.on('minimize', () => {
    hostVisible = false
    hideActive()
  })
  win.on('restore', () => {
    hostVisible = true
    const session = activeId ? sessions.get(activeId) : undefined
    if (session) showSession(session)
    else scheduleLayout()
  })
  win.on('closed', () => shutdownGuiView())

  if (hostPollTimer) clearInterval(hostPollTimer)
  hostPollTimer = setInterval(hostGeometryChanged, POLL_MS)
  hostPollTimer.unref?.()
  if (styleTimer) clearInterval(styleTimer)
  styleTimer = setInterval(() => {
    if (guiPauseDepth > 0) return
    for (const session of sessions.values()) maintainSession(session)
  }, STYLE_CHECK_MS)
  styleTimer.unref?.()
  if (satelliteTimer) clearInterval(satelliteTimer)
  satelliteTimer = setInterval(() => {
    if (guiPauseDepth > 0) return
    for (const session of sessions.values()) {
      if (session.policy === 'codex-multi') refreshSatellites(session)
      else if (session.policy === 'wechat-main') refreshWeChatTaskbarHygiene(session)
    }
  }, SATELLITE_SCAN_MS)
  satelliteTimer.unref?.()
}

/** Start the native window/poll timers after an instance has attached. */
function ensureHostPolling(): void {
  if (!host || host.isDestroyed() || hostPollTimer) return
  hostPollTimer = setInterval(hostGeometryChanged, POLL_MS)
  hostPollTimer.unref?.()
}

/** HWND-only snapshot used by Chrome's pre-spawn baseline. */
export function captureTopLevelWindowBaseline(): number[] {
  const started = performance.now()
  const handles = enumerateTopLevelWindowHandles()
  const elapsed = performance.now() - started
  if (classifyGuiNativeDuration(elapsed) !== 'ok') {
    console.warn(`[gui] native baseline enumeration took ${elapsed.toFixed(1)}ms`)
  }
  return handles
}

function maintainSession(session: GuiSession): void {
  if (!isWindow(session.hwnd)) {
    session.missingChecks++
    if (session.missingChecks >= 3) {
      if (!reattachBrokenSession(session) && !session.failureReported) {
        reportSessionError(
          session,
          t(
            '目标窗口已消失，实例仍在运行但无法继续嵌入。',
            'The target window disappeared; the process is alive but can no longer be embedded.'
          )
        )
      }
    }
    return
  }
  session.missingChecks = 0
  if (!session.visible) return
  if (!session.degraded) requestStyleCheck(session, 'poll')
}

async function waitForStableWindow(
  options: GuiAttachOptions,
  policy: GuiWindowPolicy,
  deadline: number
): Promise<{ window: GuiWindowCandidate; viaPath: boolean } | null> {
  const query: GuiWindowQuery = {
    rootPid: options.rootPid,
    exePath: options.exePath,
    windowTitle: options.windowTitle,
    windowClass: options.windowClass,
    ownerHwnd: hostHwnd || undefined,
    baselineHwnds: options.baselineHwnds
  }
  let pidResolutionLogged = false
  let resolvedExePids: number[] = []
  let lastPidScanAt = 0
  while (Date.now() < deadline) {
    if (options.shouldAbort?.()) return null
    if (guiPauseDepth > 0) {
      await delay(200)
      continue
    }
    if (!options.keepPollingAfterRootExit && !options.isAlive()) return null
    if (
      options.keepPollingAfterRootExit &&
      policy !== 'chrome-newest' &&
      (!options.isAlive() || query.rootPid <= 0) &&
      (resolvedExePids.length === 0 || Date.now() - lastPidScanAt > 5000)
    ) {
      lastPidScanAt = Date.now()
      const resolvedPids = await runNativeTask('resolve-exe-pids', undefined, () => findProcessIdsByImagePath(options.exePath))
      if (resolvedPids.timedOut) {
        console.warn('[gui] exe-path PID scan exceeded 2s; skipping this attempt')
      } else {
        const pids = resolvedPids.value ?? []
        resolvedExePids = pids
        if (pids.length > 0 && !pids.includes(query.rootPid)) {
          query.rootPid = pids[0]
          options.rootPid = pids[0]
          if (!pidResolutionLogged) {
            pidResolutionLogged = true
            options.onLog(t(
              `[gui] 启动器进程已退出，按 exe 路径找到真实进程 PID=${pids[0]}，继续等待窗口…`,
              `[gui] Launcher process exited; resolved the real process PID=${pids[0]} by executable path and continued waiting…`
            ))
          }
        }
      }
    }
    const resolved = await runNativeTask('resolve-window', undefined, () => resolveWindow(query, policy))
    if (resolved.timedOut) {
      console.warn('[gui] window discovery exceeded 2s; skipping this attempt')
      await delay(WINDOW_POLL_MS)
      continue
    }
    const found = resolved.value
    if (!found) {
      await delay(WINDOW_POLL_MS)
      continue
    }
    const target = found.window
    await runNativeTask('hide-unstable-window', undefined, () => {
      try { showWindow(target.hwnd, false) } catch { /* window may be gone */ }
    })
    let lastSignature = guiWindowSignature(target)
    let stableSince = Date.now()
    options.onLog(t(
      `[gui] 主窗口已找到 HWND=${target.hwnd}，等待 ${STARTUP_STABLE_MS / 1000}s 启动稳定期…`,
      `[gui] Main window found HWND=${target.hwnd}; waiting ${STARTUP_STABLE_MS / 1000}s for startup to settle…`
    ))
    while (Date.now() < deadline) {
      await delay(STABLE_POLL_MS)
      if (guiPauseDepth > 0) continue
      if (!options.keepPollingAfterRootExit && !options.isAlive()) return null
      const sampled = await runNativeTask('sample-stable-window', undefined, () => getWindowCandidate(target.hwnd))
      if (sampled.timedOut) {
        console.warn('[gui] stable-window sample exceeded 2s; skipping this sample')
        continue
      }
      const current = sampled.value
      if (!current) break
      await runNativeTask('hide-stable-window', undefined, () => {
        try { showWindow(current.hwnd, false) } catch { /* window may be gone */ }
      })
      const signature = guiWindowSignature(current)
      if (signature !== lastSignature) {
        lastSignature = signature
        stableSince = Date.now()
        options.onLog(t('[gui] 主窗口标题/尺寸仍在变化，继续等待稳定…', '[gui] Window title/bounds are still changing; continuing to wait…'))
        continue
      }
      if (Date.now() - stableSince >= STARTUP_STABLE_MS) {
        return { window: current, viaPath: found.viaPath }
      }
    }
    await delay(WINDOW_POLL_MS)
  }
  return null
}

/** Attach one GUI window while preserving the foreground window of the caller. */
export async function attachGuiInstance(options: GuiAttachOptions): Promise<GuiAttachResult> {
  const previousForeground = options.foregroundBeforeSpawn ?? getForegroundWindow()
  try {
    return await attachGuiInstanceInner(options)
  } finally {
    restoreForegroundWindow(previousForeground)
  }
}

/**
 * Wait for the app main window, keep it hidden for a two-second quiet period,
 * then apply the owned-window style with exponential-backoff retries. If the app
 * keeps reverting the style, the session switches to degraded mode instead of
 * fighting forever.
 */
async function attachGuiInstanceInner(options: GuiAttachOptions): Promise<GuiAttachResult> {
  if (!host || host.isDestroyed() || !hostHwnd) {
    return { ok: false, error: t('启动器窗口尚未就绪。', 'The launcher window is not ready.') }
  }
  if (!existsSync(options.exePath)) {
    return { ok: false, error: t(`程序不存在: ${options.exePath}`, `Executable not found: ${options.exePath}`) }
  }
  ensureHostPolling()
  const policy = resolveGuiWindowPolicy({ exePath: options.exePath, windowPolicy: options.windowPolicy })
  const deadline = Date.now() + Math.max(1000, options.timeoutMs)
  let announced = false
  while (Date.now() < deadline) {
    if (options.shouldAbort?.()) break
    if (!options.keepPollingAfterRootExit && !options.isAlive()) {
      return { ok: false, error: t('应用进程在窗口出现前已退出。', 'The app process exited before its window appeared.') }
    }
    const found = await waitForStableWindow(options, policy, deadline)
    if (!found) break
    const window = found.window
    const session: GuiSession = {
      instanceId: options.instanceId,
      rootPid: options.rootPid,
      targetPid: window.pid,
      exePath: options.exePath,
      windowTitle: options.windowTitle,
      windowClass: options.windowClass,
      policy,
      baselineHwnds: options.baselineHwnds,
      hwnd: window.hwnd,
      title: window.title,
      visible: false,
      originalStyle: window.style,
      originalExStyle: window.exStyle,
      managedWindows: new Map(),
      satellites: new Map(),
      degraded: false,
      degradedReported: false,
      styleInFlight: false,
      styleQueued: false,
      styleWorkTimer: null,
      styleRetryTimer: null,
      styleRetryCount: 0,
      lastStyleAppliedAt: 0,
      warningLogged: false,
      failureReported: false,
      missingChecks: 0,
      onLog: options.onLog,
      onError: options.onError,
      onDegraded: options.onDegraded
    }
    const initialSnapshot = rememberManagedWindow(session, window, true)
    session.originalStyle = initialSnapshot.style
    session.originalExStyle = initialSnapshot.exStyle

    let lastStyleError = ''
    for (let attempt = 0; attempt <= MAX_STYLE_RETRIES; attempt++) {
      if (attempt > 0) {
        const wait = guiStyleRetryDelay(attempt - 1) ?? 8000
        options.onLog(t(
          `[gui] 样式应用失败，${wait / 1000}s 后重试 (${attempt}/${MAX_STYLE_RETRIES})…`,
          `[gui] Style attempt failed; retrying in ${wait / 1000}s (${attempt}/${MAX_STYLE_RETRIES})…`
        ))
        await delay(wait)
      }
      const outcome = await runStyleTask(session, () => applyNormalStyleOnce(session))
      if (outcome.ok) {
        session.lastStyleAppliedAt = Date.now()
        session.styleRetryCount = 0
        lastStyleError = ''
        break
      }
      lastStyleError = outcome.error ?? ''
      session.styleRetryCount = attempt + 1
      if (!isWindow(session.hwnd)) {
        return { ok: false, error: t('目标窗口在应用样式前消失。', 'The target window disappeared before styling.') }
      }
    }
    if (!isWindow(session.hwnd)) {
      return { ok: false, error: t('目标窗口在应用样式前消失。', 'The target window disappeared before styling.') }
    }
    if (lastStyleError) {
      enterDegraded(session, lastStyleError)
    }

    sessions.set(options.instanceId, session)
    options.onLog(
      t(
        `[gui] 已接管主窗口 HWND=${window.hwnd} pid=${window.pid} title="${window.title}" policy=${policy}${found.viaPath ? ' (按 exe 路径接管)' : ''}${session.degraded ? ' [degraded]' : ''}`,
        `[gui] Main window attached: HWND=${window.hwnd} pid=${window.pid} title="${window.title}" policy=${policy}${found.viaPath ? ' (adopted by executable path)' : ''}${session.degraded ? ' [degraded]' : ''}`
      )
    )
    refreshSatellites(session)
    refreshWeChatTaskbarHygiene(session)
    if (activeId === options.instanceId && hostVisible) showSession(session)
    else hideSession(session)
    return {
      ok: true,
      hwnd: window.hwnd,
      pid: window.pid,
      title: window.title,
      hiddenInitially: !window.visible,
      degraded: session.degraded,
      degradedReason: session.degraded ? lastStyleError || undefined : undefined,
      stopMode: options.stopMode ?? guiPolicyStopMode(policy)
    }
  }
  return {
    ok: false,
    error: policy === 'chrome-newest'
      ? t(
        'Chrome 未创建新窗口（可能复用了现有窗口），请先关闭已有窗口或使用独立 profile。',
        'Chrome did not create a new window (it may have reused an existing one); close existing Chrome windows or use an isolated profile.'
      )
      : t(
        `在 ${Math.round(options.timeoutMs / 1000)} 秒内没有找到可嵌入的主窗口。`,
        `No embeddable main window appeared within ${Math.round(options.timeoutMs / 1000)} seconds.`
      )
  }
}

/** Show one GUI instance (and hide the previously active one). */
export function setGuiActive(instanceId: string, active: boolean): void {
  if (!active) {
    hideActive()
    activeId = null
    return
  }
  activeId = instanceId
  for (const [id, session] of sessions) {
    if (id !== instanceId) hideSession(session)
  }
  const session = sessions.get(instanceId)
  if (!session) return
  if (!host || !hostVisible) {
    hideSession(session)
    return
  }
  showSession(session)
}

/** Hide and forget one instance (called on stop/remove, before process cleanup). */
export function detachGuiInstance(instanceId: string): void {
  const session = sessions.get(instanceId)
  if (session) {
    clearSessionStyleTimers(session)
    hideSatellites(session)
    // Stop/restart must return the app to a normal, usable top-level window.
    restoreSessionWindows(session, true, true)
    session.visible = false
  }
  sessions.delete(instanceId)
  if (activeId === instanceId) activeId = null
}

/**
 * Close only the selected window (Chrome shares one process across windows).
 * Returns false when the window ignored WM_CLOSE; the caller must not taskkill
 * the whole browser process in that case.
 */
export async function closeGuiWindow(instanceId: string): Promise<boolean> {
  const session = sessions.get(instanceId)
  if (!session) return true
  clearSessionStyleTimers(session)
  hideSatellites(session)
  hideSession(session)
  const hwnd = session.hwnd
  const ok = closeWindow(hwnd)
  if (!ok) {
    sessions.delete(instanceId)
    if (activeId === instanceId) activeId = null
    return false
  }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (!isWindow(hwnd)) {
      sessions.delete(instanceId)
      if (activeId === instanceId) activeId = null
      return true
    }
    await delay(100)
  }
  sessions.delete(instanceId)
  if (activeId === instanceId) activeId = null
  return false
}

/** Synchronous best effort used during launcher shutdown. */
export function closeGuiWindowSync(instanceId: string): void {
  const session = sessions.get(instanceId)
  if (!session) return
  clearSessionStyleTimers(session)
  hideSatellites(session)
  closeWindow(session.hwnd)
  hideSession(session)
  sessions.delete(instanceId)
  if (activeId === instanceId) activeId = null
}

/** Hide and forget every GUI instance (launcher shutdown). */
export function detachAllGuiInstances(): void {
  for (const session of sessions.values()) {
    clearSessionStyleTimers(session)
    hideSatellites(session)
    restoreSessionWindows(session, true, true)
    session.visible = false
  }
  sessions.clear()
  activeId = null
}

/** Stop timers and drop all sessions. Safe to call more than once. */
export function shutdownGuiView(): void {
  detachAllGuiInstances()
  guiPauseDepth = 0
  nativeQueue.length = 0
  nativeBusy = false
  if (nativePumpTimer) clearTimeout(nativePumpTimer)
  nativePumpTimer = null
  if (layoutTimer) clearTimeout(layoutTimer)
  layoutTimer = null
  if (hostPollTimer) clearInterval(hostPollTimer)
  hostPollTimer = null
  if (styleTimer) clearInterval(styleTimer)
  styleTimer = null
  if (satelliteTimer) clearInterval(satelliteTimer)
  satelliteTimer = null
  if (sidebarTimer) clearTimeout(sidebarTimer)
  sidebarTimer = null
  host = null
  hostHwnd = 0
}

/** Keep the window flush with the animated sidebar. */
export function setGuiSidebarWidth(width: number): void {
  const target = Math.max(0, Math.round(Number.isFinite(width) ? width : sidebarTarget))
  if (target === sidebarTarget) return
  sidebarTarget = target
  if (sidebarTimer) clearTimeout(sidebarTimer)
  const from = sidebarWidth
  const startedAt = Date.now()
  const tick = (): void => {
    const progress = Math.min(1, (Date.now() - startedAt) / SIDEBAR_ANIM_MS)
    const eased = 1 - Math.pow(1 - progress, 3)
    sidebarWidth = Math.round(from + (target - from) * eased)
    relayout()
    if (progress < 1) {
      sidebarTimer = setTimeout(tick, 16)
    } else {
      sidebarWidth = target
      sidebarTimer = null
      relayout()
    }
  }
  sidebarTimer = setTimeout(tick, 16)
}

/** Reserve top/right/bottom chrome space (S2 top bar can pass its height here). */
export function setGuiContentInsets(insets: Partial<GuiContentInsets>): void {
  contentInsets = {
    top: Math.max(0, Math.round(insets.top ?? contentInsets.top)),
    right: Math.max(0, Math.round(insets.right ?? contentInsets.right)),
    bottom: Math.max(0, Math.round(insets.bottom ?? contentInsets.bottom))
  }
  scheduleLayout()
}

/** Capture the current foreground HWND before spawning a GUI app. */
export function captureGuiForegroundWindow(): number {
  return getForegroundWindow()
}

/** True when this GUI instance still has a live embedded window. */
export function isGuiInstanceWindowAlive(instanceId: string): boolean {
  const session = sessions.get(instanceId)
  return Boolean(session && isWindow(session.hwnd))
}

/** Focus an embedded GUI window only while its launcher host is the foreground window. */
export function focusGuiInstance(instanceId: string): boolean {
  const session = sessions.get(instanceId)
  if (!session || !isWindow(session.hwnd)) return false
  if (host && !host.isDestroyed() && (host.isFocused() || getForegroundWindow() === hostHwnd)) {
    focusWindow(session.hwnd)
  }
  return true
}

/** Exposed for diagnostics/tests: choose an app window without side effects. */
export function findGuiWindowForProcess(
  query: GuiWindowQuery,
  policy: GuiWindowPolicy = 'default'
): GuiWindowCandidate | null {
  const started = performance.now()
  const found = resolveWindow(query, policy)?.window ?? null
  const elapsed = performance.now() - started
  if (classifyGuiNativeDuration(elapsed) !== 'ok') {
    console.warn(`[gui] native adoption lookup took ${elapsed.toFixed(1)}ms`)
  }
  return found
}
