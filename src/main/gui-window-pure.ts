// Pure helpers for GUI-instance window embedding. No Electron or Win32 imports:
// the main-process bridge supplies native window facts and applies the results.

/** Screen-space rectangle in Electron DIP coordinates. */
export interface GuiRect {
  x: number
  y: number
  width: number
  height: number
}

/** Win32 window rectangle (exclusive right/bottom, as returned by GetWindowRect). */
export interface GuiWindowRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** Everything the window chooser needs to know about one top-level HWND. */
export interface GuiWindowCandidate {
  hwnd: number
  pid: number
  title: string
  className: string
  visible: boolean
  iconic: boolean
  owner: number
  style: number
  exStyle: number
  rect: GuiWindowRect
  /** Resolved lazily only for fallback matches; root-PID windows do not need it. */
  processPath?: string
  /** Manager-assigned first-observation time, used by the Chrome newest-window policy. */
  firstSeenAt?: number
}

/** How a GUI instance chooses and owns application windows. */
export type GuiWindowPolicy =
  | 'default'
  | 'codex-multi'
  | 'chrome-newest'
  | 'wechat-main'
  /** One main Electron window; a minimized-to-tray start is restored on attach. */
  | 'electron-main'
  /** VS Code: embed one main window and keep extension-host/devtools windows external. */
  | 'vscode-main'
  /** Zotero: XUL/GTK main window; progress and preference dialogs stay external. */
  | 'zotero-main'

/** Identity of the process/window an instance should adopt. */
export interface GuiWindowQuery {
  rootPid: number
  exePath: string
  /** Optional exact/substring title filter. */
  windowTitle?: string
  /** Optional exact window-class filter. */
  windowClass?: string
  /** Launcher HWND. Allows re-resolving a window that this launcher already owns. */
  ownerHwnd?: number
  /** HWNDs observed before spawn; Chrome only accepts windows absent from this set. */
  baselineHwnds?: readonly number[]
}

export const WS_CAPTION = 0x00c00000
export const WS_THICKFRAME = 0x00040000
export const WS_MINIMIZEBOX = 0x00020000
export const WS_SYSMENU = 0x00080000
export const WS_MAXIMIZEBOX = 0x00010000
export const WS_EX_TOOLWINDOW = 0x00000080
export const WS_EX_WINDOWEDGE = 0x00000100
export const WS_EX_CLIENTEDGE = 0x00000200
export const WS_EX_STATICEDGE = 0x00020000
export const WS_EX_APPWINDOW = 0x00040000
export const WS_BORDER = 0x00800000
export const WS_DLGFRAME = 0x00400000

const MIN_GUI_WINDOW_WIDTH = 160
const MIN_GUI_WINDOW_HEIGHT = 120
const EMBEDDED_STYLE_MASK = WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_BORDER | WS_DLGFRAME
const EMBEDDED_EXSTYLE_REMOVE = WS_EX_APPWINDOW | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE

/** Classes used by the current WeChat/Weixin desktop clients. */
export const WECHAT_MAIN_CLASSES = [
  'WeChatMainWndForPC',
  'WeixinMainWndForPC',
  'Qt51514QWindowIcon'
] as const
const WECHAT_MAIN_TITLES = ['微信', 'wechat', 'weixin'] as const
const IGNORED_HELPER_TITLES = new Set(['Default IME', 'MSCTFIME UI', 'WxTrayIconMessageWindow'])
/** Electron's top-level Chromium window class (VS Code, Typora, Qoder, ZCode, Chrome). */
export const ELECTRON_WINDOW_CLASS = 'Chrome_WidgetWin_1'
/** Zotero 7 is Firefox/XUL based and exposes the Gecko top-level window class. */
export const ZOTERO_WINDOW_CLASS = 'MozillaWindowClass'
const CHROME_WINDOW_CLASS = ELECTRON_WINDOW_CLASS
const VSCODE_WINDOW_TITLE = /visual studio code/i
const VSCODE_WELCOME_TITLE = /^(欢迎|welcome)(\s|$)/i
/** Titles used by VS Code windows that must stay external to the embedded instance. */
const VSCODE_AUXILIARY_TITLE_PATTERNS = [
  /\[扩展开发宿主\]/i,
  /\[extension development host\]/i,
  /\[extension host\]/i,
  /\bdeveloper tools\b/i,
  /^devtools\b/i
] as const
/** Zotero transient dialogs that share MozillaWindowClass but are not the library window. */
const ZOTERO_DIALOG_TITLE = /^(进度|progress|更新|update|checking|downloading|saving|loading)\b/i
const ZOTERO_DIALOG_MIN_WIDTH = 400
const ZOTERO_DIALOG_MIN_HEIGHT = 300

