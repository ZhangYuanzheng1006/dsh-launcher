// Hosts the DSH Web UI for each instance in a native WebContentsView, positioned
// flush against the right edge of the launcher sidebar. Only the active
// instance's view is visible at a time; inactive views stay alive in a shared
// LRU pool (at most 6 hidden), so recent switches keep their cached page.
//
// The legacy <webview> tag routes the guest through the host renderer's DOM,
// which breaks IME composition and places the IME candidate window at the
// wrong coordinates. A WebContentsView is a first-class child of the window's
// content view, so keyboard focus and IME work natively.

import { app, BrowserWindow, session, WebContentsView, type WebContents } from 'electron'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { consumeInstanceAuthUrl, getInstanceAuthUrl, getState, onInstanceAuthUrl } from './harness'
import { getInstance } from './instances'
import { MAX_HIDDEN_VIEWS, selectLruEvictions } from './view-lru'
import { broadcast } from './bus'
import { openExternalLinks } from './webview'
import { getConfig } from './config'
import { resolveWebChatProfile } from '../shared/profiles'
import { profilePartition } from './profile-session'

const SIDEBAR_EXPANDED = 260
const SIDEBAR_COLLAPSED = 56

/** 官方网页版对话地址(缺省)。 */
export const WEB_CHAT_URL = 'https://chat.deepseek.com'

// 网页版免费对话(虚拟实例)卡片:每张卡一个常驻 WebContentsView,键 = `web:<卡id>`,
// 与实例视图同池(relayout / 拖动冻结共用)。卡片间切换、离开再回来都不重载页面;
// 非活动(切走/离开)满 WEB_IDLE_MS 自动销毁释放内存,下次打开重新加载。
const WEB_KEY_PREFIX = 'web:'
const webKey = (id: string): string => `${WEB_KEY_PREFIX}${id}`
function isWebKey(key: string): boolean {
  return key.startsWith(WEB_KEY_PREFIX)
}
const WEB_IDLE_MS = 30 * 60 * 1000 // 网页卡非活动 30 分钟 → 释放
const WEB_IDLE_SWEEP_MS = 60 * 1000 // 每 1 分钟清扫一次

const views = new Map<string, WebContentsView>()
let win: BrowserWindow | null = null
let activeId: string | null = null
let active = false
let sidebarWidth = SIDEBAR_EXPANDED
let topInset = 0
const loaded = new Set<string>()
let onViewAdded: (() => void) | null = null
// 网页卡:键 → 上次 load 的 url(同 url 重进不重载);键 → 开始非活动的时刻(有值 = 已切走)。
const webLoadedUrl = new Map<string, string>()
const webIdleSince = new Map<string, number>()
let webIdleTimer: ReturnType<typeof setInterval> | null = null
let lastWebAliveSig = ''
// 所有视图(实例 + 网页卡)共享一套 LRU:记录每个视图最后一次被激活的序号。
// 非活动视图最多保留 MAX_HIDDEN_VIEWS 个,超出时从最久未用的开始回收。
const viewLastUsed = new Map<string, number>()
let viewUseSeq = 0
// Partition signature captured at view creation; changes rebuild only web-link views.
const viewProfile = new Map<string, string>()

function partitionForKey(key: string): string | undefined {
  if (!isWebKey(key)) return undefined
  const chatId = key.slice(WEB_KEY_PREFIX.length)
  const chat = getConfig().webChats?.find((item) => item.id === chatId)
  return profilePartition(resolveWebChatProfile(getConfig().profiles ?? [], chat?.profileId))
}

/** Human-readable label for the defaultSession creation log. */
function viewLabel(key: string): string {
  const cfg = getConfig()
  if (isWebKey(key)) {
    const chatId = key.slice(WEB_KEY_PREFIX.length)
    return cfg.webChats?.find((chat) => chat.id === chatId)?.name ?? chatId
  }
  return getInstance(key)?.name ?? key
}

