import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as balance from './balance'
import * as browserGuard from './browser-guard'
import * as cookieBridge from './bridge'
import { broadcast } from './bus'
import { normalizeCookieBridgeConfig, type CookieBridgeConfigPatch } from '../shared/bridge'
import { getConfig, setConfig } from './config'
import { scanChromeProfiles } from './chrome-profile-scan'
import { t } from './i18n'
import * as dshview from './dshview'
import * as downloads from './downloads'
import * as performance from './performance'
import { resolveLinkFavicon } from './favicon'
import * as guiDiscovery from './gui-discovery'
import { isGuiExecutableAvailable, resolveGuiExecutable } from './gui-path-repair'
import * as guiView from './gui-view'
import { findGuiIcon, guiIconIdForExecutable, type GuiIconId } from './gui-icons'
import {
  emptyGuiDiscoverySnapshot,
  readGuiDiscoveryCacheFile,
  shouldBackgroundRefresh,
  writeGuiDiscoveryCacheFile
} from './gui-discovery-cache'
import * as harness from './harness'
import { applyHotkeyConfig } from './hotkeys'
import * as instances from './instances'
import * as orb from './orb'
import * as market from './market'
import * as plugins from './plugins'
import * as runtime from './runtime'
import * as instanceRuntime from './instance-runtime'
import { acquireRuntimeWrite, runtimeWriteInProgress } from './runtime-activity'
import { isDshInstance, normalizeRuntimeVersion } from '../shared/runtime-version'
import * as popup from './popup'
import * as security from './security'
import type {
  DshInstance,
  GuiAppDiscoverySnapshot,
  GuiExecutableRepairResult,
  GuiAppPreset,
  LauncherConfig,
  MarketSourceId,
  NewInstanceInput,
  PluginMeta
} from '../shared/types'

/** Broadcast the instance list so the renderer and tray light stay in sync. */
function broadcastInstances(): void {
  const cfg = getConfig()
  broadcast({ type: 'instances', instances: cfg.instances, activeInstanceId: cfg.activeInstanceId })
}

const LAUNCH_FIELDS: Array<keyof DshInstance> = ['runtimeVersion', 'port', 'profile', 'kind', 'command', 'exe', 'args', 'workspace', 'dshHome']

function assertInstanceEdit(id: string, patch: Partial<DshInstance>): void {
  const before = instances.getInstance(id)
  if (!before) return
  if (!LAUNCH_FIELDS.some(key => key in patch && (key === 'runtimeVersion'
    ? normalizeRuntimeVersion(before.runtimeVersion) !== normalizeRuntimeVersion(patch.runtimeVersion)
    : JSON.stringify(before[key]) !== JSON.stringify(patch[key])))) return
  if (runtimeWriteInProgress(id) || harness.instanceHasProcess(id) || harness.getState(id).status === 'external') {
    throw new Error(t('请先停止实例并等待安装结束，再修改启动设置。', 'Stop the instance and wait for installation before changing launch settings.'))
  }
  const release = acquireRuntimeWrite(id)
  release()
}

/** Resolve bundled preset icons both in dev and packaged extraResources. */
function guiPresetIcon(id: GuiIconId): string | undefined {
  return findGuiIcon(id, [process.resourcesPath, app.getAppPath()])
}

let guiDiscoverySnapshot: GuiAppDiscoverySnapshot | null = null
let guiDiscoveryCacheLoad: Promise<GuiAppDiscoverySnapshot | null> | null = null
let guiDiscoveryInFlight: Promise<GuiAppDiscoverySnapshot> | null = null

function guiDiscoveryCachePath(): string {
  return join(app.getPath('userData'), 'gui-discovery-cache.json')
}

function attachGuiPresetIcons(presets: GuiAppPreset[]): GuiAppPreset[] {
  return presets.map((preset) => ({ ...preset, icon: guiPresetIcon(preset.id) }))
}

