import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { HarnessProvider, useHarness } from './hooks/useHarness'
import { I18nProvider, useI18n } from './i18n'
import { api } from './lib/api'
import { Sidebar, type PageId } from './components/Sidebar'
import { SplashOverlay } from './components/SplashOverlay'
import { Dashboard } from './pages/Dashboard'
import { Instances } from './pages/Instances'
import { Plugins } from './pages/Plugins'
import { Security } from './pages/Security'
import { Settings } from './pages/Settings'
import { NewTab } from './pages/NewTab'
import { DownloadsPage, HistoryPage } from './pages/ActivityPages'
import { GroupsPage } from './pages/GroupsPage'
import { ProfilesPage } from './pages/ProfilesPage'
import { TopBar } from './components/TopBar'
import { historyForGroup, pushHistory, resolveCurrentGroup } from '../../shared/groups'
import { DEFAULT_PROFILE_ID, profileById, resolveWebChatProfile } from '../../shared/profiles'
import {
  buildHotkeyTargets,
  findHotkeyTargetByDigit,
  hotkeyNumbersForTargets,
  isHotkeyRunningStatus,
  normalizeHotkeySettings,
  parseWindowHotkeyDigit,
  type HotkeyTarget
} from '../../shared/hotkeys'

const SIDEBAR_EXPANDED = 260
const SIDEBAR_COLLAPSED = 56
const TOPBAR_HEIGHT = 58