/** Retry delays required for GUI style recovery. */
export const GUI_STYLE_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000] as const

/** Native-call warning thresholds: one frame budget and the hard skip timeout. */
export const GUI_NATIVE_FRAME_BUDGET_MS = 16
export const GUI_NATIVE_TIMEOUT_MS = 2000

export type GuiNativeDurationClass = 'ok' | 'slow' | 'timeout'

/** Classify one native embedding batch duration for warning/timeout handling. */
export function classifyGuiNativeDuration(elapsedMs: number): GuiNativeDurationClass {
  if (!Number.isFinite(elapsedMs) || elapsedMs > GUI_NATIVE_TIMEOUT_MS) return 'timeout'
  if (elapsedMs > GUI_NATIVE_FRAME_BUDGET_MS) return 'slow'
  return 'ok'
}

/** Resolve a configured policy, falling back to executable-name inference. */
export function resolveGuiWindowPolicy(input: {
  exePath: string
  windowPolicy?: GuiWindowPolicy
}): GuiWindowPolicy {
  if (input.windowPolicy) return input.windowPolicy
  const base = input.exePath.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (base === 'chrome.exe') return 'chrome-newest'
  if (base === 'wechat.exe' || base === 'weixin.exe') return 'wechat-main'
  if (base === 'chatgpt.exe' || base === 'codex.exe') return 'codex-multi'
  if (base === 'code.exe') return 'vscode-main'
  if (base === 'typora.exe' || base === 'qoder.exe' || base === 'qoder cn.exe' || base === 'zcode.exe') {
    return 'electron-main'
  }
  if (base === 'zotero.exe') return 'zotero-main'
  return 'default'
}

/** Normalize a Windows executable path for comparison. */
export function normalizeWindowsPath(path: string): string {
  return path.trim().replace(/\//g, '\\').replace(/\\+/g, '\\').toLowerCase()
}

/** Exact executable-path identity used when a spawn stub hands off to another PID. */
export function processImagePathMatches(actualPath: string, expectedPath: string): boolean {
  if (!actualPath.trim() || !expectedPath.trim()) return false
  return normalizeWindowsPath(actualPath) === normalizeWindowsPath(expectedPath)
}

/** Original Win32 attributes captured before this launcher touches a window. */
export interface GuiWindowStyleSnapshot {
  hwnd: number
  style: number
  exStyle: number
  owner: number
  visible: boolean
  iconic: boolean
}

/** Capture the exact restore state before applying any embedding style/owner. */
export function snapshotGuiWindowStyle(candidate: GuiWindowCandidate): GuiWindowStyleSnapshot {
  return {
    hwnd: candidate.hwnd,
    style: candidate.style >>> 0,
    exStyle: candidate.exStyle >>> 0,
    owner: candidate.owner,
    visible: candidate.visible,
    iconic: candidate.iconic
  }
}

/** Repair WeChat's normal frameless Qt frame after an older launcher stripped it. */
export function repairWeChatWindowStyleSnapshot(snapshot: GuiWindowStyleSnapshot): GuiWindowStyleSnapshot {
  const damaged = (snapshot.exStyle & WS_EX_TOOLWINDOW) !== 0 || snapshot.owner !== 0
  const missingFrame = !hasGuiWindowFrame(snapshot.style)
  if (!damaged && !missingFrame) return snapshot
  return {
    ...snapshot,
    style: (
      snapshot.style |
      WS_CAPTION |
      WS_BORDER |
      WS_DLGFRAME |
      WS_THICKFRAME |
      WS_MINIMIZEBOX |
      WS_MAXIMIZEBOX |
      WS_SYSMENU
    ) >>> 0,
    exStyle: (
      (snapshot.exStyle | WS_EX_WINDOWEDGE) &
      ~(WS_EX_TOOLWINDOW | WS_EX_APPWINDOW | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE)
    ) >>> 0,
    owner: 0
  }
}

/** True when a normal app window has caption, resize frame, system menu and min/max buttons. */
export function hasGuiWindowFrame(style: number): boolean {
  const frame = WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU
  return ((style >>> 0) & frame) === frame
}

/**
 * Repair a snapshot left caption-less by an older launcher run. The true
 * original style is unrecoverable, so restore the standard resizable frame and
 * remove the forced tool-window/taskbar bits.
 */
export function repairGuiWindowStyleSnapshot(snapshot: GuiWindowStyleSnapshot): GuiWindowStyleSnapshot {
  if (hasGuiWindowFrame(snapshot.style) && snapshot.owner === 0) return snapshot
  return {
    ...snapshot,
    style: (snapshot.style | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU) >>> 0,
    exStyle: ((snapshot.exStyle | WS_EX_APPWINDOW | WS_EX_WINDOWEDGE) & ~WS_EX_TOOLWINDOW) >>> 0,
    owner: 0
  }
}

/** True when style, extended style and owner all match the captured original. */
export function guiWindowStyleRestored(
  snapshot: Pick<GuiWindowStyleSnapshot, 'style' | 'exStyle' | 'owner'>,
  current: { style: number; exStyle: number; owner: number }
): boolean {
  return (
    (current.style >>> 0) === (snapshot.style >>> 0) &&
    (current.exStyle >>> 0) === (snapshot.exStyle >>> 0) &&
    current.owner === snapshot.owner
  )
}

/** Width/height area of a Win32 rectangle, clamped at zero. */
export function guiWindowArea(rect: GuiWindowRect): number {
  return Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top)
}

