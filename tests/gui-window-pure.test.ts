import { describe, expect, it } from 'vitest'
import {
  WS_BORDER,
  WS_CAPTION,
  WS_DLGFRAME,
  WS_EX_APPWINDOW,
  WS_EX_CLIENTEDGE,
  WS_EX_STATICEDGE,
  WS_EX_TOOLWINDOW,
  WS_EX_WINDOWEDGE,
  WS_THICKFRAME,
  WS_MINIMIZEBOX,
  WS_MAXIMIZEBOX,
  WS_SYSMENU,
  classifyGuiNativeDuration,
  computeGuiContentBox,
  computeGuiDegradedStyle,
  computeGuiEmbedStyle,
  computeGuiTaskbarHygieneStyle,
  guiWindowStyleRestored,
  hasGuiWindowFrame,
  repairGuiWindowStyleSnapshot,
  repairWeChatWindowStyleSnapshot,
  guiChildEnv,
  guiStyleRetryDelay,
  guiWindowSignature,
  isEligibleMainWindow,
  isGuiDegradedStyleIntact,
  isGuiEmbedStyleIntact,
  isGuiTaskbarHygieneIntact,
  isWeChatRenderHelperWindow,
  normalizeWindowsPath,
  processImagePathMatches,
  snapshotGuiWindowStyle,
  resolveGuiWindowPolicy,
  isVSCodeAuxiliaryWindow,
  guiPolicyRequiresNewWindow,
  guiPolicyStopMode,
  guiPolicyUsesClientInsetFix,
  selectChromeNewestWindow,
  selectElectronMainWindow,
  selectGuiPolicyWindow,
  selectVSCodeMainWindow,
  selectWeChatTaskbarHygieneWindows,
  selectCodexSatelliteWindows,
  selectGuiWindow,
  selectWeChatMainWindow,
  selectZoteroMainWindow,
  type GuiWindowCandidate
} from '../src/main/gui-window-pure'

function candidate(overrides: Partial<GuiWindowCandidate> = {}): GuiWindowCandidate {
  return {
    hwnd: 100,
    pid: 1000,
    title: 'Antigravity',
    className: 'Chrome_WidgetWin_1',
    visible: true,
    iconic: false,
    owner: 0,
    style: 0x34c70000,
    exStyle: 0x00240100,
    rect: { left: 0, top: 0, right: 1280, bottom: 800 },
    ...overrides
  }
}

describe('computeGuiEmbedStyle', () => {
  it('removes caption/frame styles and opts the window out of the taskbar', () => {
    const original = candidate()
    const next = computeGuiEmbedStyle(original.style, original.exStyle)

    expect(next.changed).toBe(true)
    expect(next.style & WS_CAPTION).toBe(0)
    expect(next.style & WS_THICKFRAME).toBe(0)
    expect(next.exStyle & WS_EX_TOOLWINDOW).not.toBe(0)
    expect(next.exStyle & WS_EX_APPWINDOW).toBe(0)
    expect(next.exStyle & WS_EX_WINDOWEDGE).toBe(0)
    const edged = computeGuiEmbedStyle(WS_BORDER | WS_DLGFRAME | WS_THICKFRAME, WS_EX_CLIENTEDGE | WS_EX_STATICEDGE)
    expect(edged.style & (WS_BORDER | WS_DLGFRAME | WS_THICKFRAME)).toBe(0)
    expect(edged.exStyle & (WS_EX_CLIENTEDGE | WS_EX_STATICEDGE)).toBe(0)
    expect(isGuiEmbedStyleIntact(next.style, next.exStyle, 77, 77)).toBe(true)
  })

  it('is idempotent and reports no change for an already embedded window', () => {
    const once = computeGuiEmbedStyle(0x34c70000, 0x00240100)
    const twice = computeGuiEmbedStyle(once.style, once.exStyle)
    expect(twice.changed).toBe(false)
    expect(twice.style).toBe(once.style)
    expect(twice.exStyle).toBe(once.exStyle)
  })

  it('requires the launcher owner as well as the visual styles', () => {
    const next = computeGuiEmbedStyle(0x34c70000, 0x00240100)
    expect(isGuiEmbedStyleIntact(next.style, next.exStyle, 0, 77)).toBe(false)
    expect(isGuiEmbedStyleIntact(next.style | WS_CAPTION, next.exStyle, 77, 77)).toBe(false)
  })
})