function Shell(): JSX.Element {
  const { state, states, config, activeInstanceId, saveConfig, poppedOut, setActiveInstance } = useHarness()
  const { t } = useI18n()
  const [view, setView] = useState<PageId | 'dsh' | 'web' | 'gui'>('dashboard')
  const [collapsed, setCollapsed] = useState(false)
  // The startup splash plays inside this window; the DSH view (a native child,
  // drawn above the DOM) stays hidden until the splash has finished.
  const [splashDone, setSplashDone] = useState(false)
  const [groupsCreateSignal, setGroupsCreateSignal] = useState(0)
  const [groupsCreateRequested, setGroupsCreateRequested] = useState(false)
  const [profileManagerOpen, setProfileManagerOpen] = useState(false)
  const groups = config?.groups ?? []
  const currentGroup = resolveCurrentGroup(groups, config?.activeGroupId)
  const hotkeySettings = normalizeHotkeySettings(config?.hotkeys)
  const hotkeyTargets = useMemo(
    () => buildHotkeyTargets(currentGroup, config?.instances ?? [], config?.webChats ?? [], states),
    [currentGroup, config?.instances, config?.webChats, states]
  )
  const hotkeyNumbers = useMemo(() => hotkeyNumbersForTargets(hotkeyTargets), [hotkeyTargets])
  const [leaderActive, setLeaderActive] = useState(false)
  // Event listeners and the low-level hook are long-lived; route them through
  // refs so they always see the current group's targets and latest action.
  const hotkeyTargetsRef = useRef(hotkeyTargets)
  hotkeyTargetsRef.current = hotkeyTargets
  const hotkeySettingsRef = useRef(hotkeySettings)
  hotkeySettingsRef.current = hotkeySettings
  const hotkeyActionRef = useRef<(target: HotkeyTarget) => void>(() => {})

  // The embedded DSH view may only open once the port actually reports ready —
  // not while 'starting'/'stopping' (a connection would just fail).
  const status = state?.status ?? 'stopped'
  const ready = status === 'running' || status === 'external' || status === 'degraded'
  useEffect(() => {
    api.setDshTopInset(TOPBAR_HEIGHT)
    api.setGuiContentInsets({ top: TOPBAR_HEIGHT })
  }, [])

  // Fill missing auto-favicons once per link. Custom/locked icons always win;
  // a null result leaves GlyphTile's deterministic letter/color fallback.
  useEffect(() => {
    if (!config) return
    const missing = (config.webChats ?? []).filter((link) => !link.icon && !link.iconLocked && !link.archived).slice(0, 8)
    if (missing.length === 0) return
    let cancelled = false
    void (async () => {
      const resolved = new Map<string, string>()
      for (const link of missing) {
        const icon = await api.resolveLinkFavicon(link.url)
        if (cancelled) return
        if (icon) resolved.set(link.id, icon)
      }
      if (cancelled || resolved.size === 0) return
      const current = config.webChats ?? []
      await saveConfig({ webChats: current.map((link) => resolved.has(link.id) ? { ...link, icon: resolved.get(link.id) } : link) })
    })()
    return () => { cancelled = true }
  }, [config?.webChats?.map((link) => `${link.id}:${link.icon ?? ''}:${link.iconLocked ? '1' : '0'}`).join('|'), saveConfig])

  const activeInstance = config?.instances.find((inst) => inst.id === activeInstanceId)
  const activeIsGui = activeInstance?.kind === 'gui'
  const activeIsPs = activeInstance?.kind === 'ps'
  const inDsh = view === 'dsh' && !activeIsGui && !activeIsPs
  const inWeb = view === 'web'
  const inGui = view === 'gui'
  // 原生视图(DSH / 网页卡 / GUI 附属窗口)占据内容区时,DOM 不渲染页面。
  const inNative = inDsh || inWeb || inGui
  const splashActive = (config?.splashEnabled ?? true) && !splashDone
  const showDsh = ready && inDsh && !splashActive
  const showGui = ready && inGui && activeIsGui && !splashActive
  const prevReady = useRef<boolean | null>(null)
  // Set whenever the active instance transitions stopped→ready, i.e. a fresh
  // boot (first launch, a manual restart, or an auto-restart after a plugin
  // change). The dsh view must reload on such a transition — the cached page
  // from the previous run is stale. This is STATE, not a ref: the flag has to
  // survive until the view effect actually consumes it, which can be a later
  // render (the view isn't visible the moment the transition fires).
  const [reloadDsh, setReloadDsh] = useState(false)
  // Only the launcher's own launch auto-start (Settings → "Start DSH on
  // launch") may auto-jump into the DSH view. Consumed on the session's first
  // stopped→ready transition; the jump itself fires only if that transition was
  // the launch auto-start. Any later ready (manual start/restart, plugin
  // restart, instance switch) never jumps — the user navigates there.
  const autoJumpDone = useRef(false)

  // 托盘「设置」菜单项:打开窗口并导航到设置页。
  useEffect(() => {
    return api.onEvent((e) => {
      if (e.type === 'launcher-page' && e.page === 'settings') setView('settings')
    })
  }, [])

  // Auto-switch: once the active instance becomes ready, open the matching
  // embedded view. The sidebar's collapsed state is user-owned and unchanged.
  // When it stops, return to the dashboard.
  useEffect(() => {
    const was = prevReady.current
    prevReady.current = ready
    if (ready && !was) {
      setReloadDsh(true)
      if (!autoJumpDone.current) {
        autoJumpDone.current = true
        if (config?.autoStartOnLaunch && !activeIsPs) {
          setView(activeIsGui ? 'gui' : 'dsh')
        }
      }
    } else if (!ready && (inDsh || inGui)) {
      setView('dashboard')
    }
  }, [ready, inDsh, inGui, activeIsGui, activeIsPs, config?.autoStartOnLaunch])

  // Keep a persistent active kind in sync with the native view. This covers
  // tray/dashboard instance switches that don't go through the sidebar row.
  useEffect(() => {
    if (!config) return
    if (activeIsPs) {
      if (view === 'dsh' || view === 'gui') setView('dashboard')
      return
    }
    if (activeIsGui && view === 'dsh') setView(ready ? 'gui' : 'dashboard')
    else if (!activeIsGui && view === 'gui') setView(ready ? 'dsh' : 'dashboard')
  }, [config, activeIsGui, activeIsPs, view, ready])

  // 网页版免费对话(虚拟实例)是真正的视图('web',相当于 DSH 界面),不是浮层:
  // 点开自动缩侧边栏,和其他实例的 DSH 视图行为一致。每张卡在 main 侧有独立常驻视图,
  // 切走/离开再回来不重载(对话保留);双击侧栏卡 = 刷新(F5,带一次 forceReload)。
  const [webChatId, setWebChatId] = useState<string | null>(null)
  const [webReloadTick, setWebReloadTick] = useState(0)
  const webChat = (config?.webChats ?? []).find((w) => w.id === webChatId) ?? null
  const profiles = config?.profiles ?? []
  const defaultProfile = profileById(profiles, DEFAULT_PROFILE_ID)
  // Isolation is a web-link concern only. Instances and groups never own a profile.
  const webChatProfile = inWeb && webChat
    ? resolveWebChatProfile(profiles, webChat.profileId) ?? defaultProfile
    : null
  const currentPageProfile = webChatProfile ?? defaultProfile
  const profileSelectionEnabled = inWeb && Boolean(webChat)
  // 打开一张网页卡:内嵌 = 切到该卡视图(不重载);popout = 独立窗口(不改视图)。
  const openWebChat = (wc: { id: string; url: string }, popout: boolean): void => {
    const link = (config?.webChats ?? []).find((item) => item.id === wc.id)
    const entry = {
      id: `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      webChatId: wc.id,
      name: link?.name ?? wc.url,
      url: wc.url,
      groupId: currentGroup.id,
      openedAt: Date.now()
    }
    void saveConfig({ recentHistory: pushHistory(historyForGroup(currentGroup, config ?? {}), entry) })
    if (popout) api.setWebChat(true, wc.id, wc.url, true)
    else { setWebChatId(wc.id); setView('web') }
  }
  const selectPageProfile = async (profileId: string): Promise<void> => {
    if (!config || profileId === currentPageProfile.id) return
    const isolatedProfileId = profileId === DEFAULT_PROFILE_ID ? undefined : profileId
    if (inWeb && webChat) {
      if (!(await api.confirm(t('profiles.rebuildChatConfirm', { name: webChat.name })))) return
      await saveConfig({
        webChats: (config.webChats ?? []).map((item) => item.id === webChat.id ? { ...item, profileId: isolatedProfileId } : item)
      })
      return
    }

  }
  const openProfileManager = (): void => {
    void (async () => {
      if (currentGroup.kind !== 'home') await saveConfig({ activeGroupId: 'home' })
      setView('profiles')
      setProfileManagerOpen(true)
    })()
  }
  // Ordinary refresh: reload the page the card is currently showing (F5).
  const refreshWebChat = (wc: { id: string; url: string }): void => {
    if (view === 'web' && webChatId === wc.id) {
      api.reloadWebChat(wc.id)
      return
    }
    setWebChatId(wc.id)
    setView('web')
  }
  // Restore the card's configured URL even after in-page navigation.
  const resetWebChatUrl = (wc: { id: string; url: string }): void => {
    setWebChatId(wc.id)
    setView('web')
    setWebReloadTick((t) => t + 1)
  }
  // Shared action for window-local Alt+digit and the global leader digit. It
  // only switches the active instance or opens a link; it never changes group
  // visibility or restarts anything.
  const activateHotkeyTarget = (target: HotkeyTarget): void => {
    if (!hotkeySettingsRef.current.enabled || !config) return
    if (target.kind === 'link') {
      const link = (config.webChats ?? []).find((item) => item.id === target.id)
      if (link) openWebChat(link, false)
      return
    }
    const instance = config.instances.find((item) => item.id === target.id)
    if (!instance) return
    const instanceState = states[instance.id]
    if (!isHotkeyRunningStatus(instanceState)) {
      // The target list was built a moment earlier; if the instance stopped in
      // between, surface it without offering an automatic start.
      void api.confirm(t('hotkeys.unavailablePrompt', { name: instance.name }))
      return
    }
    void (async () => {
      await setActiveInstance(instance.id)
      if (!poppedOut[instance.id]) {
        setView(instance.kind === 'ps' ? 'dashboard' : instance.kind === 'gui' ? 'gui' : 'dsh')
      } else if (view === 'web' || view === 'gui') {
        setView('instances')
      }
    })()
  }

  hotkeyActionRef.current = activateHotkeyTarget

  // Window-local Alt+1..9/0. Only the exact Alt+digit chord is consumed.
  useEffect(() => {
    if (!hotkeySettings.enabled) {
      setLeaderActive(false)
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const digit = parseWindowHotkeyDigit(event)
      if (!digit) return
      const target = findHotkeyTargetByDigit(hotkeyTargets, digit)
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      hotkeyActionRef.current(target)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [hotkeySettings.enabled, hotkeyTargets])

  // Low-level hook notifications. Leader mode only decorates the badges; the
  // digit event carries the actual action so this works while another app has
  // focus too.
  useEffect(() => {
    return api.onEvent((event) => {
      if (event.type === 'hotkey-leader') {
        setLeaderActive(event.active)
        return
      }
      if (event.type !== 'hotkey-trigger') return
      setLeaderActive(false)
      if (!hotkeySettingsRef.current.enabled) return
      const target = findHotkeyTargetByDigit(hotkeyTargetsRef.current, event.digit)
      if (target) hotkeyActionRef.current(target)
    })
  }, [])

  // 统一的原生视图管理:网页聊天视图打开时隐藏 DSH 视图;否则恢复 DSH/页面。
  // 顺序很关键:先隐藏 DSH,再显示网页聊天(共享的 active 状态由最后一次调用定夺)。
  // forceReload 是一次性的:双击侧栏卡触发,消费后立刻清零,普通进出不重载。
  useEffect(() => {
    if (inWeb) {
      // 当前卡已被删(配置里找不到)→ 退出网页视图,别让空卡占着。
      if (!webChat) { setView('dashboard'); return }
      if (activeInstanceId) {
        api.setDshActive(activeInstanceId, false)
        api.setGuiActive(activeInstanceId, false)
      }
      const force = webReloadTick > 0
      if (force) setWebReloadTick(0)
      api.setWebChat(true, webChat.id, webChat.url, false, force)
    } else if (inGui) {
      if (webChat) api.setWebChat(false, webChat.id, webChat.url, false)
      if (activeInstanceId) {
        api.setDshActive(activeInstanceId, false)
        api.setGuiActive(activeInstanceId, showGui)
      }
    } else {
      if (webChat) api.setWebChat(false, webChat.id, webChat.url, false)
      if (activeInstanceId) {
        api.setGuiActive(activeInstanceId, false)
        if (activeIsGui) api.setDshActive(activeInstanceId, false)
        else api.setDshActive(activeInstanceId, showDsh, showDsh && reloadDsh)
        if (showDsh && reloadDsh) setReloadDsh(false)
      }
    }
  }, [inWeb, inGui, activeInstanceId, activeIsGui, showDsh, showGui, reloadDsh, webChat, webReloadTick])

  // "floatingWhale" (Settings, default off) swaps the collapsed rail for a
  // draggable orb: the sidebar disappears and the native view (DSH 或网页版) fills
  // the window, with the orb floating on top。网页版视图同样适用。
  const floatingWhale = config?.floatingWhale ?? false
  // A GUI window is a real top-level owned HWND drawn above the launcher, so
  // the in-window floating orb would be covered by it. Keep the compact rail.
  const orbMode = floatingWhale && inNative && collapsed && !inGui

  // Keep the view flush against the sidebar rail when it expands/collapses —
  // in orb mode the rail is gone, so the native view spans the full window.
  const dshWidth = orbMode ? 0 : collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED

  // 宽度变化直接把目标值发给主进程,由主进程做 150ms easing 动画(渲染层被内嵌 dsh
  // 遮挡时 rAF 会节流,不能再用渲染层驱动;主进程 setTimeout 不受影响)。初始挂载也走
  // 这里(from===to 时主进程直接 no-op)。
  useEffect(() => {
    api.setDshSidebarWidth(dshWidth)
  }, [dshWidth])

  // Show the floating orb while the DSH view is open in orb mode.
  useEffect(() => {
    api.setOrbVisible(orbMode)
  }, [orbMode])

  // The orb's short click expands the menu (the orb itself already returned to
  // the top-left in the main process).
  useEffect(() => {
    return api.onOrbClicked(() => {
      setCollapsed(false)
    })
  }, [])

  // Popped-out instances (running in a launcher child window) toggle back to the
  // embedded "integrated" view when their separate window closes — by the button
  // or by clicking the window's own close button. Popping an instance OUT leaves
  // the embedded DSH view (it would just duplicate the new window); closing it
  // brings the view back, but only for the active instance that is still up.
  const activeRef = useRef(activeInstanceId)
  activeRef.current = activeInstanceId
  const statesRef = useRef(states)
  statesRef.current = states
  const viewRef = useRef(view)
  viewRef.current = view
  useEffect(() => {
    return api.onEvent((e) => {
      if (e.type !== 'popup') return
      const id = e.instanceId
      if (e.open) {
        if (id === activeRef.current && viewRef.current === 'dsh') {
          setView('dashboard')
        }
      } else {
        const st = statesRef.current[id]
        if (id === activeRef.current && (st?.status === 'running' || st?.status === 'external' || st?.status === 'degraded')) {
          setView('dsh')
        }
      }
    })
  }, [])

  const page = view === 'dsh' || view === 'gui' ? 'dashboard' : (view as PageId)
  const openGroups = (create = false): void => {
    setProfileManagerOpen(false)
    setGroupsCreateRequested(create)
    if (create) setGroupsCreateSignal((value) => value + 1)
    setView('groups')
  }

  return (
    <div className="flex h-full">
      {(config?.splashEnabled ?? true) && !splashDone && <SplashOverlay onDone={() => setSplashDone(true)} />}
      {/* Always mounted (width animates to 0 in orb mode) so the rail's content
          can't pop in/out; overflow-hidden on the rail clips it at width 0. */}
      <Sidebar
        view={inNative ? (inGui ? 'gui' : inDsh ? 'dsh' : 'web') : page}
        setView={(v) => {
          // 视图切换不改变折叠状态:实例、链接、普通页面和原生视图之间来回切换
          // 都沿用用户手动设置的宽度。
          setProfileManagerOpen(false)
          setView(v)
        }}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        width={dshWidth}
        onOpenWebChat={openWebChat}
        onRefreshWebChat={refreshWebChat}
        onResetWebChatUrl={resetWebChatUrl}
        activeWebChatId={webChatId}
        currentGroup={currentGroup}
        onOpenNewTab={() => { setProfileManagerOpen(false); setView('new') }}
        canCollapse={true}
        hotkeyNumbers={hotkeyNumbers}
        leaderActive={leaderActive}
        hotkeysEnabled={hotkeySettings.enabled}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          groups={groups}
          activeGroupId={config?.activeGroupId}
          profiles={profiles}
          currentProfile={currentPageProfile}
          profileSelectionEnabled={profileSelectionEnabled}
          onSelectGroup={(groupId) => { setProfileManagerOpen(false); void saveConfig({ activeGroupId: groupId }) }}
          onSelectProfile={(profileId) => void selectPageProfile(profileId)}
          onOpenGroups={openGroups}
          onOpenProfiles={openProfileManager}
        />
        <main className={`flex-1 ${inNative ? 'overflow-hidden' : 'overflow-y-auto'}`}>
          {inNative && !profileManagerOpen ? null : (
            <div key={profileManagerOpen ? 'profiles' : page} className="page-enter">
          {profileManagerOpen ? (
            <ProfilesPage />
          ) : page === 'dashboard' ? (
            <Dashboard />
          ) : page === 'instances' ? (
            <Instances onOpenWebChat={openWebChat} onOpenNewTab={() => setView('new')} />
          ) : page === 'profiles' ? (
            <ProfilesPage />
          ) : page === 'plugins' ? (
            <Plugins />
          ) : page === 'security' ? (
            <Security />
          ) : page === 'new' ? (
            <NewTab group={currentGroup} onOpenWebChat={openWebChat} />
          ) : page === 'history' ? (
            <HistoryPage group={currentGroup} onOpenWebChat={openWebChat} />
          ) : page === 'downloads' ? (
            <DownloadsPage />
          ) : page === 'groups' ? (
            <GroupsPage createSignal={groupsCreateSignal} createRequested={groupsCreateRequested} />
          ) : (
            <Settings />
          )}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

export default function App(): JSX.Element {
  return (
    <HarnessProvider>
      <I18nProvider>
        <Shell />
      </I18nProvider>
    </HarnessProvider>
  )
}
