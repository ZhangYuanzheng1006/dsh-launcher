// Win32 bridge for GUI-instance windows. Kept behind a thin, typed surface so
// the lifecycle/layout logic can stay testable without loading koffi.

import koffi from 'koffi'
import {
  clientRegionRect,
  outerRectForClient,
  sameGuiPixelRect,
  type GuiClientInsets,
  type GuiPixelRect
} from './gui-content-box'
import { normalizeWindowsPath, processImagePathMatches, type GuiWindowCandidate, type GuiWindowRect } from './gui-window-pure'

const GWL_STYLE = -16
const GWL_EXSTYLE = -20
const GWLP_HWNDPARENT = -8
const GW_OWNER = 4
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const TH32CS_SNAPPROCESS = 0x00000002
const SW_HIDE = 0
const SW_SHOWNOACTIVATE = 4
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010
const SWP_FRAMECHANGED = 0x0020
const SWP_NOOWNERZORDER = 0x0200
const SWP_ASYNCWINDOWPOS = 0x4000
const WM_CLOSE = 0x0010

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
const gdi32 = koffi.load('gdi32.dll')

const HANDLE = koffi.pointer('HANDLE', koffi.opaque())
const RECT = koffi.struct('RECT', {
  left: 'int32',
  top: 'int32',
  right: 'int32',
  bottom: 'int32'
})
const POINT = koffi.struct('POINT', {
  x: 'int32',
  y: 'int32'
})
const PROCESSENTRY32W = koffi.struct('PROCESSENTRY32W', {
  dwSize: 'uint32',
  cntUsage: 'uint32',
  th32ProcessID: 'uint32',
  th32DefaultHeapID: 'uintptr_t',
  th32ModuleID: 'uint32',
  cntThreads: 'uint32',
  th32ParentProcessID: 'uint32',
  pcPriClassBase: 'int32',
  dwFlags: 'uint32',
  szExeFile: koffi.array('char16_t', 260)
})
const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(HANDLE hwnd, intptr_t lParam)')

const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'bool', [koffi.pointer(EnumWindowsProc), 'intptr_t'])
const GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32_t', ['void *', koffi.out(koffi.pointer('uint32_t'))])
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *h, _Out_ uint16_t *buf, int n)')
const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *h, _Out_ uint16_t *buf, int n)')
const IsWindow = user32.func('bool __stdcall IsWindow(void *h)')
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *h)')
const IsIconic = user32.func('bool __stdcall IsIconic(void *h)')
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *h, _Out_ RECT *rect)')
const GetClientRect = user32.func('bool __stdcall GetClientRect(void *h, _Out_ RECT *rect)')
const ClientToScreen = user32.func('bool __stdcall ClientToScreen(void *h, _Inout_ POINT *point)')
const GetWindowRgnBox = user32.func('int __stdcall GetWindowRgnBox(void *h, _Out_ RECT *rect)')
const SetWindowRgn = user32.func('int __stdcall SetWindowRgn(void *h, void *region, bool redraw)')
const GetWindow = user32.func('void * __stdcall GetWindow(void *h, uint32_t cmd)')
const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(void *h, int index)')
const SetWindowLongPtrW = user32.func('intptr_t __stdcall SetWindowLongPtrW(void *h, int index, intptr_t value)')
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(void *h, void *after, int x, int y, int cx, int cy, uint32_t flags)')
const ShowWindowAsync = user32.func('bool __stdcall ShowWindowAsync(void *h, int cmd)')
const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()')
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void *h)')
const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, bool attach)')
const PostMessageW = user32.func('bool __stdcall PostMessageW(void *h, uint32_t msg, uintptr_t wParam, intptr_t lParam)')

const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)')
const CreateToolhelp32Snapshot = kernel32.func('void * __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)')
const Process32FirstW = kernel32.func('bool __stdcall Process32FirstW(void *snapshot, _Inout_ PROCESSENTRY32W *entry)')
const Process32NextW = kernel32.func('bool __stdcall Process32NextW(void *snapshot, _Inout_ PROCESSENTRY32W *entry)')
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)')
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)')
const GetCurrentThreadId = kernel32.func('uint32_t __stdcall GetCurrentThreadId()')
const CreateRectRgn = gdi32.func('void * __stdcall CreateRectRgn(int l, int t, int r, int b)')
const DeleteObject = gdi32.func('bool __stdcall DeleteObject(void *object)')
const SetLastError = kernel32.func('void __stdcall SetLastError(uint32_t err)')
const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()')

/** Convert a Koffi pointer return (bigint/null) into a plain HWND number. */
function handleNumber(value: bigint | number | null): number {
  if (value === null) return 0
  return typeof value === 'bigint' ? Number(value) : value
}