/** Whether a candidate is a plausible interactive top-level app window. */
export function isUsableGuiWindow(candidate: GuiWindowCandidate, options?: { allowIconic?: boolean }): boolean {
  if (candidate.iconic && options?.allowIconic !== true) return false
  // A minimized Win32 window often reports a tiny placeholder rectangle. The
  // WeChat policy is allowed to trust its main-window class/title and restore it.
  if (!(candidate.iconic && options?.allowIconic === true)) {
    if (guiWindowArea(candidate.rect) < MIN_GUI_WINDOW_WIDTH * MIN_GUI_WINDOW_HEIGHT) return false
  }
  const title = candidate.title.trim()
  // Helper windows (IME, tray, message-only) normally have no title. A hidden
  // app main window (the Codex desktop packages do this on cold start) still has
  // its real title and a sensible rectangle, so require the title instead of
  // requiring IsWindowVisible.
  if (!title) return false
  if (title === 'Default IME' || title === 'MSCTFIME UI') return false
  return true
}

/**
 * Score one candidate. Root-PID matches outrank executable-path fallback
 * matches; the executable check is what recovers a window after a launcher stub
 * exits and hands off to an already-running app process.
 */
/**
 * A main window must be a titled, reasonably sized top-level app window. Tool
 * windows and windows owned by another process are excluded; windows already
 * owned by this launcher remain eligible so re-attachment can work.
 */
export function isEligibleMainWindow(
  candidate: GuiWindowCandidate,
  query: GuiWindowQuery,
  options?: { allowIconic?: boolean }
): boolean {
  if (!isUsableGuiWindow(candidate, options)) return false
  if (IGNORED_HELPER_TITLES.has(candidate.title.trim())) return false
  // An owner-less tool window can be a main window left caption-less by an
  // earlier launcher run. Keep it eligible so re-attachment can repair it.
  if ((candidate.exStyle & WS_EX_TOOLWINDOW) !== 0 && candidate.owner !== 0 && candidate.owner !== query.ownerHwnd) {
    return false
  }
  if ((candidate.exStyle & WS_EX_TOOLWINDOW) !== 0 && candidate.owner === 0 && !query.ownerHwnd) {
    return false
  }
  if (candidate.owner !== 0 && candidate.owner !== query.ownerHwnd) return false
  if (query.windowClass && candidate.className !== query.windowClass) return false
  return true
}