/** Confirm every view is on the legacy session and expose its live cookie count. */
function logViewSession(key: string, partition?: string): void {
  const label = viewLabel(key)
  const targetSession = partition ? session.fromPartition(partition) : session.defaultSession
  const sessionName = partition ?? 'defaultSession'
  const write = (line: string): void => {
    console.log(line)
    try {
      appendFileSync(join(app.getPath('userData'), 'view-session.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch {
      /* diagnostics only */
    }
  }
  void targetSession.cookies.get({})
    .then((cookies) => write(`[view] ${label} using ${sessionName}, cookies=${cookies.length}`))
    .catch((error) => {
      write(`[view] ${label} using ${sessionName}, cookies=<unavailable>`)
      console.warn(error)
    })
}
function touchView(key: string): void {
  viewLastUsed.set(key, ++viewUseSeq)
}

/** 回收超过上限的非活动视图;当前活动视图永不参与回收。 */
function enforceViewLru(): void {
  const activeKey = active && activeId ? activeId : null
  const evictions = selectLruEvictions(
    [...views.keys()].map(key => ({ key, lastUsed: viewLastUsed.get(key) ?? 0 })),
    activeKey,
    MAX_HIDDEN_VIEWS
  )
  for (const key of evictions) destroyView(key)
}

/** 存活网页卡 id(常驻视图还在 → 保活中);变化时广播给渲染层(侧栏点变绿/回灰)。 */
function emitWebAlive(): void {
  const ids: string[] = []
  for (const key of views.keys()) {
    if (isWebKey(key)) ids.push(key.slice(WEB_KEY_PREFIX.length))
  }
  const sig = ids.join(',')
  if (sig === lastWebAliveSig) return
  lastWebAliveSig = sig
  broadcast({ type: 'webchat-views', ids })
}

/** 当前保活中的网页卡 id(供渲染层初次挂载查询)。 */
export function aliveWebChatIds(): string[] {
  const ids: string[] = []
  for (const key of views.keys()) {
    if (isWebKey(key)) ids.push(key.slice(WEB_KEY_PREFIX.length))
  }
  return ids
}

// 窗口 resize/move 时 Electron 每帧触发,直接对 WebContentsView setBounds 会让
// 内嵌页面每帧重排,低配电脑明显卡顿。节流:高频事件合并到 ~30ms 一次,并在事件
// 结束后补一次最终布局(保证松手/停稳后尺寸精确)。离散事件(切实例/侧栏宽)仍立即重排。
let relayoutTimer: ReturnType<typeof setTimeout> | null = null
let trailingTimer: ReturnType<typeof setTimeout> | null = null
// 尺寸 + 活动视图双因子:尺寸未变但活动视图变了(切实例/切网页聊天)也必须重排,
// 否则 setVisible(true/false) 不会执行 → 网页聊天打不开。
let lastLayout: { w: number; h: number; x: number; top: number; activeId: string | null } | null = null

// --- 拖动/缩放时冻结内嵌页 ---
// 内嵌 dsh 是独立 GPU 表面,拖动时它若持续满帧刷新,DWM 每帧重画两层会卡。检测拖动
// (轮询位置/尺寸,模态循环里可靠),拖动中把内嵌页限帧到 DRAG_FPS(1fps,可见但基本
// 不刷新),停稳 DRAG_SETTLE_MS 后恢复 —— 停稳瞬间补一帧。launcher 侧已去掉
// backgroundThrottling:false,被 dsh 遮挡时自身会被节流成静态,所以只剩这一个活跃源。
const DRAG_SETTLE_MS = 500 // 位置/尺寸连续不变该时长 → 结束(宽松)
const DRAG_POLL_MS = 100
const DRAG_FPS = 1 // 拖动中内嵌页帧率(≈冻结)
const RESTORE_FPS = 60
let dragging = false
let lastX = 0
let lastY = 0
let lastW = 0
let lastH = 0
let stillSince = 0
let dragPoll: ReturnType<typeof setInterval> | null = null

function setDragging(next: boolean): void {
  if (dragging === next) return
  dragging = next
  for (const [, v] of views) {
    v.webContents.setFrameRate(next ? DRAG_FPS : RESTORE_FPS)
  }
}

/** 轮询窗口位置/尺寸:任一变化即拖动/缩放中;连续 DRAG_SETTLE_MS 不变 → 结束。 */
function pollDrag(): void {
  if (!win) return
  const [x, y] = win.getPosition()
  const [w, h] = win.getSize()
  const changed = x !== lastX || y !== lastY || w !== lastW || h !== lastH
  lastX = x
  lastY = y
  lastW = w
  lastH = h
  if (changed) {
    stillSince = Date.now()
    if (!dragging) setDragging(true)
  } else if (dragging && Date.now() - stillSince >= DRAG_SETTLE_MS) {
    setDragging(false)
  }
}

function scheduleRelayout(): void {
  if (trailingTimer) clearTimeout(trailingTimer)
  trailingTimer = setTimeout(() => { trailingTimer = null; relayout() }, 60)
  if (relayoutTimer) return
  relayoutTimer = setTimeout(() => { relayoutTimer = null; relayout() }, 30)
}

/** Attach a host window. The views are created lazily on first activation. */
export function registerDshView(host: BrowserWindow): void {
  win = host
  host.on('resize', scheduleRelayout)
  const [ix, iy] = host.getPosition()
  const [iw, ih] = host.getSize()
  lastX = ix
  lastY = iy
  lastW = iw
  lastH = ih
  dragPoll = setInterval(pollDrag, DRAG_POLL_MS)
  // 每 1 分钟清扫一次:非活动满 30 分钟的网页卡视图 → 销毁释放内存。
  webIdleTimer = setInterval(sweepWebIdle, WEB_IDLE_SWEEP_MS)
  // 新版 dsh 认证 token 到达时,若该实例是活动视图,用带 token 的 URL 重载
  // (否则内嵌视图加载的是基础 URL,会 401「authentication required」)。
  onInstanceAuthUrl((id, url) => {
    if (active && id === activeId && win) {
      const v = views.get(id)
      if (v) {
        void v.webContents.loadURL(url).then(() => consumeInstanceAuthUrl(id)).catch(() => {})
      }
    }
  })
  host.on('closed', () => {
    if (dragPoll) clearInterval(dragPoll)
    dragPoll = null
    dragging = false
    if (webIdleTimer) clearInterval(webIdleTimer)
    webIdleTimer = null
    for (const v of views.values()) v.webContents.close()
    views.clear()
    loaded.clear()
    webLoadedUrl.clear()
    webIdleSince.clear()
    viewLastUsed.clear()
    viewUseSeq = 0
    lastWebAliveSig = ''
    win = null
  })
}

/**
 * Register a callback fired whenever a new DSH view is added to the window.
 * The floating orb uses this to re-stack itself on top (child views draw in
 * addition order, so a view created later would cover it).
 */
export function onDshViewAdded(cb: () => void): void {
  onViewAdded = cb
}

/**
 * Show/hide the embedded DSH view for an instance. Pass `reload: true` when the
 * harness just (re)became ready, so a stale page from a previous run is
 * discarded.
 */
export function setDshActive(instanceId: string, next: boolean, reload?: boolean): void {
  if (next) {
    // 当前是网页卡视图时,切回实例会让该卡从此刻开始计闲置;随后再打开它会清掉计时。
    if (active && activeId && isWebKey(activeId)) webIdleSince.set(activeId, Date.now())
    active = true
    activeId = instanceId
    if (win) {
      const v = ensureViewFor(instanceId)
      if (v) {
        touchView(instanceId)
        if (!loaded.has(instanceId) || reload) {
          loaded.add(instanceId)
          const port = getState(instanceId).port
          // 新版 dsh 认证:优先加载带 launchToken 的认证 URL(主进程持有),否则回退基础 URL。
          // token 用后即毁:加载成功(种 cookie)后销毁;全部退出时 dsh 必停,下次新 token。
          const authUrl = getInstanceAuthUrl(instanceId)
          if (port > 0) {
            const p = v.webContents.loadURL(authUrl ?? `http://127.0.0.1:${port}`)
            if (authUrl) void p.then(() => consumeInstanceAuthUrl(instanceId)).catch(() => { /* 失败保留 */ })
          }
        }
      }
    }
  } else {
    // 隐藏当前视图(实例或网页卡)。App 在打开网页卡前、以及网页卡从配置中
    // 被删除后都会用这个入口兜底,因此不能只匹配传入的 instanceId。
    if (activeId && isWebKey(activeId)) webIdleSince.set(activeId, Date.now())
    active = false
    activeId = null
  }
  enforceViewLru()
  relayout()
}

/**
 * Create the DSH view for an instance if it does not exist yet, and return its
 * webContents. Exported so the floating orb can ensure the active view is
 * already a child of the window before it adds itself — child views stack in
 * addition order, so the orb (added later) is always drawn on top.
 */
export function ensureView(): WebContents | undefined {
  if (!activeId) return undefined
  return ensureViewFor(activeId)?.webContents
}

function ensureViewFor(instanceId: string): WebContentsView | null {
  if (!win) return null
  const partition = partitionForKey(instanceId)
  const profileSignature = partition ?? 'default-session'
  if (views.has(instanceId) && viewProfile.get(instanceId) !== profileSignature) {
    const restoreActive = active && activeId === instanceId
    destroyView(instanceId)
    if (restoreActive) { active = true; activeId = instanceId }
  }
  let v = views.get(instanceId)
  if (!v) {
    // Instances always use defaultSession; only newly created web links may
    // opt into an isolated partition. Profile records are never created here.
    v = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, ...(partition ? { partition } : {}) }
    })
    viewProfile.set(instanceId, profileSignature)
    // 外链(插件塞进 dsh 页面的跳转按钮等)一律走系统浏览器标签页,不要弹裸 Electron 窗口。
    // 注意:必须在这里显式挂 —— Electron 43 的 WebContentsView 报 getType()==='window',
    // 以前那个按类型过滤的全局钩子根本匹配不到它(见 webview.ts 的说明)。
    openExternalLinks(v.webContents)
    win.contentView.addChildView(v)
    views.set(instanceId, v)
    touchView(instanceId)
    // A fresh view lands on top of the existing stack — let the orb move back up.
    onViewAdded?.()
    logViewSession(instanceId, partition)
    if (isWebKey(instanceId)) emitWebAlive() // 网页卡常驻视图诞生 → 通知侧栏点亮
  }
  return v
}

let sidebarAnimTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Keep the view flush against the sidebar after it expands/collapses. 动画在主进程跑
 * (150ms easing,与渲染层原 CSS 过渡一致):渲染层被内嵌 dsh 遮挡时 rAF 会被节流,
 * 不能再靠渲染层驱动 —— 否则为迁就它就得关掉 backgroundThrottling(那是卡顿主因)。
 * 主进程 setTimeout 不受遮挡影响,天然平滑。
 */
/** Reserve vertical chrome (the S2 top bar) above embedded views. */
export function setDshTopInset(height: number): void {
  const next = Math.max(0, Math.round(Number.isFinite(height) ? height : 0))
  if (next === topInset) return
  topInset = next
  lastLayout = null
  relayout()
}

export function setDshSidebarWidth(width: number): void {
  if (sidebarAnimTimer) clearTimeout(sidebarAnimTimer)
  const from = sidebarWidth
  if (from === width) { relayout(); return }
  const t0 = Date.now()
  const DUR = 150
  const tick = (): void => {
    const p = Math.min(1, (Date.now() - t0) / DUR)
    const eased = 1 - Math.pow(1 - p, 3)
    sidebarWidth = Math.round(from + (width - from) * eased)
    relayout()
    if (p < 1) {
      sidebarAnimTimer = setTimeout(tick, 16)
    } else {
      sidebarWidth = width
      relayout()
      sidebarAnimTimer = null
    }
  }
  sidebarAnimTimer = setTimeout(tick, 16)
}

