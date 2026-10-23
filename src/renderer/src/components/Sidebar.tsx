import { useEffect, useRef, useState, type JSX } from 'react'
import { useHarness } from '../hooks/useHarness'
import { useTheme } from '../hooks/useTheme'
import { useSecurityMonitor } from '../hooks/securityMonitor'
import { useI18n } from '../i18n'
import { RISK_LEVELS } from '../lib/securityRisk'
import { api, type DshInstance, type WebChatConfig } from '../lib/api'
import type { Group } from '../../../shared/types'
import type { CookieBridgeState } from '../../../shared/bridge'
import { s6s7Text } from '../s6s7Text'
import { visibleInstancesForGroup, visibleLinksForGroup } from '../../../shared/groups'
import { fallbackColor } from '../../../shared/favicon'
import { GlyphTile } from './Glyph'
import {
  TerminalIcon,
  ListIcon,
  PuzzleIcon,
  ShieldIcon,
  GearIcon,
  ProfileIcon,
  ChevronIcon,
  PlusIcon,
  RefreshIcon,
  SunIcon,
  MoonIcon,
  PlayIcon,
  StopIcon,
  NewWindowIcon,
  WindowReturnIcon,
  DownloadIcon
} from '../lib/icons'
import { StatusPill } from './StatusPill'
import { isGoogleAccountUrl } from '../../../shared/google-auth'
import whaleIcon from '../assets/whale.png'

export type PageId = 'dashboard' | 'instances' | 'profiles' | 'plugins' | 'security' | 'settings' | 'web' | 'gui' | 'new' | 'groups' | 'history' | 'downloads'

interface SidebarProps {
  view: PageId | 'dsh' | 'web'
  setView: (v: PageId | 'dsh' | 'web' | 'gui') => void
  collapsed: boolean
  setCollapsed: (b: boolean) => void
  /** Current rail width (0 when the floating orb hides it entirely). */
  width: number
  /** 虚拟实例(网页卡片):内嵌进 'web' 视图(切换不重载)/ popout=true 弹独立窗口。 */
  onOpenWebChat: (chat: { id: string; url: string }, popout: boolean) => void
  /** 虚拟实例卡双击/刷新按钮:普通刷新当前页面(相当于 F5)。 */
  onRefreshWebChat: (chat: { id: string; url: string }) => void
  /** 回到卡片配置中的原始 URL(即使页面已跳转到其他地址)。 */
  onResetWebChatUrl: (chat: { id: string; url: string }) => void
  /** 当前打开的网页卡 id(用于高亮侧边栏对应项)。 */
  activeWebChatId?: string | null
  /** 当前工作区分组;左栏只渲染该组可见的实例与链接。 */
  currentGroup: Group
  /** 左栏「+」/新标签页入口。 */
  onOpenNewTab: () => void
  /** Whether the rail can collapse; all current groups allow it. */
  canCollapse: boolean
  /** 数字快捷键徽标编号(按目标 id 索引);关闭快捷键时不渲染。 */
  hotkeyNumbers?: { instances: Record<string, string>; links: Record<string, string> }
  /** leader 状态下徽标高亮。 */
  leaderActive?: boolean
  /** 快捷键总开关。 */
  hotkeysEnabled?: boolean
}

/** Status dot color per harness status (mirrors StatusPill). */
const STATUS_COLOR: Record<string, string> = {
  running: 'var(--ok)',
  starting: 'var(--accent)',
  stopping: 'var(--warn)',
  error: 'var(--err)',
  degraded: 'var(--warn)',
  stopped: 'var(--muted)',
  external: 'var(--warn)'
}
const STATUS_PULSE: Record<string, boolean> = {
  starting: true,
  stopping: true
}

/** Small number badge anchored to the lower-left of an item icon. */
function HotkeyBadge({ digit, active }: { digit: string; active: boolean }): JSX.Element {
  return (
    <span
      className="hotkey-badge"
      data-active={active || undefined}
      aria-hidden="true"
    >
      {digit}
    </span>
  )
}