describe('computeGuiContentBox', () => {
  it('places the embedded window immediately right of the sidebar', () => {
    expect(computeGuiContentBox({ x: 10, y: 20, width: 1000, height: 700 }, 260)).toEqual({
      x: 270,
      y: 20,
      width: 740,
      height: 700
    })
  })

  it('supports future top-bar insets without changing the caller', () => {
    expect(computeGuiContentBox({ x: 0, y: 0, width: 1200, height: 800 }, 56, { top: 42, right: 8, bottom: 4 })).toEqual({
      x: 56,
      y: 42,
      width: 1136,
      height: 754
    })
  })

  it('clamps impossible sizes to zero instead of negative bounds', () => {
    expect(computeGuiContentBox({ x: 0, y: 0, width: 100, height: 50 }, 200, { top: 60 })).toEqual({
      x: 200,
      y: 60,
      width: 0,
      height: 0
    })
  })
})

describe('selectGuiWindow', () => {
  it('accepts a hidden but titled app main window (Codex cold-start behaviour)', () => {
    const hiddenMain = candidate({ hwnd: 11, title: 'ChatGPT', visible: false })
    expect(selectGuiWindow([hiddenMain], { rootPid: 1000, exePath: 'C:\\Apps\\ChatGPT.exe' })).toBe(hiddenMain)
  })

  it('rejects untitled helper/IME windows', () => {
    const helper = candidate({ hwnd: 12, title: '', visible: false })
    const ime = candidate({ hwnd: 13, title: 'Default IME', visible: true })
    expect(selectGuiWindow([helper, ime], { rootPid: 1000, exePath: 'C:\\Apps\\App.exe' })).toBeNull()
  })

  it('prefers the root PID over a same-exe fallback window', () => {
    const root = candidate({ hwnd: 20, pid: 1000, title: 'App' })
    const fallback = candidate({ hwnd: 21, pid: 2000, title: 'App', processPath: 'C:\\Apps\\App.exe' })
    expect(selectGuiWindow([fallback, root], { rootPid: 1000, exePath: 'C:\\Apps\\App.exe' })).toBe(root)
  })

  it('can adopt a same-executable window after a launcher stub hands off', () => {
    const handedOff = candidate({
      hwnd: 31,
      pid: 3000,
      title: 'Codex',
      processPath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe'
    })
    const picked = selectGuiWindow([handedOff], {
      rootPid: 999,
      exePath: 'C:/Program Files/WindowsApps/OpenAI.Codex/app/ChatGPT.exe'
    })
    expect(picked).toBe(handedOff)
  })

  it('honours an optional title filter and prefers an exact title match', () => {
    const other = candidate({ hwnd: 40, title: 'App - Settings' })
    const exact = candidate({ hwnd: 41, title: 'App' })
    expect(selectGuiWindow([other, exact], { rootPid: 1000, exePath: 'C:\\App.exe', windowTitle: 'App' })).toBe(exact)
    expect(selectGuiWindow([other], { rootPid: 1000, exePath: 'C:\\App.exe', windowTitle: 'Nomatch' })).toBeNull()
  })

  it('breaks equal-score ties deterministically by HWND', () => {
    const high = candidate({ hwnd: 50, title: 'Same' })
    const low = candidate({ hwnd: 49, title: 'Same' })
    expect(selectGuiWindow([high, low], { rootPid: 1000, exePath: 'C:\\App.exe' })).toBe(low)
  })
})