let webChatWindow: import('electron').BrowserWindow | null = null

function openWebChatWindow(url: string, partition?: string): void {
  if (webChatWindow && !webChatWindow.isDestroyed()) {
    webChatWindow.loadURL(url)
    webChatWindow.focus()
    return
  }
  const w = new BrowserWindow({
    width: 1000,
    height: 760,
    autoHideMenuBar: true,
    backgroundColor: '#0e1013',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, ...(partition ? { partition } : {}) }
  })
  logViewSession(url, partition)
  webChatWindow = w
  w.loadURL(url)
  // 网页里的外链用系统浏览器打开,不让它替换对话窗口本身。
  openExternalLinks(w.webContents)
  w.on('closed', () => { webChatWindow = null })
}

/** 销毁一个视图键:清掉相关簿记后 close webContents(网页卡释放 / 实例删除共用)。 */
function destroyView(key: string): void {
  loaded.delete(key)
  webLoadedUrl.delete(key)
  webIdleSince.delete(key)
  viewLastUsed.delete(key)
  viewProfile.delete(key)
  const v = views.get(key)
  if (!v) return
  if (activeId === key) {
    activeId = null
    active = false
  }
  views.delete(key)
  if (isWebKey(key)) emitWebAlive() // 常驻视图被释放 → 通知侧栏回灰
  v.webContents.close()
  relayout()
}