/** Decode a UTF-16LE window title/class buffer into a JS string. */
function decodeUtf16(buf: Uint16Array, length: number): string {
  return length > 0 ? koffi.decode(buf, 'char16_t', length) : ''
}

function getText(hwnd: number): string {
  const buf = new Uint16Array(512)
  const length = GetWindowTextW(BigInt(hwnd), buf, buf.length)
  return decodeUtf16(buf, length)
}

function getClassName(hwnd: number): string {
  const buf = new Uint16Array(256)
  const length = GetClassNameW(BigInt(hwnd), buf, buf.length)
  return decodeUtf16(buf, length)
}

function getWindowPid(hwnd: number): number {
  const pid = [0]
  GetWindowThreadProcessId(BigInt(hwnd), pid)
  return pid[0]
}

function getRect(hwnd: number): GuiWindowRect {
  const rect = { left: 0, top: 0, right: 0, bottom: 0 }
  if (!GetWindowRect(BigInt(hwnd), rect)) return rect
  return rect
}

/** True when a window handle still points at a live window. */
export function isWindow(hwnd: number): boolean {
  return hwnd > 0 && Boolean(IsWindow(BigInt(hwnd)))
}

/** Resolve the full executable path of a process with limited query rights. */
export function getProcessPath(pid: number): string {
  if (!Number.isFinite(pid) || pid <= 0) return ''
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!handle) return ''
  try {
    const buf = new Uint16Array(32_768)
    const size = [buf.length]
    const ok = QueryFullProcessImageNameW(handle, 0, buf, size)
    return ok ? decodeUtf16(buf, size[0]) : ''
  } finally {
    CloseHandle(handle)
  }
}

/** Resolve every live PID whose full image path equals the requested executable. */
export function findProcessIdsByImagePath(imagePath: string): number[] {
  const expected = imagePath.trim()
  if (process.platform !== 'win32' || !expected) return []
  // Hot handoff path: apps normally expose one visible top-level window, so
  // checking those PIDs first avoids querying every chrome.exe helper process.
  const visiblePids = [...new Set(
    enumerateTopLevelWindows()
      .filter((candidate) => candidate.visible && candidate.title.trim())
      .map((candidate) => candidate.pid)
  )]
  if (visiblePids.length > 0) {
    const visibleMatches = visiblePids.filter((pid) => {
      const actual = getProcessPath(pid)
      return actual && processImagePathMatches(actual, expected)
    })
    if (visibleMatches.length > 0) return visibleMatches.sort((a, b) => a - b)
  }
  const expectedBase = expected.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  const snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
  if (!snapshot || handleNumber(snapshot) === -1) return []
  const pids: number[] = []
  try {
    const entry = {
      dwSize: koffi.sizeof(PROCESSENTRY32W),
      cntUsage: 0,
      th32ProcessID: 0,
      th32DefaultHeapID: 0,
      th32ModuleID: 0,
      cntThreads: 0,
      th32ParentProcessID: 0,
      pcPriClassBase: 0,
      dwFlags: 0,
      szExeFile: new Array(260).fill(0)
    }
    let ok = Process32FirstW(snapshot, entry)
    while (ok) {
      const pid = entry.th32ProcessID
      const exeName = String(entry.szExeFile).toLowerCase()
      if (pid > 0 && exeName === expectedBase) {
        const actual = getProcessPath(pid)
        if (actual && processImagePathMatches(actual, expected)) pids.push(pid)
      }
      ok = Process32NextW(snapshot, entry)
    }
  } finally {
    CloseHandle(snapshot)
  }
  return [...new Set(pids)].sort((a, b) => a - b)
}

function readCandidate(hwnd: number, pid = getWindowPid(hwnd)): GuiWindowCandidate {
  return {
    hwnd,
    pid,
    title: getText(hwnd),
    className: getClassName(hwnd),
    visible: Boolean(IsWindowVisible(BigInt(hwnd))),
    iconic: Boolean(IsIconic(BigInt(hwnd))),
    owner: handleNumber(GetWindow(BigInt(hwnd), GW_OWNER)),
    style: handleNumber(GetWindowLongPtrW(BigInt(hwnd), GWL_STYLE)) >>> 0,
    exStyle: handleNumber(GetWindowLongPtrW(BigInt(hwnd), GWL_EXSTYLE)) >>> 0,
    rect: getRect(hwnd)
  }
}

/** Enumerate every top-level window once, with the cheap facts needed to score it. */
export function enumerateTopLevelWindows(): GuiWindowCandidate[] {
  const windows: GuiWindowCandidate[] = []
  const callback = (rawHwnd: bigint): boolean => {
    const hwnd = Number(rawHwnd)
    if (!hwnd) return true
    const pid = getWindowPid(hwnd)
    if (!pid) return true
    windows.push(readCandidate(hwnd, pid))
    return true
  }
  EnumWindows(callback, 0)
  return windows
}