export function scoreGuiWindow(
  candidate: GuiWindowCandidate,
  query: GuiWindowQuery,
  options?: { allowIconic?: boolean }
): number {
  if (!isEligibleMainWindow(candidate, query, options)) return -1
  let score = 0
  if (candidate.pid === query.rootPid) {
    score += 200
  } else if (
    candidate.processPath &&
    normalizeWindowsPath(candidate.processPath) === normalizeWindowsPath(query.exePath)
  ) {
    score += 160
  } else {
    return -1
  }

  const wantedTitle = query.windowTitle?.trim().toLowerCase()
  if (wantedTitle) {
    const actualTitle = candidate.title.trim().toLowerCase()
    if (actualTitle === wantedTitle) score += 120
    else if (actualTitle.includes(wantedTitle)) score += 80
    else return -1
  }

  if (candidate.title.trim()) score += 20
  if (candidate.className === 'Chrome_WidgetWin_1') score += 40
  if (candidate.visible) score += 30
  if (candidate.owner === 0) score += 10
  score += Math.min(20, Math.round(guiWindowArea(candidate.rect) / 100_000))
  return score
}

/** True when the class name is one of the known WeChat main-window classes. */
export function isWeChatMainClass(className: string): boolean {
  return (WECHAT_MAIN_CLASSES as readonly string[]).includes(className)
}

/**
 * WeChat must only select its main window. Chat windows, dialogs, owned windows
 * and tool windows are deliberately excluded, even if they share a Qt class.
 */