/** 清扫:非活动满 WEB_IDLE_MS 的网页卡视图销毁,释放内存(下次打开重新加载)。 */
function sweepWebIdle(): void {
  const now = Date.now()
  for (const [key, since] of webIdleSince) {
    if (now - since >= WEB_IDLE_MS) destroyView(key)
  }
}

/** 网页卡加载:同 url 且非强制刷新则不重载(切走再回来页面原样还在)。 */
function loadWebChat(key: string, url: string, forceReload: boolean): void {
  const v = ensureViewFor(key)
  if (!v) return
  if (forceReload || webLoadedUrl.get(key) !== url) {
    webLoadedUrl.set(key, url)
    void v.webContents.loadURL(url).catch(() => { /* 网络失败静默,下次打开再试 */ })
  }
}

/**
 * 网页版免费对话(虚拟实例)卡片:
 * - popout=true  → 独立 BrowserWindow(和 dsh 弹出窗口同等的独立窗口),不受内嵌保活管理。
 * - popout=false → 应用内嵌 WebContentsView,每张卡一个常驻视图(键 `web:<chatId>`),
 *   和 DSH 视图一样贴侧边栏。切卡 / 离开再回来不重载;`forceReload=true`(双击刷新,
 *   F5 语义)、首次打开、或卡 url 变更时才重新加载。关闭只隐藏不销毁;非活动满
 *   30 分钟、或共享池超过 6 个非活动视图时(LRU)销毁释放内存,下次打开重新加载。
 */
export function setWebChat(show: boolean, chatId: string, url: string, popout: boolean, forceReload?: boolean): void {
  const key = webKey(chatId || url) // 兜底:无卡 id 时用 url 当键
  if (popout) {
    openWebChatWindow(url, partitionForKey(key))
    return
  }
  if (show) {
    // 从别的网页卡切过来:旧卡从此刻开始计闲置。
    if (active && activeId && isWebKey(activeId) && activeId !== key) webIdleSince.set(activeId, Date.now())
    active = true
    activeId = key
    webIdleSince.delete(key) // 正在看的卡不算闲置
    loadWebChat(key, url, forceReload === true)
    touchView(key)
  } else if (active && activeId && isWebKey(activeId)) {
    webIdleSince.set(activeId, Date.now())
    active = false
    activeId = null
  } else {
    // 当前不是网页卡(通常是 DSH 视图):不要在这里清 active,
    // 否则会短暂把正在显示的实例视图也当成隐藏视图而触发 LRU 回收。
    return
  }
  enforceViewLru()
  relayout()
}

/** Reload the currently displayed page in a web-chat view without resetting its URL. */
export function reloadWebChatCurrent(chatId: string): void {
  const view = views.get(webKey(chatId))
  if (view) view.webContents.reload()
}

/** 网页卡被删除/不再需要时,主动释放其常驻视图(立即生效,不等 30 分钟)。 */
export function releaseWebChat(chatId: string): void {
  destroyView(webKey(chatId))
}

/**
 * 移除某实例的嵌入式视图(实例删除时调用)。实例 id 是 UUID 不复用,不清理的话
 * 隐藏视图会一直驻留,白占一个 WebContents。同时避免「删除的实例恰好是活动视图」
 * 时残留的 activeId 指向已删除实例。
 */
export function removeDshView(instanceId: string): void {
  // 实例删除时一并清理认证 token。
  consumeInstanceAuthUrl(instanceId)
  destroyView(instanceId)
}

function relayout(): void {
  if (!win) return
  const [w, h] = win.getContentSize()
  const x = sidebarWidth
  // 尺寸与活动视图都未变才跳过,避免 setBounds 空跑;活动视图变了则必须重排。
  if (lastLayout && lastLayout.w === w && lastLayout.h === h && lastLayout.x === x && lastLayout.top === topInset && lastLayout.activeId === activeId) return
  lastLayout = { w, h, x, top: topInset, activeId }
  for (const [id, v] of views) {
    if (active && id === activeId) {
      v.setBounds({ x, y: topInset, width: Math.max(0, w - x), height: Math.max(0, h - topInset) })
      v.setVisible(true)
    } else {
      v.setVisible(false)
    }
  }
}