/**
 * Enumerate only windows owned by the supplied PIDs. This is the hot path for
 * style/satellite polling: unrelated windows are skipped before title/class/
 * rect queries, keeping one native batch well below a frame budget.
 */
export function enumerateTopLevelWindowsByPids(pids: readonly number[]): GuiWindowCandidate[] {
  const wanted = new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))
  if (wanted.size === 0) return []
  const windows: GuiWindowCandidate[] = []
  const callback = (rawHwnd: bigint): boolean => {
    const hwnd = Number(rawHwnd)
    if (!hwnd) return true
    const pid = getWindowPid(hwnd)
    if (!wanted.has(pid)) return true
    windows.push(readCandidate(hwnd, pid))
    return true
  }
  EnumWindows(callback, 0)
  return windows
}

/** Read the current facts for exactly one HWND (used by the startup stability loop). */
export function getWindowCandidate(hwnd: number): GuiWindowCandidate | null {
  if (!isWindow(hwnd)) return null
  return readCandidate(hwnd)
}

/** HWND-only snapshot used by Chrome's pre-spawn baseline. */
export function enumerateTopLevelWindowHandles(): number[] {
  const handles: number[] = []
  const callback = (rawHwnd: bigint): boolean => {
    const hwnd = Number(rawHwnd)
    if (hwnd) handles.push(hwnd)
    return true
  }
  EnumWindows(callback, 0)
  return handles
}

/** Current style, extended style, and owner of one window. */
export function getWindowEmbedState(hwnd: number): { style: number; exStyle: number; owner: number } {
  return {
    style: handleNumber(GetWindowLongPtrW(BigInt(hwnd), GWL_STYLE)) >>> 0,
    exStyle: handleNumber(GetWindowLongPtrW(BigInt(hwnd), GWL_EXSTYLE)) >>> 0,
    owner: handleNumber(GetWindowLongPtrW(BigInt(hwnd), GWLP_HWNDPARENT))
  }
}

function throwLastError(operation: string): never {
  const code = GetLastError()
  throw new Error(`${operation} failed (Win32 error ${code})`)
}

function setWindowLongPtr(hwnd: number, index: number, value: number): void {
  SetLastError(0)
  SetWindowLongPtrW(BigInt(hwnd), index, value)
  const code = GetLastError()
  if (code !== 0) throw new Error(`SetWindowLongPtr(${index}) failed (Win32 error ${code})`)
}

function setWindowOwner(hwnd: number, owner: number): void {
  SetLastError(0)
  SetWindowLongPtrW(BigInt(hwnd), GWLP_HWNDPARENT, owner)
  // SetWindowLongPtr(GWLP_HWNDPARENT, 0) succeeds but leaves a stale 1400
  // in GetLastError on some Windows builds. Verify the stored owner instead.
  const actual = handleNumber(GetWindowLongPtrW(BigInt(hwnd), GWLP_HWNDPARENT))
  if (actual !== owner) {
    const code = GetLastError()
    throw new Error(`SetWindowLongPtr(GWLP_HWNDPARENT) failed (Win32 error ${code}, expected ${owner}, got ${actual})`)
  }
}

/** Apply owner + caption-less tool-window styles and force a non-client refresh. */
export function applyWindowEmbedding(hwnd: number, ownerHwnd: number, style: number, exStyle: number): void {
  setWindowLongPtr(hwnd, GWL_STYLE, style)
  setWindowLongPtr(hwnd, GWL_EXSTYLE, exStyle)
  setWindowOwner(hwnd, ownerHwnd)
  const flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_FRAMECHANGED | SWP_ASYNCWINDOWPOS
  if (!SetWindowPos(BigInt(hwnd), null, 0, 0, 0, 0, flags)) throwLastError('SetWindowPos(frame)')
}

/** Measured client rectangle and the non-client pixels around it. */
interface GuiClientMetrics {
  width: number
  height: number
  insets: GuiClientInsets
}

function windowClientMetrics(hwnd: number): GuiClientMetrics {
  const window = getRect(hwnd)
  const client = { left: 0, top: 0, right: 0, bottom: 0 }
  if (!GetClientRect(BigInt(hwnd), client)) throwLastError('GetClientRect')
  const origin = { x: 0, y: 0 }
  if (!ClientToScreen(BigInt(hwnd), origin)) throwLastError('ClientToScreen')
  return {
    width: Math.max(0, client.right - client.left),
    height: Math.max(0, client.bottom - client.top),
    insets: {
      left: origin.x - window.left,
      top: origin.y - window.top,
      right: window.right - (origin.x + client.right),
      bottom: window.bottom - (origin.y + client.bottom)
    }
  }
}