export function selectWeChatMainWindow(
  candidates: readonly GuiWindowCandidate[],
  query: GuiWindowQuery
): GuiWindowCandidate | null {
  let best: GuiWindowCandidate | null = null
  let bestScore = -1
  for (const candidate of candidates) {
    // WeChat often starts minimized to the tray. Its class/title identify the
    // main window safely, so allow restoring an iconic main window on attach.
    if (!isEligibleMainWindow(candidate, query, { allowIconic: true })) continue
    if (!isWeChatMainClass(candidate.className)) continue
    const title = candidate.title.trim().toLowerCase()
    let score = scoreGuiWindow(candidate, query, { allowIconic: true }) + 40
    if ((WECHAT_MAIN_TITLES as readonly string[]).includes(title)) score += 120
    if (candidate.visible) score += 20
    if (score > bestScore || (score === bestScore && best !== null && candidate.hwnd < best.hwnd)) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

/**
 * True when a VS Code top-level window belongs to an extension-host or devtools
 * surface. These windows share Chrome_WidgetWin_1 with the main editor window but
 * must never be embedded by a launcher instance.
 */
export function isVSCodeAuxiliaryWindow(candidate: Pick<GuiWindowCandidate, 'title'>): boolean {
  const title = candidate.title.trim()
  if (!title) return false
  return VSCODE_AUXILIARY_TITLE_PATTERNS.some((pattern) => pattern.test(title))
}

/**
 * A single-main Electron window. Eligible windows may be hidden or minimized at
 * startup (Qoder starts hidden, then minimized to the tray); the launcher restores
 * them after attaching. Chromium helper windows have a different class and are
 * rejected by the class filter.
 */
export function isElectronMainWindowCandidate(
  candidate: GuiWindowCandidate,
  query: GuiWindowQuery
): boolean {
  const wantedClass = query.windowClass?.trim() || ELECTRON_WINDOW_CLASS
  if (candidate.className !== wantedClass) return false
  if (!isEligibleMainWindow(candidate, query, { allowIconic: true })) return false
  if (isVSCodeAuxiliaryWindow(candidate)) return false
  return true
}

/** Score a single-main Electron window, preferring visible, restored windows. */
export function selectElectronMainWindow(
  candidates: readonly GuiWindowCandidate[],
  query: GuiWindowQuery
): GuiWindowCandidate | null {
  let best: GuiWindowCandidate | null = null
  let bestScore = -1
  let bestSeenAt = -1
  const baseline = new Set(query.baselineHwnds ?? [])
  for (const candidate of candidates) {
    if (!isElectronMainWindowCandidate(candidate, query)) continue
    let score = scoreGuiWindow(candidate, query, { allowIconic: true })
    if (score < 0) continue
    if (candidate.visible) score += 20
    if (!candidate.iconic) score += 60
    // A post-baseline window is the one this instance asked for; older windows
    // are only a fallback for single-instance handoffs.
    if (baseline.size > 0 && !baseline.has(candidate.hwnd)) score += 40
    const seenAt = candidate.firstSeenAt ?? 0
    if (
      score > bestScore ||
      (score === bestScore && seenAt > bestSeenAt) ||
      (score === bestScore && seenAt === bestSeenAt && best !== null && candidate.hwnd < best.hwnd)
    ) {
      best = candidate
      bestScore = score
      bestSeenAt = seenAt
    }
  }
  return best
}

/**
 * VS Code main-window candidate. Extension host windows, devtools and any
 * pre-spawn window are excluded; the launcher's `--new-window` launch must
 * produce a fresh HWND.
 */
export function isVSCodeMainWindowCandidate(
  candidate: GuiWindowCandidate,
  query: GuiWindowQuery
): boolean {
  const wantedClass = query.windowClass?.trim() || ELECTRON_WINDOW_CLASS
  if (candidate.className !== wantedClass) return false
  if (isVSCodeAuxiliaryWindow(candidate)) return false
  if (!isEligibleMainWindow(candidate, query, { allowIconic: true })) return false
  const wantedTitle = query.windowTitle?.trim().toLowerCase()
  if (wantedTitle && !candidate.title.trim().toLowerCase().includes(wantedTitle)) return false
  const baseline = query.baselineHwnds ?? []
  if (baseline.length > 0 && baseline.includes(candidate.hwnd)) return false
  return true
}

/**
 * Prefer the welcome window created by `--new-window`, then the newest fresh
 * main window. Restored workspace windows are never preferred over the new one.
 */
export function selectVSCodeMainWindow(
  candidates: readonly GuiWindowCandidate[],
  query: GuiWindowQuery
): GuiWindowCandidate | null {
  let best: GuiWindowCandidate | null = null
  let bestScore = -1
  let bestSeenAt = -1
  for (const candidate of candidates) {
    if (!isVSCodeMainWindowCandidate(candidate, query)) continue
    let score = scoreGuiWindow(candidate, query, { allowIconic: true })
    if (score < 0) continue
    if (VSCODE_WELCOME_TITLE.test(candidate.title.trim())) score += 60
    else if (VSCODE_WINDOW_TITLE.test(candidate.title)) score += 20
    if (candidate.visible) score += 20
    if (!candidate.iconic) score += 40
    const seenAt = candidate.firstSeenAt ?? 0
    if (
      score > bestScore ||
      (score === bestScore && seenAt > bestSeenAt) ||
      (score === bestScore && seenAt === bestSeenAt && best !== null && candidate.hwnd < best.hwnd)
    ) {
      best = candidate
      bestScore = score
      bestSeenAt = seenAt
    }
  }
  return best
}

/**
 * Zotero's library window. MozillaWindowClass is also used by progress and
 * preference dialogs, so small transient windows and known progress titles are
 * excluded before scoring the largest visible window.
 */
export function isZoteroMainWindowCandidate(
  candidate: GuiWindowCandidate,
  query: GuiWindowQuery
): boolean {
  const wantedClass = query.windowClass?.trim() || ZOTERO_WINDOW_CLASS
  if (candidate.className !== wantedClass) return false
  if (!isEligibleMainWindow(candidate, query, { allowIconic: true })) return false
  if (ZOTERO_DIALOG_TITLE.test(candidate.title.trim())) return false
  if (!candidate.iconic) {
    const width = Math.max(0, candidate.rect.right - candidate.rect.left)
    const height = Math.max(0, candidate.rect.bottom - candidate.rect.top)
    if (width < ZOTERO_DIALOG_MIN_WIDTH || height < ZOTERO_DIALOG_MIN_HEIGHT) return false
  }
  return true
}

/** Score the Zotero library window; area dominates transient dialogs. */
export function selectZoteroMainWindow(
  candidates: readonly GuiWindowCandidate[],
  query: GuiWindowQuery
): GuiWindowCandidate | null {
  let best: GuiWindowCandidate | null = null
  let bestScore = -1
  for (const candidate of candidates) {
    if (!isZoteroMainWindowCandidate(candidate, query)) continue
    let score = scoreGuiWindow(candidate, query, { allowIconic: true }) + 40
    const title = candidate.title.trim().toLowerCase()
    if (title.includes('zotero')) score += 40
    if (candidate.visible) score += 20
    if (!candidate.iconic) score += 30
    score += Math.min(40, Math.round(guiWindowArea(candidate.rect) / 100_000))
    if (score > bestScore || (score === bestScore && best !== null && guiWindowArea(candidate.rect) > guiWindowArea(best.rect))) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

/**
 * Chrome may create the requested window in a different browser PID than the
 * launcher stub. Eligibility therefore depends on the new HWND baseline, not
 * on the spawned process PID.
 */
export function isChromeNewWindowCandidate(
  candidate: GuiWindowCandidate,
  query: GuiWindowQuery
): boolean {
  if (candidate.className !== CHROME_WINDOW_CLASS) return false
  // Chrome briefly creates hidden Chrome_WidgetWin_1 transition windows while
  // opening a profile. Only a visible browser window is safe to style.
  if (!candidate.visible) return false
  if ((query.baselineHwnds ?? []).includes(candidate.hwnd)) return false
  if (candidate.processPath && !processImagePathMatches(candidate.processPath, query.exePath)) return false
  if (!isUsableGuiWindow(candidate)) return false
  if (candidate.owner !== 0 && candidate.owner !== query.ownerHwnd) return false
  if (query.windowClass && candidate.className !== query.windowClass) return false
  const wantedTitle = query.windowTitle?.trim().toLowerCase()
  if (wantedTitle && !candidate.title.trim().toLowerCase().includes(wantedTitle)) return false
  return true
}

function scoreChromeNewWindow(candidate: GuiWindowCandidate): number {
  let score = 40
  if (candidate.visible) score += 30
  if (candidate.owner === 0) score += 10
  score += Math.min(20, Math.round(guiWindowArea(candidate.rect) / 100_000))
  return score
}

/** Select the newest visible Chrome window that was absent before spawn. */
export function selectChromeNewestWindow(
  candidates: readonly GuiWindowCandidate[],
  query: GuiWindowQuery
): GuiWindowCandidate | null {
  let best: GuiWindowCandidate | null = null
  let bestSeenAt = -1
  let bestScore = -1
  for (const candidate of candidates) {
    if (!isChromeNewWindowCandidate(candidate, query)) continue
    const seenAt = candidate.firstSeenAt ?? 0
    const score = scoreChromeNewWindow(candidate)
    // Creation age dominates (baseline already excludes pre-existing windows),
    // then scoring, then higher HWND as a deterministic fallback.
    if (
      seenAt > bestSeenAt ||
      (seenAt === bestSeenAt && score > bestScore) ||
      (seenAt === bestSeenAt && score === bestScore && best !== null && candidate.hwnd > best.hwnd)
    ) {
      best = candidate
      bestSeenAt = seenAt
      bestScore = score
    }
  }
  return best
}

/**
 * Codex creates additional top-level Chromium/tool windows during work. These
 * must be owned and kept hidden so they cannot surface as separate windows.
 */
export function isCodexSatelliteWindow(candidate: GuiWindowCandidate, mainPid: number): boolean {
  if (candidate.pid !== mainPid) return false
  if (IGNORED_HELPER_TITLES.has(candidate.title.trim())) return false
  if (candidate.className.startsWith('Chrome_WidgetWin_')) return true
  return (candidate.exStyle & WS_EX_TOOLWINDOW) !== 0
}

/** All secondary top-level windows belonging to the Codex process. */
export function selectCodexSatelliteWindows(
  main: GuiWindowCandidate,
  candidates: readonly GuiWindowCandidate[]
): GuiWindowCandidate[] {
  return candidates.filter((candidate) => candidate.hwnd !== main.hwnd && isCodexSatelliteWindow(candidate, main.pid))
}

/**
 * Dispatch to the policy-specific chooser. Keeping the switch beside the pure
 * selectors means new application policies do not need to edit the window
 * lifecycle code.
 */
export function selectGuiPolicyWindow(
  candidates: readonly GuiWindowCandidate[],
  query: GuiWindowQuery,
  policy: GuiWindowPolicy
): GuiWindowCandidate | null {
  switch (policy) {
    case 'wechat-main':
      return selectWeChatMainWindow(candidates, query)
    case 'chrome-newest':
      return selectChromeNewestWindow(candidates, query)
    case 'electron-main':
      return selectElectronMainWindow(candidates, query)
    case 'vscode-main':
      return selectVSCodeMainWindow(candidates, query)
    case 'zotero-main':
      return selectZoteroMainWindow(candidates, query)
    case 'codex-multi':
    case 'default':
      return selectGuiWindow(candidates, query)
  }
  return selectGuiWindow(candidates, query)
}

/** True when one app process owns multiple top-level windows shared by the user. */
export function guiPolicyUsesSharedProcess(policy: GuiWindowPolicy): boolean {
  return policy === 'chrome-newest' || policy === 'vscode-main'
}

/**
 * Stop behavior per policy. Shared-process apps never get taskkill; Chrome
 * closes only its selected window, while the five desktop editors detach and
 * restore their normal frame so the user can keep using them externally.
 */
export function guiPolicyStopMode(policy: GuiWindowPolicy): 'tree' | 'window' | 'detach' {
  if (policy === 'chrome-newest') return 'window'
  if (policy === 'vscode-main' || policy === 'electron-main' || policy === 'zotero-main') return 'detach'
  return 'tree'
}

/** True when attach must wait for a window created after the pre-spawn baseline. */
export function guiPolicyRequiresNewWindow(policy: GuiWindowPolicy): boolean {
  return guiPolicyUsesSharedProcess(policy)
}

/**
 * The P2 client-inset/region fix compensates for GTK/XUL windows that retain a
 * DWM non-client band. DPI-unaware Electron apps (Typora 1.0.x) report client
 * metrics in logical units, so applying the same expansion leaves a large black
 * band; those policies use raw SetWindowPos placement instead.
 */
export function guiPolicyUsesClientInsetFix(policy: GuiWindowPolicy): boolean {
  return policy !== 'electron-main' && policy !== 'zotero-main'
}

/** Stable title/rect/class signature used by the two-second startup quiet period. */
export function guiWindowSignature(candidate: Pick<GuiWindowCandidate, 'title' | 'className' | 'rect'>): string {
  return [
    candidate.title,
    candidate.className,
    candidate.rect.left,
    candidate.rect.top,
    candidate.rect.right,
    candidate.rect.bottom
  ].join('|')
}

/** Return the retry delay for a zero-based retry index, or null after five retries. */
export function guiStyleRetryDelay(attempt: number): number | null {
  return Number.isInteger(attempt) && attempt >= 0 && attempt < GUI_STYLE_RETRY_DELAYS_MS.length
    ? GUI_STYLE_RETRY_DELAYS_MS[attempt]
    : null
}

/**
 * Pick the best candidate deterministically. Ties prefer the lower HWND so
 * repeated polls cannot flip between two equally plausible windows.
 */
export function selectGuiWindow(
  candidates: readonly GuiWindowCandidate[],
  query: GuiWindowQuery
): GuiWindowCandidate | null {
  let best: GuiWindowCandidate | null = null
  let bestScore = -1
  for (const candidate of candidates) {
    const score = scoreGuiWindow(candidate, query)
    if (score < 0) continue
    if (score > bestScore || (score === bestScore && best !== null && candidate.hwnd < best.hwnd)) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

/** Style changes needed to turn a normal top-level app window into an owned tool window. */
export interface GuiEmbedStyle {
  style: number
  exStyle: number
  changed: boolean
}

/** Compute (do not apply) the caption-less, taskbar-less owner-child style. */
export function computeGuiEmbedStyle(style: number, exStyle: number): GuiEmbedStyle {
  const nextStyle = (style & ~EMBEDDED_STYLE_MASK) >>> 0
  const nextExStyle = ((exStyle | WS_EX_TOOLWINDOW) & ~EMBEDDED_EXSTYLE_REMOVE) >>> 0
  return { style: nextStyle, exStyle: nextExStyle, changed: nextStyle !== (style >>> 0) || nextExStyle !== (exStyle >>> 0) }
}

/** True when the window still has every embedding attribute we depend on. */
export function isGuiEmbedStyleIntact(
  style: number,
  exStyle: number,
  owner: number,
  expectedOwner: number
): boolean {
  if (owner !== expectedOwner) return false
  if ((style & WS_CAPTION) !== 0 || (style & WS_THICKFRAME) !== 0) return false
  if ((exStyle & WS_EX_TOOLWINDOW) === 0 || (exStyle & WS_EX_APPWINDOW) !== 0) return false
  if ((exStyle & WS_EX_WINDOWEDGE) !== 0) return false
  return true
}

/**
 * Degraded mode keeps the app's normal frame/title bar but still makes it an
 * owned tool window so it does not create a second taskbar entry.
 */
export function computeGuiDegradedStyle(style: number, exStyle: number): GuiEmbedStyle {
  const nextStyle = style >>> 0
  const nextExStyle = ((exStyle | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW) >>> 0
  return {
    style: nextStyle,
    exStyle: nextExStyle,
    changed: nextStyle !== (style >>> 0) || nextExStyle !== (exStyle >>> 0)
  }
}

/** Make a secondary window taskbar-invisible without stripping its frame. */
export function computeGuiTaskbarHygieneStyle(style: number, exStyle: number): GuiEmbedStyle {
  const nextStyle = style >>> 0
  const nextExStyle = ((exStyle | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW) >>> 0
  return { style: nextStyle, exStyle: nextExStyle, changed: nextStyle !== (style >>> 0) || nextExStyle !== (exStyle >>> 0) }
}

/** True when a secondary window cannot add its own taskbar entry. */
export function isGuiTaskbarHygieneIntact(exStyle: number): boolean {
  return (exStyle & WS_EX_TOOLWINDOW) !== 0 && (exStyle & WS_EX_APPWINDOW) === 0
}

/** Qt's tooltip/save-bits helpers are render internals; hiding them can stall WeChat. */
export function isWeChatRenderHelperWindow(candidate: Pick<GuiWindowCandidate, 'className' | 'title'>): boolean {
  const className = candidate.className.trim()
  if (/ToolTip|SaveBits|ToolSaveBits|QWindowPopup/i.test(className)) return true
  return /ToolTip|SaveBits/i.test(candidate.title)
}

/** All other visible top-level windows belonging to a WeChat main-window process. */
export function selectWeChatTaskbarHygieneWindows(
  main: GuiWindowCandidate,
  candidates: readonly GuiWindowCandidate[]
): GuiWindowCandidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.hwnd !== main.hwnd &&
      candidate.pid === main.pid &&
      candidate.visible &&
      !isWeChatRenderHelperWindow(candidate)
  )
}

/** True when degraded mode still has owner/tool-window semantics. */
export function isGuiDegradedStyleIntact(
  exStyle: number,
  owner: number,
  expectedOwner: number
): boolean {
  return owner === expectedOwner && (exStyle & WS_EX_TOOLWINDOW) !== 0 && (exStyle & WS_EX_APPWINDOW) === 0
}

/**
 * Content rectangle right of the sidebar and below optional future chrome
 * (the S2 top bar can pass its height as `insets.top` without changing this API).
 */
export interface GuiContentInsets {
  top: number
  right: number
  bottom: number
}

/** Clamp/round the content rectangle to integer DIPs; never returns negative sizes. */
export function computeGuiContentBox(
  contentBounds: GuiRect,
  sidebarWidth: number,
  insets?: Partial<GuiContentInsets>
): GuiRect {
  const sidebar = Math.max(0, Math.round(sidebarWidth))
  const top = Math.max(0, Math.round(insets?.top ?? 0))
  const right = Math.max(0, Math.round(insets?.right ?? 0))
  const bottom = Math.max(0, Math.round(insets?.bottom ?? 0))
  return {
    x: Math.round(contentBounds.x + sidebar),
    y: Math.round(contentBounds.y + top),
    width: Math.max(0, Math.round(contentBounds.width) - sidebar - right),
    height: Math.max(0, Math.round(contentBounds.height) - top - bottom)
  }
}

/**
 * GUI children must not inherit `ELECTRON_RUN_AS_NODE=1` from the launcher's
 * shell (it would make an Electron target boot as Node and never create a
 * window). Keys are compared case-insensitively because Windows env names are.
 */
export function guiChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(next)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete next[key]
  }
  return next
}