async function loadGuiDiscoveryCache(): Promise<GuiAppDiscoverySnapshot | null> {
  if (!guiDiscoveryCacheLoad) {
    guiDiscoveryCacheLoad = (async () => {
      const loaded = await readGuiDiscoveryCacheFile(guiDiscoveryCachePath())
      if (loaded) {
        guiDiscoverySnapshot = { ...loaded, presets: attachGuiPresetIcons(loaded.presets) }
        console.info(
          `[gui-discovery] cache hit age=${Math.max(0, Date.now() - (loaded.updatedAt ?? 0))}ms presets=${loaded.presets.length}`
        )
      } else {
        console.info('[gui-discovery] cache miss')
      }
      return guiDiscoverySnapshot
    })()
  }
  await guiDiscoveryCacheLoad
  return guiDiscoverySnapshot
}

async function saveGuiDiscoveryCache(snapshot: GuiAppDiscoverySnapshot): Promise<void> {
  try {
    await writeGuiDiscoveryCacheFile(guiDiscoveryCachePath(), snapshot)
  } catch (error) {
    console.warn(`[gui-discovery] cache write failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Start one deduplicated discovery pass. Never blocks the caller. */
async function refreshGuiDiscovery(force = false): Promise<GuiAppDiscoverySnapshot> {
  if (guiDiscoveryInFlight) return guiDiscoveryInFlight

  const pending = (async () => {
    const cached = await loadGuiDiscoveryCache()
    if (!force && cached && !shouldBackgroundRefresh(cached)) return cached

    const started = Date.now()
    console.info(`[gui-discovery] refresh start force=${force} cached=${cached ? 'yes' : 'no'}`)
    try {
      const result = await guiDiscovery.discoverGuiApps()
      const snapshot: GuiAppDiscoverySnapshot = {
        presets: attachGuiPresetIcons(result.presets),
        cached: false,
        refreshing: false,
        timedOut: result.timedOut,
        error: result.error ?? null,
        updatedAt: Date.now(),
        timings: result.timings
      }
      guiDiscoverySnapshot = snapshot
      await saveGuiDiscoveryCache(snapshot)
      broadcast({ type: 'gui-discovery', snapshot })
      console.info(
        `[gui-discovery] refresh done ${Date.now() - started}ms presets=${snapshot.presets.length} timedOut=${snapshot.timedOut}`
      )
      return snapshot
    } catch (error) {
      const snapshot: GuiAppDiscoverySnapshot = {
        ...(cached ?? emptyGuiDiscoverySnapshot()),
        cached: Boolean(cached),
        refreshing: false,
        error: error instanceof Error ? error.message : String(error)
      }
      guiDiscoverySnapshot = snapshot
      broadcast({ type: 'gui-discovery', snapshot })
      console.warn(`[gui-discovery] refresh failed: ${snapshot.error}`)
      return snapshot
    }
  })()

  guiDiscoveryInFlight = pending
  try {
    return await pending
  } finally {
    if (guiDiscoveryInFlight === pending) guiDiscoveryInFlight = null
  }
}

/** Return cached data immediately, then refresh it in the background. */
async function getGuiDiscoverySnapshot(): Promise<GuiAppDiscoverySnapshot> {
  const cached = await loadGuiDiscoveryCache()
  if (!cached) {
    void refreshGuiDiscovery(false)
    return emptyGuiDiscoverySnapshot(true)
  }
  const refreshing = shouldBackgroundRefresh(cached) || guiDiscoveryInFlight !== null
  if (shouldBackgroundRefresh(cached)) void refreshGuiDiscovery(false)
  return { ...cached, cached: true, refreshing }
}

/** Prewarm discovery after the launcher window exists, without delaying it. */
function warmGuiDiscoveryAtStartup(): void {
  void (async () => {
    const cached = await loadGuiDiscoveryCache()
    const age = cached?.updatedAt === null || !cached ? 'none' : `${Math.max(0, Date.now() - cached.updatedAt)}ms`
    console.info(`[gui-discovery] startup cache age=${age}`)
    if (!cached || shouldBackgroundRefresh(cached)) await refreshGuiDiscovery(false)
  })()
}

/** Ensure every newly-created GUI instance records an icon path. */
async function enrichGuiInstanceIcon(input: NewInstanceInput): Promise<NewInstanceInput> {
  if (input.kind !== 'gui' || !input.exe || input.icon || input.iconLocked) return input
  const iconId = guiIconIdForExecutable(input.exe)
  const bundled = iconId ? guiPresetIcon(iconId) : undefined
  if (bundled) return { ...input, icon: bundled, iconLocked: false }
  try {
    const image = await app.getFileIcon(input.exe, { size: 'large' })
    if (image.isEmpty()) return input
    const dir = join(app.getPath('userData'), 'instance-icons')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `${Date.now().toString(36)}.png`)
    writeFileSync(target, image.toPNG())
    return { ...input, icon: target, iconLocked: false }
  } catch {
    return input
  }
}

export function registerIpc(): void {
  ipcMain.handle('state:get', () => ({
    states: harness.getAllStates(),
    logs: harness.getAllLogs(),
    config: getConfig(),
    // 当前 dsh 版本(内置运行时;源码模式为 null,渲染层据此显示版本或「源码版」)。
    dshVersion: runtime.currentDshVersion()
  }))

  ipcMain.handle('logs:clear', () => {
    harness.clearAllLogs()
    return true
  })

  // 原生 window.confirm 在 Electron 中会阻塞渲染进程并夺走焦点/IME,关闭后输入框
  // 无法正常聚焦输入。改用 main 进程的 native dialog(不阻塞、无焦点问题)。
  ipcMain.handle('confirm', async (_e, message: string) => {
    return guiView.withGuiViewPaused(async () => {
      const win = BrowserWindow.getFocusedWindow()
      const opts = {
        type: 'question' as const,
        buttons: [t('取消', 'Cancel'), t('确定', 'OK')],
        defaultId: 1,
        cancelId: 0,
        message: String(message)
      }
      const r = win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, opts)
        : await dialog.showMessageBox(opts)
      // 恢复窗口焦点:原生对话框关闭后会夺走窗口焦点,导致之后所有输入框/下拉无法互动
      // (只能靠切换窗口恢复)。关闭后把焦点还给主窗口。
      if (win && !win.isDestroyed()) win.focus()
      return r.response === 1
    })
  })

  // --- instance lifecycle ---
  ipcMain.handle('harness:start', (_e, instanceId: string) => harness.startInstance(String(instanceId)))
  ipcMain.handle('harness:stop', (_e, instanceId: string) => harness.stopInstance(String(instanceId)))
  ipcMain.handle('harness:restart', (_e, instanceId: string) => harness.restartInstance(String(instanceId)))
  ipcMain.handle('harness:stopAll', () => harness.stopAllInstances())
  ipcMain.handle('harness:detach', (_e, instanceId: string) => harness.detachInstanceKeepAlive(String(instanceId)))
  ipcMain.handle('harness:adopt', (_e, instanceId: string) => harness.adoptExistingGuiInstance(String(instanceId)))
  ipcMain.handle('harness:openUi', (_e, instanceId: string) => {
    // Renderer calls with no argument to open whatever is active.
    const id = String(instanceId || instances.getActiveInstance().id)
    // GUI instances have no web URL; their native window is opened from the sidebar.
    if (instances.getInstance(id)?.kind === 'gui') return false
    const port = harness.getState(id).port
    if (port <= 0) return false
    // 记录「用户手动打开」:浏览器守卫会跳过该端口,不会自动关闭它。
    browserGuard.markUserOpened(port)
    return shell.openExternal(`http://127.0.0.1:${port}`)
  })
  ipcMain.handle('harness:openInstanceWindow', (_e, instanceId: string) => {
    // Open (or focus) the instance's DSH UI in a launcher child window.
    popup.openInstanceWindow(String(instanceId || instances.getActiveInstance().id))
    return true
  })
  ipcMain.handle('harness:closeInstanceWindow', (_e, instanceId: string) => {
    // Close the instance's separate window, returning it to the embedded view.
    popup.closeInstanceWindow(String(instanceId || instances.getActiveInstance().id))
    return true
  })

  // --- instance management ---
  ipcMain.handle('instances:setActive', (_e, id: string) => {
    const cfg = instances.setActiveInstance(String(id))
    broadcastInstances()
    return cfg
  })
  ipcMain.handle('gui:pickExecutable', async () => {
    return guiView.withGuiViewPaused(async () => {
      const win = BrowserWindow.getFocusedWindow()
      const options: Electron.OpenDialogOptions = {
        title: t('选择桌面应用', 'Choose a desktop app'),
        properties: ['openFile'],
        filters: [{ name: 'Programs (*.exe)', extensions: ['exe'] }]
      }
      const result = win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    })
  })
  ipcMain.handle('gui:discoverApps', () => getGuiDiscoverySnapshot())
  ipcMain.handle('gui:refreshDiscovery', () => refreshGuiDiscovery(true))

  ipcMain.handle('instances:checkGuiExecutable', (_e, instanceId: string) => {
    const inst = instances.getInstance(String(instanceId))
    if (!inst || inst.kind !== 'gui' || !inst.exe) return { exe: inst?.exe ?? '', available: false }
    return { exe: inst.exe, available: isGuiExecutableAvailable(inst.exe) }
  })
  ipcMain.handle('instances:repairExecutable', async (_e, instanceId: string): Promise<GuiExecutableRepairResult> => {
    const inst = instances.getInstance(String(instanceId))
    if (!inst || inst.kind !== 'gui' || !inst.exe) {
      return { ok: false, oldExe: inst?.exe ?? '', newExe: null, error: 'GUI instance not found' }
    }
    const repaired = await resolveGuiExecutable(
      { exe: inst.exe, guiPresetId: inst.guiPresetId },
      () => guiDiscovery.discoverGuiApps()
    )
    if (!repaired.newExe) {
      return { ok: false, oldExe: repaired.oldExe, newExe: null, error: 'No replacement executable found' }
    }
    instances.updateInstance(inst.id, {
      exe: repaired.newExe,
      ...(repaired.presetId ? { guiPresetId: repaired.presetId } : {})
    })
    broadcastInstances()
    return { ok: true, oldExe: repaired.oldExe, newExe: repaired.newExe, presetId: repaired.presetId }
  })
  ipcMain.handle('instances:add', async (_e, input: NewInstanceInput) => {
    const cfg = await instances.addInstance(await enrichGuiInstanceIcon(input))
    broadcastInstances()
    return cfg
  })
  ipcMain.handle('instances:update', (_e, id: string, patch: Partial<DshInstance>) => {
    assertInstanceEdit(String(id), patch)
    const before = getConfig().instances.find((instance) => instance.id === String(id))
    const cfg = instances.updateInstance(String(id), patch)
    if (Object.prototype.hasOwnProperty.call(patch, 'profileId') && before?.profileId !== cfg.instances.find((instance) => instance.id === String(id))?.profileId) {
      dshview.removeDshView(String(id))
    }
    broadcastInstances()
    return cfg
  })
  ipcMain.handle('instances:remove', async (_e, id: string) => {
    if (runtimeWriteInProgress(String(id))) throw new Error('请等待运行环境安装结束 / Wait for the runtime installation')
    await harness.stopInstance(String(id))
    if (harness.instanceHasProcess(String(id))) throw new Error('实例仍在运行，未删除 / Instance is still running; not removed')
    const cfg = await instances.removeInstance(String(id))
    // 同时清理该实例的嵌入式视图(隐藏的 WebContents 泄漏)。
    dshview.removeDshView(String(id))
    broadcastInstances()
    return cfg
  })

  ipcMain.handle('links:favicon', (_e, url: string) => resolveLinkFavicon(String(url)))
  ipcMain.handle('downloads:list', () => downloads.listDownloads())
  ipcMain.handle('downloads:clear', () => downloads.clearDownloads())
  ipcMain.handle('downloads:reveal', (_e, id: string) => downloads.revealDownload(String(id)))
  ipcMain.handle('downloads:openFolder', () => downloads.openDownloadsFolder())
  ipcMain.handle('perf:setActive', (_e, active: boolean) => performance.setPerformanceActive(Boolean(active)))
  ipcMain.handle('perf:get', () => performance.getPerformanceSnapshot())
  ipcMain.handle('config:get', () => getConfig())
  ipcMain.handle('profiles:scanChrome', () => scanChromeProfiles())
  ipcMain.handle('config:set', (_e, patch: Partial<LauncherConfig>) => {
    const before = getConfig()
    if (patch.profile !== undefined || patch.port !== undefined) {
      assertInstanceEdit(before.activeInstanceId, {
        ...(patch.profile !== undefined ? { profile: patch.profile } : {}),
        ...(patch.port !== undefined ? { port: patch.port } : {})
      })
    }
    if (patch.instances) {
      for (const next of patch.instances) assertInstanceEdit(next.id, next)
      for (const prev of before.instances) {
        if (!patch.instances.some(next => next.id === prev.id) && (harness.instanceHasProcess(prev.id) || runtimeWriteInProgress(prev.id))) {
          throw new Error('不能移除正在运行或安装的实例 / Cannot remove a running or installing instance')
        }
      }
    }
    const runtimeFields: Array<keyof LauncherConfig> = ['runtimeRoot', 'installMode', 'nodePath', 'harnessRepo', 'launchArgs', 'pnpm', 'dshHome']
    if (runtimeFields.some(key => key in patch && JSON.stringify(patch[key]) !== JSON.stringify(before[key]))) {
      const release = acquireRuntimeWrite()
      try {
        if (before.instances.some(inst => isDshInstance(inst) && harness.instanceHasProcess(inst.id))) {
          throw new Error('请先停止 DSH 实例再修改全局运行环境 / Stop DSH before changing the shared runtime')
        }
      } finally { release() }
    }
    const cfg = setConfig(patch)
    if (patch.instances) {
      for (const instance of cfg.instances) {
        const previous = before.instances.find((item) => item.id === instance.id)
        if (previous && previous.profileId !== instance.profileId) dshview.removeDshView(instance.id)
      }
    }
    if (patch.webChats) {
      for (const chat of cfg.webChats ?? []) {
        const previous = before.webChats?.find((item) => item.id === chat.id)
        if (previous && previous.profileId !== chat.profileId) dshview.releaseWebChat(chat.id)
      }
    }
    if (patch.hotkeys) applyHotkeyConfig(cfg.hotkeys)
    if (patch.instances || patch.activeInstanceId) broadcastInstances()
    return cfg
  })

  // --- local Chrome cookie bridge ---
  ipcMain.handle('bridge:getState', () => cookieBridge.getCookieBridgeState())
  ipcMain.handle('bridge:setConfig', async (_e, patch: CookieBridgeConfigPatch) => {
    const current = getConfig().cookieBridge
    const next = normalizeCookieBridgeConfig({ ...current, ...patch })
    setConfig({ cookieBridge: next })
    return cookieBridge.updateCookieBridgeConfig(next)
  })
  ipcMain.handle('bridge:regenerateToken', async () => {
    const state = await cookieBridge.regenerateCookieBridgeToken()
    setConfig({ cookieBridge: normalizeCookieBridgeConfig(state.config) })
    return state
  })
  // --- plugins (scoped to one instance's profile) ---
  ipcMain.handle('plugins:list', () => plugins.listPlugins())
  ipcMain.handle('plugins:listMatrix', () => plugins.listPluginMatrix())
  ipcMain.handle('plugins:setMeta', (_e, name: string, meta: PluginMeta) => {
    plugins.setPluginMeta(String(name), meta)
    return true
  })

  /** 实例的 { home, profile }:独立 home(inst.dshHome)或共享 home;兜底取配置镜像。 */
  const profileFor = (instanceId: string): { home: string; profile: string } => {
    const inst = instances.getInstance(String(instanceId))
    if (inst) return { home: instances.instanceDshHome(inst), profile: inst.profile }
    const cfg = getConfig()
    return { home: cfg.dshHome, profile: cfg.profile }
  }

  // A plugin-set change (install / remove / toggle) only takes effect once dsh
  // re-reads its profile manifest on next boot. We do NOT auto-restart: instead
  // the affected running instances are marked as awaiting a manual restart (the
  // sidebar shows them yellow with a "plugin changes" hint). Skipped when the
  // instance isn't running — the change is simply picked up on next start.
  const markPendingRestart = (instanceId: string, applied: boolean): void => {
    if (!applied || !instanceId) return
    harness.markPendingRestart(String(instanceId))
  }

  ipcMain.handle('plugins:install', async (_e, instanceId: string, spec: string, name?: string) => {
    // 写操作前兜底确保 home 物理存在(独立 home 被外部删除时重建空目录,避免神秘报错)
    const inst = instances.getInstance(String(instanceId))
    if (inst) instances.ensureInstanceHome(inst)
    const { home, profile } = profileFor(String(instanceId))
    const r = await plugins.install(home, profile, String(spec), name == null ? undefined : String(name))
    markPendingRestart(String(instanceId), r.ok)
    return r
  })
  ipcMain.handle('plugins:disable', async (_e, instanceId: string, name: string) => {
    const { home, profile } = profileFor(String(instanceId))
    const r = await plugins.disable(home, profile, String(name))
    markPendingRestart(String(instanceId), r.ok)
    return r
  })
  ipcMain.handle('plugins:enable', async (_e, instanceId: string, name: string) => {
    const { home, profile } = profileFor(String(instanceId))
    const r = await plugins.enable(home, profile, String(name))
    markPendingRestart(String(instanceId), r.ok)
    return r
  })
  ipcMain.handle('plugins:uninstall', async (_e, instanceId: string, name: string) => {
    const { home, profile } = profileFor(String(instanceId))
    const r = await plugins.uninstall(home, profile, String(name))
    markPendingRestart(String(instanceId), r.ok)
    return r
  })
  ipcMain.handle('plugins:update', async (_e, instanceId: string, name: string) => {
    const { home, profile } = profileFor(String(instanceId))
    const r = await plugins.update(home, profile, String(name))
    markPendingRestart(String(instanceId), r.ok)
    return r
  })
  // 本地持有插件的更新(按仓库):卸载全部实例 + GitHub 拉最新 + 重装。
  ipcMain.handle('plugins:updateLocal', async (_e, localPath: string) => plugins.updateLocalPlugin(String(localPath)))
  ipcMain.handle('plugins:removeFromLibrary', async (_e, name: string) => {
    const r = await plugins.removeFromLibrary(String(name))
    for (const id of r.affected ?? []) harness.markPendingRestart(id)
    return r
  })
  ipcMain.handle('plugins:removeFromLibraryMany', async (_e, names: string[]) => {
    const list = (Array.isArray(names) ? names : []).map(String)
    const r = await plugins.removeFromLibraryMany(list)
    for (const id of r.affected ?? []) harness.markPendingRestart(id)
    return r
  })
  // 一个本地库仓库可能含多个插件(monorepo/合集):删除时前端先问仓库归属,
  // 由用户选择「仅删此插件」或「整仓删除」。
  ipcMain.handle('plugins:libraryRepo', (_e, name: string) => plugins.libraryRepoInfo(String(name)))
  ipcMain.handle('plugins:repoRemove', async (_e, name: string) => {
    const r = await plugins.removeRepoFromLibrary(String(name))
    for (const id of r.affected ?? []) harness.markPendingRestart(id)
    return r
  })
  ipcMain.handle('bundles:list', async () => plugins.fetchRemoteBundles())
  ipcMain.handle('bundles:install', (_e, bundleId: string, options?: { retrySpecs?: string[]; homeMode?: 'shared' | 'isolated'; home?: string }) => {
    const o = options ?? {}
    return plugins.installBundle(String(bundleId), {
      ...(Array.isArray(o.retrySpecs) ? { retrySpecs: o.retrySpecs.map(String) } : {}),
      ...(o.homeMode === 'shared' || o.homeMode === 'isolated'
        ? { homeMode: o.homeMode, home: o.homeMode === 'shared' ? String(o.home ?? '') : undefined }
        : {})
    })
  })

  ipcMain.handle('build:repair', () => busyGuard(plugins.repairDeps, true)())
  ipcMain.handle('build:rebuild', () => busyGuard(plugins.rebuild, true)())
  ipcMain.handle('download:harness', () => busyGuard(plugins.downloadHarness, true)())
  // Download to the shared library only — no install, no enable, no restart.
  ipcMain.handle('download:plugin', async (_e, url: string, subdir?: string, instanceId?: string) => {
    return plugins.downloadPlugin(String(url), subdir == null ? undefined : String(subdir), profileFor(String(instanceId)).profile)
  })

  // Install/upgrade of the portable runtime must not race a running harness
  // (npm writes the files the bundled dsh is executing).
  const busyGuard = (fn: () => Promise<{ ok: boolean }>, sharedOnly = false): (() => Promise<{ ok: boolean; code: number | null; error?: string }>) => {
    return async () => {
      let release: (() => void) | undefined
      try {
        release = acquireRuntimeWrite()
        const anyRunning = Object.entries(harness.getAllStates()).some(([id, state]) => {
          const inst = instances.getInstance(id)
          if (!inst || !isDshInstance(inst) || (sharedOnly && inst.runtimeVersion)) return false
          return harness.instanceHasProcess(id) || ['running', 'starting', 'stopping', 'external', 'degraded'].includes(state.status)
        })
        if (anyRunning) {
          return { ok: false, code: null, error: t('请先停止使用该运行环境的 DSH 实例。', 'Stop DSH instances using this runtime first.') }
        }
        return (await fn()) as { ok: boolean; code: number | null; error?: string }
      } catch (error) {
        return { ok: false, code: 1, error: error instanceof Error ? error.message : String(error) }
      } finally { release?.() }
    }
  }
  ipcMain.handle('runtime:versions', () => instanceRuntime.listDshRuntimeVersions())
  ipcMain.handle('runtime:instanceInfo', (_e, id: string) => {
    const inst = instances.getInstance(String(id))
    if (!inst || !isDshInstance(inst)) throw new Error('DSH 实例不存在 / DSH instance not found')
    return instanceRuntime.getInstanceRuntimeInfo(inst)
  })
  ipcMain.handle('runtime:instanceInstall', async (_e, id: string) => {
    let release: (() => void) | undefined
    try {
      const inst = instances.getInstance(String(id))
      if (!inst) throw new Error('实例不存在 / Instance not found')
      release = acquireRuntimeWrite(inst.id)
      if (harness.instanceHasProcess(inst.id) || ['external', 'starting', 'stopping', 'running', 'degraded'].includes(harness.getState(inst.id).status)) {
        throw new Error('请先停止该实例再安装运行版本 / Stop this instance before installing its runtime')
      }
      return await instanceRuntime.installInstanceRuntime(inst)
    } catch (error) {
      return { ok: false, code: 1, error: error instanceof Error ? error.message : String(error) }
    } finally { release?.() }
  })
  ipcMain.handle('runtime:install', busyGuard(runtime.installRuntime))
  ipcMain.handle('runtime:update', busyGuard(runtime.updateRuntime, true))

  ipcMain.handle('balance:get', () => balance.getBalance())

  // Security: read the dsh-audit probe's audit events + manage security settings.
  ipcMain.handle('security:list', () => security.listAuditEvents())
  ipcMain.handle('security:clearAudit', () => security.clearAudit())
  ipcMain.handle('security:exportAudit', () => security.exportAudit())
  ipcMain.handle('security:getWhitelist', () => security.getWhitelist())
  ipcMain.handle('security:openWhitelistFile', () => security.openWhitelistFile())
  ipcMain.handle('security:getConfig', () => security.getSecurityConfig())
  ipcMain.handle('security:setConfig', (_e, patch: unknown) => security.setSecurityConfig((patch ?? {}) as Partial<security.SecurityConfig>))
  // 探针管理:每个实例检测/安装/开关。
  ipcMain.handle('security:listProbeStatus', () => security.listProbeStatus())
  ipcMain.handle('security:installProbe', (_e, instanceId: string) => security.installProbe(String(instanceId)))
  ipcMain.handle('security:removeProbe', (_e, instanceId: string) => security.removeProbe(String(instanceId)))
  ipcMain.handle('security:reinstallProbe', (_e, instanceId: string) => security.reinstallProbe(String(instanceId)))

  // Plugin market (GitHub search, unauthenticated).
  ipcMain.handle('market:search', (_e, sourceId: string, page: number, query?: string, categoryId?: string, force?: boolean) =>
    market.searchMarket((sourceId as MarketSourceId) || 'github', page, query, categoryId, Boolean(force)))
  ipcMain.handle('market:readme', (_e, owner: string, repo: string) => market.fetchReadme(String(owner), String(repo)))

  // External links inside the market README: confirm with a native dialog, then
  // open via the system browser. Never navigates the launcher window itself.
  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    const u = String(url ?? '')
    if (!/^(https?:|mailto:)/i.test(u)) return false
    const win = BrowserWindow.getFocusedWindow()
    const { response } = await guiView.withGuiViewPaused(() => (win && !win.isDestroyed()
      ? dialog.showMessageBox(win, {
        type: 'question',
        buttons: [t('打开', 'Open'), t('取消', 'Cancel')],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        message: t('用浏览器打开外部链接?', 'Open external link in browser?'),
        detail: u
      })
      : dialog.showMessageBox({
        type: 'question',
        buttons: [t('打开', 'Open'), t('取消', 'Cancel')],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        message: t('用浏览器打开外部链接?', 'Open external link in browser?'),
        detail: u
      })))
    if (win && !win.isDestroyed()) win.focus()
    if (response !== 0) return false
    await shell.openExternal(u)
    return true
  })

  // Embedded DSH view (native WebContentsView) — bounds follow the sidebar.
  ipcMain.on('dsh:set-active', (_e, instanceId: string, active: boolean, reload?: boolean) =>
    dshview.setDshActive(String(instanceId), Boolean(active), Boolean(reload))
  )
  ipcMain.on('dsh:set-top-inset', (_e, height: number) => dshview.setDshTopInset(Number(height)))
  ipcMain.on('dsh:set-sidebar-width', (_e, width: number) => {
    const next = Number(width)
    dshview.setDshSidebarWidth(next)
    guiView.setGuiSidebarWidth(next)
  })
  ipcMain.on('gui:set-active', (_e, instanceId: string, active: boolean) =>
    guiView.setGuiActive(String(instanceId), Boolean(active))
  )
  ipcMain.on('gui:set-insets', (_e, insets: { top?: number; right?: number; bottom?: number }) =>
    guiView.setGuiContentInsets({ top: Number(insets?.top ?? 0), right: Number(insets?.right ?? 0), bottom: Number(insets?.bottom ?? 0) })
  )
  ipcMain.on('webchat:set', (_e, show: boolean, chatId: string, url: string, popout: boolean, forceReload?: boolean) =>
    dshview.setWebChat(Boolean(show), String(chatId), String(url), Boolean(popout), Boolean(forceReload))
  )
  ipcMain.on('webchat:release', (_e, chatId: string) => dshview.releaseWebChat(String(chatId)))
  ipcMain.on('webchat:reload-current', (_e, chatId: string) => dshview.reloadWebChatCurrent(String(chatId)))
  ipcMain.handle('webchat:alive', () => dshview.aliveWebChatIds())

  // Floating whale orb (a small view over the DSH view) — events come from the
  // dedicated orb page (`?orb=1`); `orb:clicked` goes back to the launcher.
  ipcMain.on('orb:set-visible', (_e, visible: boolean) => orb.setOrbVisible(Boolean(visible)))
  ipcMain.on('orb:drag-start', (_e, ox: number, oy: number) => orb.orbDragStart(Number(ox), Number(oy)))
  ipcMain.on('orb:drag-move', (_e, sx: number, sy: number) => orb.orbDragMove(Number(sx), Number(sy)))
  ipcMain.on('orb:drag-end', () => orb.orbDragEnd())
  ipcMain.on('orb:click', () => orb.orbClick())
  warmGuiDiscoveryAtStartup()
}