function windowRegionBox(hwnd: number): GuiPixelRect | null {
  const rect = { left: 0, top: 0, right: 0, bottom: 0 }
  if (GetWindowRgnBox(BigInt(hwnd), rect) === 0) return null
  return {
    x: rect.left,
    y: rect.top,
    width: Math.max(0, rect.right - rect.left),
    height: Math.max(0, rect.bottom - rect.top)
  }
}

/**
 * Clip a window to its client rectangle, removing the DWM non-client band that
 * remains visible when a top-level app has no caption or resize frame.
 */
export function ensureWindowClientRegion(hwnd: number): boolean {
  const metrics = windowClientMetrics(hwnd)
  const expected = clientRegionRect(metrics.insets, metrics.width, metrics.height)
  const current = windowRegionBox(hwnd)
  if (current && sameGuiPixelRect(current, expected)) return false
  const region = CreateRectRgn(
    Math.round(expected.x),
    Math.round(expected.y),
    Math.round(expected.x + expected.width),
    Math.round(expected.y + expected.height)
  )
  if (!region) throwLastError('CreateRectRgn')
  if (SetWindowRgn(BigInt(hwnd), region, true) === 0) {
    DeleteObject(region)
    throwLastError('SetWindowRgn(clip)')
  }
  return true
}

/** Convert a desired client/content box into the matching outer window rect. */
export function windowRectForContent(hwnd: number, rect: GuiPixelRect): GuiPixelRect {
  return outerRectForClient(rect, windowClientMetrics(hwnd).insets)
}

/**
 * Position an embedded window so its client rectangle fills the requested
 * content box. Actual client metrics are used instead of AdjustWindowRectEx:
 * after caption/taskbar styles are removed, that API reports no frame even
 * while DWM still reserves a small non-client band.
 */
export function positionWindow(hwnd: number, rect: GuiPixelRect): void {
  const outer = windowRectForContent(hwnd, rect)
  const flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS
  if (!SetWindowPos(BigInt(hwnd), null, outer.x, outer.y, outer.width, outer.height, flags)) {
    throwLastError('SetWindowPos(position)')
  }
  ensureWindowClientRegion(hwnd)
}

/** Position a window directly in physical pixels without client-inset expansion or region clipping. */
export function positionWindowRaw(hwnd: number, rect: GuiPixelRect): void {
  const flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS
  if (!SetWindowPos(BigInt(hwnd), null, Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height), flags)) {
    throwLastError('SetWindowPos(position-raw)')
  }
  try {
    clearWindowRegion(hwnd)
  } catch {
    // A window without a region may reject the clear; raw placement still holds.
  }
}

/** Remove any embedding clip so the normal window can be shown intact. */
export function clearWindowRegion(hwnd: number): void {
  if (SetWindowRgn(BigInt(hwnd), null, true) === 0) throwLastError('SetWindowRgn(clear)')
}

/** Hide/show asynchronously so a slow app repaint cannot block the launcher thread. */
export function showWindow(hwnd: number, visible: boolean): void {
  ShowWindowAsync(BigInt(hwnd), visible ? SW_SHOWNOACTIVATE : SW_HIDE)
}

/** Bring an embedded window foreground after an explicit user action. */
export function focusWindow(hwnd: number): void {
  SetForegroundWindow(BigInt(hwnd))
}

/** Current foreground HWND, or zero when none exists. */
export function getForegroundWindow(): number {
  return handleNumber(GetForegroundWindow())
}

/**
 * Restore the window that was foreground before a GUI launch. Background
 * launches can make Windows activate the launcher while the spawned app's
 * transient window is hidden; attach the input queues when needed so the
 * user's original window can regain focus.
 */
export function restoreForegroundWindow(hwnd: number): boolean {
  if (!isWindow(hwnd)) return false
  if (getForegroundWindow() === hwnd) return true
  const foreground = GetForegroundWindow()
  const foregroundThread = foreground ? GetWindowThreadProcessId(foreground, [0]) : 0
  const currentThread = GetCurrentThreadId()
  let attached = false
  if (foregroundThread && foregroundThread !== currentThread) {
    attached = Boolean(AttachThreadInput(currentThread, foregroundThread, true))
  }
  try {
    SetForegroundWindow(BigInt(hwnd))
    return getForegroundWindow() === hwnd
  } finally {
    if (attached) AttachThreadInput(currentThread, foregroundThread, false)
  }
}

/** Ask one window to close without killing its (possibly shared) process. */
export function closeWindow(hwnd: number): boolean {
  return hwnd > 0 && Boolean(PostMessageW(BigInt(hwnd), WM_CLOSE, 0, 0))
}

/** Re-export the path normalizer so callers keep one comparison rule. */
export { normalizeWindowsPath }