describe('guiChildEnv', () => {
  it('strips ELECTRON_RUN_AS_NODE case-insensitively so Electron targets stay GUI', () => {
    expect(guiChildEnv({ ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1', KEEP: 'yes' })).toEqual({ KEEP: 'yes' })
  })

  it('does not mutate the input environment', () => {
    const input = { ELECTRON_RUN_AS_NODE: '1', PATH: 'C:\\Windows' }
    guiChildEnv(input)
    expect(input.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})

describe('normalizeWindowsPath', () => {
  it('compares Windows paths case-insensitively and slash-agnostically', () => {
    expect(normalizeWindowsPath('C:/Program Files/App/APP.EXE')).toBe('c:\\program files\\app\\app.exe')
  })
})


describe('main-window eligibility', () => {
  it('rejects tool windows and foreign-owned windows from main-window selection', () => {
    const tool = candidate({ hwnd: 60, exStyle: WS_EX_TOOLWINDOW })
    const owned = candidate({ hwnd: 61, owner: 999 })
    expect(selectGuiWindow([tool, owned], { rootPid: 1000, exePath: 'C:\\App.exe' })).toBeNull()
  })

  it('allows the launcher-owned window when re-resolving an already embedded instance', () => {
    const adopted = candidate({ hwnd: 62, owner: 77, exStyle: WS_EX_TOOLWINDOW })
    expect(isEligibleMainWindow(adopted, { rootPid: 1000, exePath: 'C:\\App.exe', ownerHwnd: 77 })).toBe(true)
  })

  it('allows an owner-less tool window left by an earlier launcher run', () => {
    const damaged = candidate({ hwnd: 63, owner: 0, exStyle: WS_EX_TOOLWINDOW })
    expect(isEligibleMainWindow(damaged, { rootPid: 1000, exePath: 'C:\\App.exe', ownerHwnd: 77 })).toBe(true)
  })

  it('honours an exact window-class filter', () => {
    const chrome = candidate({ hwnd: 63, className: 'Chrome_WidgetWin_1' })
    const electronHelper = candidate({ hwnd: 64, className: 'Chrome_WidgetWin_0', title: 'Helper' })
    expect(selectGuiWindow([electronHelper, chrome], {
      rootPid: 1000,
      exePath: 'C:\\App.exe',
      windowClass: 'Chrome_WidgetWin_1'
    })).toBe(chrome)
  })
})

describe('WeChat main-window policy', () => {
  it('selects only the main WeChat window and excludes tool/owned/chat windows', () => {
    const main = candidate({ hwnd: 70, className: 'Qt51514QWindowIcon', title: '微信' })
    const chat = candidate({ hwnd: 71, className: 'Qt51514QWindowIcon', title: '张三' })
    const tool = candidate({ hwnd: 72, className: 'Qt51514QWindowIcon', title: 'WeChat', exStyle: WS_EX_TOOLWINDOW })
    const owned = candidate({ hwnd: 73, className: 'Qt51514QWindowIcon', title: '微信', owner: 70 })
    const oldClassMain = candidate({ hwnd: 74, className: 'WeChatMainWndForPC', title: '微信' })
    expect(selectWeChatMainWindow([chat, tool, owned, main], {
      rootPid: 1000,
      exePath: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe'
    })).toBe(main)
    expect(selectWeChatMainWindow([oldClassMain], {
      rootPid: 1000,
      exePath: 'C:\\WeChat.exe'
    })).toBe(oldClassMain)
  })

  it('does not mistake a hidden tool-save window for the WeChat main window', () => {
    const main = candidate({ hwnd: 75, className: 'Qt51514QWindowIcon', title: '微信' })
    const toolSave = candidate({ hwnd: 76, className: 'Qt51514QWindowToolSaveBits', title: 'Weixin', visible: false })
    expect(selectWeChatMainWindow([toolSave, main], { rootPid: 1000, exePath: 'C:\\Weixin.exe' })).toBe(main)
  })

  it('can restore a minimized-to-tray WeChat main window without selecting helper windows', () => {
    const minimizedMain = candidate({ hwnd: 77, className: 'Qt51514QWindowIcon', title: '微信', iconic: true, rect: { left: -16000, top: -16000, right: -15843, bottom: -15975 } })
    const toolSave = candidate({ hwnd: 78, className: 'Qt51514QWindowToolSaveBits', title: 'Weixin', visible: false })
    expect(selectWeChatMainWindow([toolSave, minimizedMain], { rootPid: 1000, exePath: 'C:\\Weixin.exe' })).toBe(minimizedMain)
    expect(selectGuiWindow([minimizedMain], { rootPid: 1000, exePath: 'C:\\Weixin.exe' })).toBeNull()
  })
})

describe('Chrome newest-window policy', () => {
  it('selects the newly observed Chrome_WidgetWin_1 window, not existing Chrome windows', () => {
    const existing = [
      candidate({ hwnd: 80, title: 'Existing tab', firstSeenAt: 100 }),
      candidate({ hwnd: 81, title: 'Existing tab 2', firstSeenAt: 100 })
    ]
    const newOlder = candidate({ hwnd: 82, title: 'New tab', firstSeenAt: 500 })
    const newLatest = candidate({ hwnd: 83, title: 'New tab 2', firstSeenAt: 900 })
    const otherClass = candidate({ hwnd: 84, title: 'Helper', className: 'Chrome_WidgetWin_0', firstSeenAt: 1000 })
    expect(selectChromeNewestWindow([...existing, newOlder, otherClass, newLatest], {
      rootPid: 0,
      exePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      baselineHwnds: [80, 81]
    })).toBe(newLatest)
  })

  it('never falls back to an existing Chrome window when no new window appeared', () => {
    const existing = [
      candidate({ hwnd: 85, title: 'Existing', firstSeenAt: 100 }),
      candidate({ hwnd: 86, title: 'Existing 2', firstSeenAt: 100 })
    ]
    expect(selectChromeNewestWindow(existing, {
      rootPid: 0,
      exePath: 'C:\\chrome.exe',
      baselineHwnds: [85, 86]
    })).toBeNull()
  })

  it('ignores Chrome hidden transition windows until the real window is visible', () => {
    const transition = candidate({ hwnd: 87, title: 'Google Chrome', visible: false, firstSeenAt: 500 })
    const visible = candidate({ hwnd: 88, title: 'about:blank - Google Chrome', visible: true, firstSeenAt: 600 })
    expect(selectChromeNewestWindow([transition, visible], {
      rootPid: 0,
      exePath: 'C:\\chrome.exe',
      baselineHwnds: []
    })).toBe(visible)
  })
})

describe('Codex auxiliary-window takeover', () => {
  it('collects every same-PID Chromium/tool top-level window except the main window', () => {
    const main = candidate({ hwnd: 90, pid: 5000, title: 'Codex', firstSeenAt: 100 })
    const hiddenChrome = candidate({ hwnd: 91, pid: 5000, title: '', className: 'Chrome_WidgetWin_0' })
    const nonTool = candidate({ hwnd: 92, pid: 5000, title: 'Popup', className: 'OwlElectron_NotifyIconHostWindow', exStyle: 0 })
    const chromeWidget = candidate({ hwnd: 93, pid: 5000, title: 'Codex dialog', className: 'Chrome_WidgetWin_1' })
    const samePidButNonTool = candidate({ hwnd: 94, pid: 5000, title: '', className: 'Base_PowerMessageWindow', exStyle: 0 })
    const otherPid = candidate({ hwnd: 95, pid: 6000, title: 'Other', className: 'Chrome_WidgetWin_1' })
    const toolWindow = candidate({ hwnd: 96, pid: 5000, title: 'Aux tool', className: 'SomeToolWindow', exStyle: WS_EX_TOOLWINDOW })
    expect(selectCodexSatelliteWindows(main, [main, hiddenChrome, nonTool, chromeWidget, samePidButNonTool, otherPid, toolWindow]).map(x => x.hwnd)).toEqual([91, 93, 96])
  })
})

describe('degraded embedding style', () => {
  it('keeps the caption/frame but still makes the window owned and taskbar-less', () => {
    const original = candidate()
    const next = computeGuiDegradedStyle(original.style, original.exStyle)
    expect(next.style & WS_CAPTION).not.toBe(0)
    expect(next.exStyle & WS_EX_TOOLWINDOW).not.toBe(0)
    expect(next.exStyle & WS_EX_APPWINDOW).toBe(0)
    expect(isGuiDegradedStyleIntact(next.exStyle, 77, 77)).toBe(true)
    expect(isGuiDegradedStyleIntact(next.exStyle, 0, 77)).toBe(false)
  })
})

describe('style retry and startup signature', () => {
  it('uses the required 0.5/1/2/4/8 second backoff schedule', () => {
    expect([0, 1, 2, 3, 4, 5].map(guiStyleRetryDelay)).toEqual([500, 1000, 2000, 4000, 8000, null])
  })

  it('classifies native batches against the 16ms frame budget and 2s skip timeout', () => {
    expect(classifyGuiNativeDuration(1)).toBe('ok')
    expect(classifyGuiNativeDuration(16)).toBe('ok')
    expect(classifyGuiNativeDuration(16.1)).toBe('slow')
    expect(classifyGuiNativeDuration(2000)).toBe('slow')
    expect(classifyGuiNativeDuration(2000.1)).toBe('timeout')
    expect(classifyGuiNativeDuration(Number.NaN)).toBe('timeout')
  })

  it('changes the startup signature when title, class or bounds change', () => {
    const base = candidate()
    expect(guiWindowSignature(base)).toBe(guiWindowSignature({ ...base }))
    expect(guiWindowSignature(base)).not.toBe(guiWindowSignature({ ...base, title: 'Changed' }))
    expect(guiWindowSignature(base)).not.toBe(guiWindowSignature({ ...base, className: 'Other' }))
    expect(guiWindowSignature(base)).not.toBe(guiWindowSignature({ ...base, rect: { ...base.rect, right: 1281 } }))
  })
})

describe('policy inference', () => {
  it('infers Chrome, WeChat and Codex policies from their executables', () => {
    expect(resolveGuiWindowPolicy({ exePath: 'C:\\Chrome\\chrome.exe' })).toBe('chrome-newest')
    expect(resolveGuiWindowPolicy({ exePath: 'C:\\Tencent\\Weixin\\Weixin.exe' })).toBe('wechat-main')
    expect(resolveGuiWindowPolicy({ exePath: 'C:\\Codex\\ChatGPT.exe' })).toBe('codex-multi')
    expect(resolveGuiWindowPolicy({ exePath: 'C:\\Claude\\Claude.exe' })).toBe('default')
    expect(resolveGuiWindowPolicy({ exePath: 'D:\\Download\\Microsoft VS Code\\Code.exe' })).toBe('vscode-main')
    expect(resolveGuiWindowPolicy({ exePath: 'D:\\Download\\Typora\\Typora.exe' })).toBe('electron-main')
    expect(resolveGuiWindowPolicy({ exePath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Qoder CN\\Qoder CN.exe' })).toBe('electron-main')
    expect(resolveGuiWindowPolicy({ exePath: 'C:\\Program Files\\ZCode\\ZCode.exe' })).toBe('electron-main')
    expect(resolveGuiWindowPolicy({ exePath: 'C:\\Program Files\\Zotero\\zotero.exe' })).toBe('zotero-main')
  })

  it('keeps an explicit policy override', () => {
    expect(resolveGuiWindowPolicy({ exePath: 'C:\\Chrome\\chrome.exe', windowPolicy: 'default' })).toBe('default')
  })
})


describe('taskbar hygiene and exact restoration', () => {
  it('clears APPWINDOW on auxiliary windows without stripping their frame', () => {
    const style = WS_CAPTION | WS_THICKFRAME
    const next = computeGuiTaskbarHygieneStyle(style, WS_EX_APPWINDOW | WS_EX_WINDOWEDGE)
    expect(next.style).toBe(style)
    expect(next.exStyle & WS_EX_TOOLWINDOW).not.toBe(0)
    expect(next.exStyle & WS_EX_APPWINDOW).toBe(0)
    expect(isGuiTaskbarHygieneIntact(next.exStyle)).toBe(true)
  })

  it('returns only visible auxiliary windows from the same WeChat PID', () => {
    const main = candidate({ hwnd: 1, pid: 900 })
    const visible = candidate({ hwnd: 2, pid: 900, title: 'Chat' })
    const hidden = candidate({ hwnd: 3, pid: 900, title: 'Hidden chat', visible: false })
    const otherPid = candidate({ hwnd: 4, pid: 901, title: 'Other' })
    const helper = candidate({ hwnd: 5, pid: 900, title: 'Weixin', className: 'Qt51514QWindowToolTipSaveBits' })
    expect(isWeChatRenderHelperWindow(helper)).toBe(true)
    expect(selectWeChatTaskbarHygieneWindows(main, [main, visible, hidden, otherPid, helper]).map((x) => x.hwnd)).toEqual([2])
  })

  it('captures and verifies exact style/exStyle/owner restoration', () => {
    const original = candidate({ hwnd: 5, style: 0x34c70000, exStyle: WS_EX_APPWINDOW, owner: 0 })
    const snapshot = snapshotGuiWindowStyle(original)
    expect(guiWindowStyleRestored(snapshot, { style: original.style, exStyle: original.exStyle, owner: 0 })).toBe(true)
    expect(guiWindowStyleRestored(snapshot, { style: original.style, exStyle: original.exStyle, owner: 7 })).toBe(false)
  })

  it('matches process image paths case-insensitively and exactly', () => {
    expect(processImagePathMatches('C:\\Program Files\\App\\App.exe', 'c:/program files/app/app.exe')).toBe(true)
    expect(processImagePathMatches('C:\\Program Files\\App\\App.exe', 'C:\\Program Files\\Other\\App.exe')).toBe(false)
    expect(processImagePathMatches('', 'C:\\App.exe')).toBe(false)
  })

  it('accepts a new Chrome window from a different browser PID', () => {
    const fresh = candidate({ hwnd: 20, pid: 7777, title: 'New tab - Google Chrome', firstSeenAt: 10 })
    expect(selectChromeNewestWindow([fresh], {
      rootPid: 0,
      exePath: 'C:\\Chrome\\chrome.exe',
      baselineHwnds: []
    })).toBe(fresh)
  })
})

describe('repair of a previously stripped app frame', () => {
  it('adds caption/frame/min/max and removes tool-window bits from a damaged snapshot', () => {
    const damaged = snapshotGuiWindowStyle(candidate({
      hwnd: 30,
      style: 0x14000000,
      exStyle: WS_EX_TOOLWINDOW,
      owner: 77
    }))
    expect(hasGuiWindowFrame(damaged.style)).toBe(false)
    const repaired = repairGuiWindowStyleSnapshot(damaged)
    expect(hasGuiWindowFrame(repaired.style)).toBe(true)
    expect(repaired.style & WS_MINIMIZEBOX).not.toBe(0)
    expect(repaired.style & WS_MAXIMIZEBOX).not.toBe(0)
    expect(repaired.exStyle & WS_EX_TOOLWINDOW).toBe(0)
    expect(repaired.exStyle & WS_EX_APPWINDOW).not.toBe(0)
    expect(repaired.owner).toBe(0)
  })

  it('leaves a normal framed snapshot untouched', () => {
    const normal = snapshotGuiWindowStyle(candidate({ hwnd: 31, style: 0x14cf0000, exStyle: WS_EX_APPWINDOW }))
    expect(repairGuiWindowStyleSnapshot(normal)).toEqual(normal)
  })

  it('adds a missing system menu so caption controls are restorable', () => {
    const missingSysMenu = snapshotGuiWindowStyle(candidate({ hwnd: 32, style: 0x14c70000, exStyle: WS_EX_APPWINDOW }))
    expect(hasGuiWindowFrame(missingSysMenu.style)).toBe(false)
    const repaired = repairGuiWindowStyleSnapshot(missingSysMenu)
    expect(repaired.style & WS_SYSMENU).not.toBe(0)
    expect(hasGuiWindowFrame(repaired.style)).toBe(true)
  })
})

describe('WeChat main-window replacement', () => {
  it('prefers the visible post-login main window over a hidden login window', () => {
    const login = candidate({ hwnd: 40, pid: 900, title: '微信', className: 'Qt51514QWindowIcon', visible: false, iconic: false })
    const main = candidate({ hwnd: 41, pid: 900, title: '微信', className: 'Qt51514QWindowIcon', visible: true, iconic: false })
    expect(selectWeChatMainWindow([login, main], {
      rootPid: 900,
      exePath: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe'
    })).toBe(main)
  })
})

describe('Chrome process-image identity', () => {
  it('rejects a Codex window that looks like Chrome after the baseline', () => {
    const codex = candidate({
      hwnd: 50,
      pid: 6000,
      title: 'ChatGPT',
      className: 'Chrome_WidgetWin_1',
      processPath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe',
      firstSeenAt: 10
    })
    expect(selectChromeNewestWindow([codex], {
      rootPid: 0,
      exePath: 'C:\\Users\\me\\Chrome\\chrome.exe',
      baselineHwnds: []
    })).toBeNull()
  })
})

describe('WeChat frameless repair', () => {
  it('restores a full standard frame with min/max controls', () => {
    const damaged = snapshotGuiWindowStyle(candidate({
      hwnd: 60,
      style: 0x96000000,
      exStyle: WS_EX_TOOLWINDOW,
      owner: 77
    }))
    const repaired = repairWeChatWindowStyleSnapshot(damaged)
    expect(repaired.style & WS_BORDER).not.toBe(0)
    expect(repaired.style & WS_DLGFRAME).not.toBe(0)
    expect(repaired.style & WS_CAPTION).toBe(WS_CAPTION)
    expect(repaired.style & WS_THICKFRAME).not.toBe(0)
    expect(repaired.style & WS_MINIMIZEBOX).not.toBe(0)
    expect(repaired.style & WS_MAXIMIZEBOX).not.toBe(0)
    expect(repaired.style & WS_SYSMENU).not.toBe(0)
    expect(repaired.exStyle & WS_EX_TOOLWINDOW).toBe(0)
    expect(repaired.exStyle & WS_EX_APPWINDOW).toBe(0)
    expect(repaired.exStyle & WS_EX_WINDOWEDGE).not.toBe(0)
    expect(repaired.owner).toBe(0)
  })
})

describe('Electron single-main policy', () => {
  it('restores a minimized Qoder main window and ignores Chromium helper windows', () => {
    const main = candidate({
      hwnd: 200,
      title: 'Qoder CN',
      visible: false,
      iconic: true,
      rect: { left: -16000, top: -16000, right: -15843, bottom: -15975 }
    })
    const helper = candidate({ hwnd: 201, title: 'Qoder CN', className: 'Chrome_WidgetWin_0' })
    const picked = selectElectronMainWindow([helper, main], {
      rootPid: 1000,
      exePath: 'C:\\Program Files\\Qoder CN\\Qoder CN.exe',
      windowClass: 'Chrome_WidgetWin_1',
      windowTitle: 'Qoder CN'
    })
    expect(picked).toBe(main)
  })

  it('prefers a visible restored window over an older iconic window', () => {
    const iconic = candidate({ hwnd: 210, title: 'Typora', iconic: true, visible: false })
    const visible = candidate({ hwnd: 211, title: 'Typora' })
    expect(selectElectronMainWindow([iconic, visible], {
      rootPid: 1000,
      exePath: 'C:\\Typora\\Typora.exe',
      windowClass: 'Chrome_WidgetWin_1',
      windowTitle: 'Typora'
    })).toBe(visible)
  })
})

describe('VS Code multi-window policy', () => {
  const vscodeQuery = {
    rootPid: 1000,
    exePath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
    windowClass: 'Chrome_WidgetWin_1',
    windowTitle: 'Visual Studio Code'
  }

  it('ignores existing windows and picks the new welcome window', () => {
    const existing = candidate({ hwnd: 300, title: '欢迎 - Visual Studio Code', firstSeenAt: 100 })
    const workspace = candidate({ hwnd: 301, title: 'dsh-launcher - Visual Studio Code', firstSeenAt: 500 })
    const welcome = candidate({ hwnd: 302, title: '欢迎 - Visual Studio Code', firstSeenAt: 500 })
    expect(selectVSCodeMainWindow([existing, workspace, welcome], {
      ...vscodeQuery,
      baselineHwnds: [300]
    })).toBe(welcome)
  })

  it('never embeds the extension development host window', () => {
    const extHost = candidate({ hwnd: 310, title: '[扩展开发宿主] 欢迎 - Visual Studio Code', firstSeenAt: 900 })
    const extHostEn = candidate({ hwnd: 311, title: '[Extension Development Host] Welcome - Visual Studio Code', firstSeenAt: 900 })
    expect(isVSCodeAuxiliaryWindow(extHost)).toBe(true)
    expect(isVSCodeAuxiliaryWindow(extHostEn)).toBe(true)
    expect(selectVSCodeMainWindow([extHost, extHostEn], { ...vscodeQuery, baselineHwnds: [] })).toBeNull()
  })

  it('does not fall back to an existing VS Code window when no new window appeared', () => {
    const existing = candidate({ hwnd: 320, title: '欢迎 - Visual Studio Code', firstSeenAt: 100 })
    expect(selectVSCodeMainWindow([existing], { ...vscodeQuery, baselineHwnds: [320] })).toBeNull()
  })
})

describe('Zotero Mozilla main-window policy', () => {
  it('ignores the progress dialog and picks the library window', () => {
    const progress = candidate({
      hwnd: 400,
      title: '进度',
      className: 'MozillaWindowClass',
      rect: { left: 1268, top: 853, right: 1581, bottom: 924 }
    })
    const library = candidate({
      hwnd: 401,
      title: 'An electromagnetic multipole expansion - Zotero',
      className: 'MozillaWindowClass'
    })
    expect(selectZoteroMainWindow([progress, library], {
      rootPid: 1000,
      exePath: 'C:\\Program Files\\Zotero\\zotero.exe',
      windowClass: 'MozillaWindowClass'
    })).toBe(library)
  })

  it('can restore a minimized Zotero library window', () => {
    const minimized = candidate({
      hwnd: 402,
      title: 'Zotero',
      className: 'MozillaWindowClass',
      iconic: true,
      visible: false,
      rect: { left: -16000, top: -16000, right: -15843, bottom: -15975 }
    })
    expect(selectZoteroMainWindow([minimized], {
      rootPid: 1000,
      exePath: 'C:\\Program Files\\Zotero\\zotero.exe'
    })).toBe(minimized)
  })
})

describe('GUI policy dispatch and shared-process safety', () => {
  it('routes each policy to its selector', () => {
    const main = candidate({ hwnd: 500, title: 'ZCode' })
    expect(selectGuiPolicyWindow([main], {
      rootPid: 1000,
      exePath: 'C:\\Program Files\\ZCode\\ZCode.exe',
      windowClass: 'Chrome_WidgetWin_1',
      windowTitle: 'ZCode'
    }, 'electron-main')).toBe(main)
  })

  it('detaches editor windows and closes only the selected Chrome window', () => {
    expect(guiPolicyStopMode('vscode-main')).toBe('detach')
    expect(guiPolicyStopMode('electron-main')).toBe('detach')
    expect(guiPolicyStopMode('zotero-main')).toBe('detach')
    expect(guiPolicyStopMode('chrome-newest')).toBe('window')
    expect(guiPolicyStopMode('wechat-main')).toBe('tree')
    expect(guiPolicyRequiresNewWindow('vscode-main')).toBe(true)
    expect(guiPolicyRequiresNewWindow('electron-main')).toBe(false)
    expect(guiPolicyUsesClientInsetFix('electron-main')).toBe(false)
    expect(guiPolicyUsesClientInsetFix('zotero-main')).toBe(false)
    expect(guiPolicyUsesClientInsetFix('vscode-main')).toBe(true)
    expect(guiPolicyUsesClientInsetFix('wechat-main')).toBe(true)
  })
})