export function Sidebar({ view, setView, collapsed, setCollapsed, width, onOpenWebChat, onRefreshWebChat, onResetWebChatUrl, activeWebChatId, currentGroup, onOpenNewTab, canCollapse, hotkeyNumbers, leaderActive = false, hotkeysEnabled = false }: SidebarProps): JSX.Element {
  const { state, config, runningTasks, instances, states, activeInstanceId, poppedOut, setActiveInstance, launcherUpdate, dshUpdate, webViewAlive, saveConfig } = useHarness()
  // 网页版免费对话(虚拟实例)列表:隐藏的不显示。
  const groupLinks = visibleLinksForGroup(currentGroup, config?.webChats ?? [])
  const webChats = groupLinks.all.filter((w) => !w.hidden)
  const activeWebChat = webChats.find((chat) => chat.id === activeWebChatId)
  // 安全监控:橙色/红色告警时在侧边栏底部弹窗提醒。
  const monitor = useSecurityMonitor()
  const { theme, toggleTheme } = useTheme()
  const { lang, t, setLang, statusLabel } = useI18n()
  const [bridgeStatus, setBridgeStatus] = useState<CookieBridgeState['status'] | null>(null)
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void api.bridgeGetState()
        .then((next) => { if (alive) setBridgeStatus(next.status) })
        .catch(() => { if (alive) setBridgeStatus('error') })
    }
    load()
    const timer = setInterval(load, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  // Hidden instances stay out of the sidebar — manage them from the Instances page.
  const visible = visibleInstancesForGroup(currentGroup, instances)

  const [deletedLink, setDeletedLink] = useState<{ link: WebChatConfig; index: number } | null>(null)
  const deleteToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const webChatsRef = useRef<WebChatConfig[]>(config?.webChats ?? [])
  useEffect(() => {
    webChatsRef.current = config?.webChats ?? []
  }, [config?.webChats])
  useEffect(() => () => {
    if (deleteToastTimer.current) clearTimeout(deleteToastTimer.current)
  }, [])
  const removeWebChat = async (link: WebChatConfig): Promise<void> => {
    const all = webChatsRef.current
    const index = all.findIndex((item) => item.id === link.id)
    if (index < 0) return
    const next = all.filter((item) => item.id !== link.id)
    webChatsRef.current = next
    await saveConfig({ webChats: next })
    if (activeWebChatId === link.id) {
      setView('dashboard')
      api.releaseWebChat(link.id)
    }
    setDeletedLink({ link, index })
    if (deleteToastTimer.current) clearTimeout(deleteToastTimer.current)
    deleteToastTimer.current = setTimeout(() => setDeletedLink(null), 5_000)
  }
  const undoDelete = async (): Promise<void> => {
    if (!deletedLink) return
    const all = webChatsRef.current.filter((item) => item.id !== deletedLink.link.id)
    const next = [...all]
    next.splice(Math.min(deletedLink.index, next.length), 0, deletedLink.link)
    webChatsRef.current = next
    await saveConfig({ webChats: next })
    if (deleteToastTimer.current) clearTimeout(deleteToastTimer.current)
    setDeletedLink(null)
  }

  // Clicking an instance row switches the active instance, and — when that
  // instance is up and not popped out — jumps straight to its DSH view without
  // changing the rail width. No view switch when it's not ready so we don't flash
  // the dashboard back over the stopped instance.
  const onInstanceClick = async (inst: DshInstance): Promise<void> => {
    await setActiveInstance(inst.id)
    const st = states[inst.id]?.status ?? 'stopped'
    if ((st === 'running' || st === 'external' || st === 'degraded') && !poppedOut[inst.id]) {
      // PowerShell 没有 Web 原生视图:进入控制台查看统一日志。
      if (inst.kind === 'ps') setView('dashboard')
      else setView(inst.kind === 'gui' ? 'gui' : 'dsh')
    } else if (view === 'web' || view === 'gui') {
      // 网页聊天/GUI 视图下点了非运行实例:切到实例管理页,关闭当前原生视图。
      setView('instances')
    }
  }

  // The DSH view is only reachable once the active instance's port is ready.
  const status = state?.status ?? 'stopped'
  const showStatus = status === 'error' || status === 'external' || status === 'degraded'

  const activeInstance = instances.find((inst) => inst.id === activeInstanceId)
  const items: { id: PageId; label: string; icon: JSX.Element; disabled?: boolean }[] = [
    { id: 'dashboard', label: t('nav.dashboard'), icon: <TerminalIcon /> },
    { id: 'instances', label: t('nav.instances'), icon: <ListIcon /> },
    { id: 'profiles', label: t('nav.profiles'), icon: <ProfileIcon /> },
    { id: 'plugins', label: t('nav.plugins'), icon: <PuzzleIcon /> },
    { id: 'security', label: t('nav.security'), icon: <ShieldIcon /> },
    { id: 'settings', label: t('nav.settings'), icon: <GearIcon /> }
  ]

  // Inside the DSH view with the rail collapsed, the whole menu tucks onto the
  // whale: only the whale shows, and clicking it expands the menu again.
  const nativeRail = canCollapse && (view === 'dsh' || view === 'gui') && collapsed
  const hidden = width <= 0

  return (
    <aside
      className="app-sidebar shrink-0 flex flex-col border-r overflow-hidden transition-[width] duration-150"
      data-collapsed={collapsed || undefined}
      style={{
        width,
        borderColor: hidden ? 'transparent' : 'var(--border)',
        // 背景交给 CSS(.app-sidebar):扁平模式 var(--panel),毛玻璃模式液态玻璃 + 主色光晕。
        // easeOutCubic — must match the DSH view animation in App.tsx so the
        // native view slides in step with the rail.
        transitionTimingFunction: 'cubic-bezier(0.215, 0.61, 0.355, 1)'
      }}
    >
      {/* Logo — the whale is the handle: click it to expand the collapsed DSH rail / collapse when open.
          The whale stays put (left-aligned) in both states so collapsing/expanding never makes it jump. */}
      <div className="flex items-center h-[58px] overflow-hidden shrink-0 gap-2.5 px-3.5">
        <button
          className="w-8 h-8 rounded-[10px] flex items-center justify-center overflow-hidden shrink-0 cursor-pointer select-none"
          style={{ background: '#fff', border: '1px solid rgba(128,128,128,0.25)' }}
          title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          aria-disabled={false}
          onClick={() => setCollapsed(!collapsed)}
        >
          <img src={whaleIcon} alt="" className="w-7 h-7 object-contain" draggable={false} />
        </button>
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-[14px] font-semibold leading-tight truncate">DSH Launcher</div>
            <div className="text-[11px] leading-tight" style={{ color: 'var(--muted)' }}>
              DeepSeek Harness
            </div>
          </div>
        )}
      </div>

      {nativeRail && (
        <div className="flex justify-center px-2 py-1">
          <button className="btn btn-primary !h-9 !w-9 !p-0" title={t('sidebar.newTab')} onClick={onOpenNewTab}>
            <PlusIcon />
          </button>
        </div>
      )}
      {/* Instances — click to switch which dsh the dashboard/DSH view shows.
          Each row carries a status dot so you can watch every instance at once. */}
      {!nativeRail && instances.length > 0 && (
        <div className={`min-h-0 flex-1 overflow-y-auto ${collapsed ? 'px-2 py-1 space-y-1.5' : 'px-2.5 pb-1 space-y-0.5'}`}>
          {!collapsed && (
            <div className="flex items-center justify-between px-2 pt-0.5 pb-1">
              <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
                {t('sidebar.instances')}
              </span>
              <div className="flex items-center gap-0.5">
                <button
                  className="btn btn-ghost btn-sm !p-1 disabled:cursor-not-allowed disabled:opacity-40"
                  title={t('sidebar.reloadCurrentPage')}
                  disabled={!activeWebChat || view !== 'web'}
                  onClick={() => { if (activeWebChat) onRefreshWebChat(activeWebChat) }}
                >
                  <RefreshIcon />
                </button>
                <button
                  className="btn btn-ghost btn-sm !p-1"
                  title={t('sidebar.newTab')}
                  onClick={onOpenNewTab}
                >
                  <PlusIcon />
                </button>
              </div>
            </div>
          )}
          <div className="space-y-0.5">
            {visible.map((inst) => {
              const st = states[inst.id]?.status ?? 'stopped'
              const pending = states[inst.id]?.pendingRestart === true
              // 网页版视图下只高亮网页版入口,不高亮活动实例(否则两个高亮)。
              const isActive = inst.id === activeInstanceId && view !== 'web'
              // A pending plugin change turns the dot yellow until the instance
              // is manually restarted (harness clears the flag when running).
              const color = pending ? 'var(--warn)' : (STATUS_COLOR[st] ?? STATUS_COLOR.stopped)
              const pulse = STATUS_PULSE[st] === true
              // Start/stop mirrors the Dashboard control: anything but a clean
              // idle/error shows stop (incl. starting/stopping/external).
              // error 也允许停止:异常报错但实例可能仍在运行,需要能点「停止」清理残留。
              const canStop = st !== 'stopped'
              const canOpenUi = st === 'running' || st === 'external' || st === 'degraded'
              // The instance toggles between running embedded in the launcher and
              // running in a separate (popped-out) child window.
              const popped = !!poppedOut[inst.id]
              const hotkeyDigit = hotkeysEnabled ? hotkeyNumbers?.instances[inst.id] : undefined
              return (
                <div
                  key={inst.id}
                  className="w-full flex items-center gap-1 rounded-lg"
                  style={{
                    justifyContent: collapsed ? 'center' : 'flex-start',
                    background: isActive ? 'var(--accent-soft)' : 'transparent'
                  }}
                >
                  <button
                    onClick={() => void onInstanceClick(inst)}
                    title={`${inst.name} · ${statusLabel(st)}${pending ? ' · ' + t('sidebar.pendingRestart') : ''}`}
                    className="min-w-0 flex-1 flex items-center gap-2 rounded-lg cursor-pointer select-none"
                    style={{
                      justifyContent: collapsed ? 'center' : 'flex-start',
                      padding: collapsed ? '6px' : '5px 8px',
                      color: isActive ? 'var(--accent)' : 'var(--text)'
                    }}
                  >
                    <span className="relative inline-flex shrink-0">
                      {(inst.icon || inst.iconColor || inst.iconChar) ? (
                        <GlyphTile
                          icon={inst.icon}
                          letter={inst.iconChar || inst.name}
                          color={inst.iconColor ?? fallbackColor(inst.name)}
                          size={28}
                          title={inst.name}
                        />
                      ) : (
                        <span
                          className={`badge-dot shrink-0${pulse ? ' pulse-live' : ''}`}
                          style={{ background: color }}
                        />
                      )}
                      {hotkeysEnabled && leaderActive && hotkeyDigit && <HotkeyBadge digit={hotkeyDigit} active />}
                    </span>
                    {!collapsed && <span className="truncate text-[17px]">{inst.name}</span>}
                    {!collapsed && pending && (
                      <span
                        className="badge shrink-0 !px-1.5 text-[10px]"
                        style={{ color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 16%, transparent)' }}
                      >
                        {t('sidebar.pendingRestart')}
                      </span>
                    )}
                  </button>
                  {!collapsed && (
                    <>
                      {/* Toggle the selected, running instance between embedded
                          and a launcher child window (drag it to another monitor).
                          Only visible for the selected instance while running. */}
                      {isActive && canOpenUi && inst.kind !== 'gui' && (
                        <button
                          className={`btn btn-sm !p-1 ${popped ? 'btn-primary' : 'btn-ghost'}`}
                          title={popped ? t('sidebar.returnIntegrated') : t('sidebar.openNewWindow')}
                          onClick={() => void (popped ? api.closeInstanceWindow(inst.id) : api.openInstanceWindow(inst.id))}
                        >
                          {popped ? <WindowReturnIcon /> : <NewWindowIcon />}
                        </button>
                      )}
                      <button
                        className="btn btn-ghost btn-sm !p-1"
                        title={canStop ? t('sidebar.stop') : t('sidebar.start')}
                        onClick={() => void (canStop ? api.stopInstance(inst.id) : api.startInstance(inst.id))}
                      >
                        {canStop ? <StopIcon /> : <PlayIcon />}
                      </button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
          {/* 虚拟实例(网页版免费对话)列表:与正常实例同格式,灰色区分;上方淡虚线分隔。
              主点击进入 'web' 视图(相当于 DSH 界面,不改变侧边栏折叠状态)。 */}
          {webChats.length > 0 && (
            <div className="mt-1 pt-1 border-t space-y-0.5" style={{ borderColor: 'color-mix(in srgb, var(--border) 55%, transparent)' }}>
              {webChats.map((wc) => {
                const active = view === 'web' && activeWebChatId === wc.id
                // 保活中(常驻视图还在,页面没被释放)= 绿点;未打开/已释放 = 灰点。
                const alive = webViewAlive.includes(wc.id)
                const hotkeyDigit = hotkeysEnabled ? hotkeyNumbers?.links[wc.id] : undefined
                return (
                  <div
                    key={wc.id}
                    className="group relative w-full flex flex-col rounded-lg"
                    style={{ background: active ? 'var(--accent-soft)' : 'transparent' }}
                  >
                    <div className="flex w-full items-center gap-1">
                      <button
                        onClick={() => onOpenWebChat(wc, false)}
                        onDoubleClick={() => onRefreshWebChat(wc)}
                        title={active ? t('sidebar.webChatDblClickRefresh') : wc.name}
                        className="min-w-0 flex-1 flex items-center gap-2 rounded-lg cursor-pointer select-none"
                        style={{
                          justifyContent: collapsed ? 'center' : 'flex-start',
                          padding: collapsed ? '6px' : '5px 8px',
                          color: active ? 'var(--accent)' : 'var(--muted)'
                        }}
                      >
                        <span className="relative shrink-0">
                          <GlyphTile
                            icon={wc.icon}
                            letter={wc.name}
                            color={wc.iconColor ?? fallbackColor(wc.name)}
                            size={28}
                            title={wc.name}
                          />
                          <span
                            className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border"
                            style={{ background: alive ? 'var(--ok)' : 'var(--muted)', borderColor: 'var(--panel)' }}
                          />
                          {hotkeysEnabled && leaderActive && hotkeyDigit && <HotkeyBadge digit={hotkeyDigit} active />}
                        </span>
                        {!collapsed && <span className="min-w-0 truncate text-[17px]">{wc.name}</span>}
                      </button>
                      {!collapsed && isGoogleAccountUrl(wc.url) && (
                        <button
                          className="shrink-0 btn btn-ghost btn-sm !px-1.5 !py-0.5 text-[9px]"
                          title={bridgeStatus === 'connected' ? t('sidebar.bridgeConnected') : t('sidebar.bridgeConnect')}
                          onClick={(event) => { event.stopPropagation(); setView('settings') }}
                          style={{ color: bridgeStatus === 'connected' ? 'var(--ok)' : 'var(--warn)' }}
                        >
                          {bridgeStatus === 'connected' ? t('sidebar.bridgeConnected') : t('sidebar.bridgeConnect')}
                        </button>
                      )}
                    </div>
                    {!collapsed && isGoogleAccountUrl(wc.url) && (
                      <div className="pb-1 pl-[42px] pr-2">
                        <span className="block whitespace-normal text-[9.5px] leading-tight" style={{ color: 'var(--warn)' }}>
                          {t('sidebar.googleLoginBridgeHint')}
                        </span>
                      </div>
                    )}
                    {!collapsed && (
                      <div className="absolute right-1 top-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <button
                          className="btn btn-ghost btn-sm !p-1"
                          title={s6s7Text(lang, 'deleteLink')}
                          onClick={(event) => {
                            event.stopPropagation()
                            void removeWebChat(wc)
                          }}
                        >
                          ✕
                        </button>
                        <button
                          className="btn btn-ghost btn-sm !p-1 text-[15px] leading-none"
                          title={t('sidebar.webChatRestoreUrl', { url: wc.url })}
                          onClick={(event) => {
                            event.stopPropagation()
                            onResetWebChatUrl(wc)
                          }}
                        >
                          ↩
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Nav — icon-only thumbnails when the DSH rail is collapsed; clicking a
          thumbnail expands the menu and jumps to that page. */}
      <nav className="shrink-0 px-2.5 py-2 space-y-1">
        {items.map((item) => {
          const active = view === item.id
          return (
            <button
              key={item.id}
              disabled={item.disabled}
              onClick={() => {
                if (nativeRail) setCollapsed(false)
                setView(item.id)
              }}
              title={collapsed ? item.label : undefined}
              className="nav-item w-full flex items-center gap-3 px-3 py-2.5 rounded-[9px] text-[13px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              data-active={active}
              style={{
                color: active ? 'var(--accent)' : 'var(--text)',
                // 背景交给 CSS:.nav-item[data-active] 扁平用 accent-soft,毛玻璃用液态玻璃卡片。
                justifyContent: collapsed ? 'center' : 'flex-start',
                paddingLeft: collapsed ? 0 : 12,
                paddingRight: collapsed ? 0 : 12
              }}
            >
              {/* 展开:超大图标作背景,被圆角边框裁剪露一角 */}
              {!collapsed && (
                <span className="nav-bg-icon" style={{ color: active ? 'var(--accent)' : 'var(--muted)' }}>{item.icon}</span>
              )}
              {collapsed ? (
                /* 收起:居中图标 */
                <span className="nav-icon-center relative" style={{ color: active ? 'var(--accent)' : 'var(--muted)' }}>{item.icon}</span>
              ) : (
                /* 展开:标签文字盖在大图标之上 */
                <span className="truncate">{item.label}</span>
              )}
            </button>
          )
        })}
      </nav>

      {/* Footer — hidden in the DSH rail */}
      {!nativeRail && (
      <div className="sticky bottom-0 z-20 shrink-0 space-y-2 border-t px-3 py-3" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
        {/* 安全告警弹窗:橙色(高度疑似)/红色(已泄露)时提醒 */}
        {monitor.level >= 2 && (
          <div
            className="rounded-lg px-3 py-2 text-[12px] font-semibold leading-snug select-none cursor-pointer"
            style={{
              color: '#fff',
              background: `linear-gradient(135deg, ${RISK_LEVELS[monitor.level].color}, ${RISK_LEVELS[monitor.level].color}cc)`,
              boxShadow: `0 0 14px ${RISK_LEVELS[monitor.level].color}99`,
              animation: 'security-alert-pulse 2s ease-in-out infinite'
            }}
            title={t('sidebar.securityAlertHint')}
            onClick={() => setView('security')}
          >
            ⚠ {t(RISK_LEVELS[monitor.level].label)} · {t('sidebar.securityAlert', { n: monitor.count })}
          </div>
        )}
        {/* 提示式更新:检测到 DSH-Launcher 新版本时提示,点击打开 GitHub Release 下载页 */}
        {launcherUpdate?.update && launcherUpdate.url && (
          <a
            href={launcherUpdate.url}
            target="_blank"
            rel="noreferrer"
            className="block rounded-lg px-3 py-2 text-[12px] font-medium leading-snug cursor-pointer select-none"
            style={{ color: 'var(--accent)', background: 'var(--accent-soft)', border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)' }}
            title={t('sidebar.launcherUpdateHint')}
          >
            ↑ {t('sidebar.launcherUpdate', { latest: launcherUpdate.latest ?? '' })}
          </a>
        )}
        {runningTasks.length > 0 && (
          <div
            className="text-[11px] mono text-center"
            style={{ color: 'var(--accent)' }}
            title={t('sidebar.tasksRunning', { count: runningTasks.length })}
          >
            ⚙{runningTasks.length}
          </div>
        )}
        {showStatus && (
          <div className="flex items-center justify-center">
            <StatusPill status={state?.status} compact={collapsed} />
          </div>
        )}
        <div className="grid grid-cols-3 gap-1">
          <button className="btn btn-primary flex-col gap-0.5 !px-1 !py-1.5" title={s6s7Text(lang, 'new')} onClick={onOpenNewTab}>
            <PlusIcon />
            {!collapsed && <span className="text-[10px]">{s6s7Text(lang, 'new')}</span>}
          </button>
          <button className="btn btn-ghost flex-col gap-0.5 !px-1 !py-1.5" title={s6s7Text(lang, 'history')} onClick={() => setView('history')}>
            <ListIcon />
            {!collapsed && <span className="text-[10px]">{s6s7Text(lang, 'history')}</span>}
          </button>
          <button className="btn btn-ghost flex-col gap-0.5 !px-1 !py-1.5" title={s6s7Text(lang, 'downloads')} onClick={() => setView('downloads')}>
            <DownloadIcon />
            {!collapsed && <span className="text-[10px]">{s6s7Text(lang, 'downloads')}</span>}
          </button>
        </div>
        <div className={`flex items-center justify-center gap-1 pt-0.5 ${collapsed ? 'flex-col' : ''}`}>
          <button className="btn btn-ghost btn-sm !p-1.5" title={theme === 'dark' ? t('sidebar.switchLight') : t('sidebar.switchDark')} onClick={toggleTheme}>
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
          <button
            className="btn btn-ghost btn-sm !p-1.5"
            title={t('sidebar.switchLang')}
            onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
          >
            {lang === 'zh' ? 'EN' : '中'}
          </button>
          {canCollapse && (
            <button
              className="btn btn-ghost btn-sm !p-1.5"
              title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
              onClick={() => setCollapsed(!collapsed)}
            >
              <ChevronIcon dir={collapsed ? 'right' : 'left'} />
            </button>
          )}
        </div>
        {!collapsed && (
          <div className="text-[11px] text-center" style={{ color: 'var(--muted)' }}>
            profile <span className="mono">{config?.profile ?? 'web'}</span> {t('sidebar.portLabel')} {config?.port ?? 3080}
          </div>
        )}
      </div>
      )}

      {deletedLink && !collapsed && (
        <div className="fixed bottom-20 left-1/2 z-[80] flex -translate-x-1/2 items-center gap-3 rounded-xl border px-4 py-2.5 text-[12px] shadow-xl" style={{ borderColor: 'var(--border)', background: 'var(--panel)', color: 'var(--text)' }}>
          <span>{s6s7Text(lang, 'deletedLink', { name: deletedLink.link.name })}</span>
          <button className="font-semibold" style={{ color: 'var(--accent)' }} onClick={() => void undoDelete()}>{s6s7Text(lang, 'undo')}</button>
        </div>
      )}
    </aside>
  )
}
