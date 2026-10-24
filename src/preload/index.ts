import { contextBridge, ipcRenderer } from 'electron'
import type { DshLauncherApi, LauncherEvent } from '../shared/types'
import type { S6S7Api } from '../shared/s6s7'

const api: DshLauncherApi & S6S7Api = {
  listDshRuntimeVersions: () => ipcRenderer.invoke('runtime:versions'),
  getInstanceRuntime: (id) => ipcRenderer.invoke('runtime:instanceInfo', id),
  installInstanceRuntime: (id) => ipcRenderer.invoke('runtime:instanceInstall', id),
  getState: () => ipcRenderer.invoke('state:get'),
  listDownloads: () => ipcRenderer.invoke('downloads:list'),
  clearDownloads: () => ipcRenderer.invoke('downloads:clear'),
  revealDownload: (id) => ipcRenderer.invoke('downloads:reveal', id),
  openDownloadsFolder: () => ipcRenderer.invoke('downloads:openFolder'),
  setPerformanceActive: (active) => ipcRenderer.invoke('perf:setActive', active),
  getPerformanceSnapshot: () => ipcRenderer.invoke('perf:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  confirm: (message) => ipcRenderer.invoke('confirm', message),
  startInstance: (instanceId) => ipcRenderer.invoke('harness:start', instanceId),
  stopInstance: (instanceId) => ipcRenderer.invoke('harness:stop', instanceId),
  restartInstance: (instanceId) => ipcRenderer.invoke('harness:restart', instanceId),
  stopAllInstances: () => ipcRenderer.invoke('harness:stopAll'),
  detachInstanceKeepAlive: (instanceId) => ipcRenderer.invoke('harness:detach', instanceId),
  adoptExistingGuiInstance: (instanceId) => ipcRenderer.invoke('harness:adopt', instanceId),
  setActiveInstance: (instanceId) => ipcRenderer.invoke('instances:setActive', instanceId),
  pickGuiExecutable: () => ipcRenderer.invoke('gui:pickExecutable'),
  discoverGuiApps: () => ipcRenderer.invoke('gui:discoverApps'),
  refreshGuiAppsDiscovery: () => ipcRenderer.invoke('gui:refreshDiscovery'),
  checkGuiExecutable: (instanceId) => ipcRenderer.invoke('instances:checkGuiExecutable', instanceId),
  repairGuiExecutable: (instanceId) => ipcRenderer.invoke('instances:repairExecutable', instanceId),
  addInstance: (input) => ipcRenderer.invoke('instances:add', input),
  updateInstance: (instanceId, patch) => ipcRenderer.invoke('instances:update', instanceId, patch),
  removeInstance: (instanceId) => ipcRenderer.invoke('instances:remove', instanceId),
  openUi: (instanceId) => ipcRenderer.invoke('harness:openUi', instanceId),
  openInstanceWindow: (instanceId) => ipcRenderer.invoke('harness:openInstanceWindow', instanceId),
  closeInstanceWindow: (instanceId) => ipcRenderer.invoke('harness:closeInstanceWindow', instanceId),
  getConfig: () => ipcRenderer.invoke('config:get'),
  resolveLinkFavicon: (url) => ipcRenderer.invoke('links:favicon', url),
  scanChromeProfiles: () => ipcRenderer.invoke('profiles:scanChrome'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  bridgeGetState: () => ipcRenderer.invoke('bridge:getState'),
  bridgeSetConfig: (patch) => ipcRenderer.invoke('bridge:setConfig', patch),
  bridgeRegenerateToken: () => ipcRenderer.invoke('bridge:regenerateToken'),
  securityList: () => ipcRenderer.invoke('security:list'),
  securityClearAudit: () => ipcRenderer.invoke('security:clearAudit'),
  securityExportAudit: () => ipcRenderer.invoke('security:exportAudit'),
  securityGetWhitelist: () => ipcRenderer.invoke('security:getWhitelist'),
  securityOpenWhitelistFile: () => ipcRenderer.invoke('security:openWhitelistFile'),
  securityGetConfig: () => ipcRenderer.invoke('security:getConfig'),
  securitySetConfig: (patch) => ipcRenderer.invoke('security:setConfig', patch),
  securityListProbeStatus: () => ipcRenderer.invoke('security:listProbeStatus'),
  securityInstallProbe: (instanceId) => ipcRenderer.invoke('security:installProbe', instanceId),
  securityRemoveProbe: (instanceId) => ipcRenderer.invoke('security:removeProbe', instanceId),
  securityReinstallProbe: (instanceId) => ipcRenderer.invoke('security:reinstallProbe', instanceId),
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  listPluginMatrix: () => ipcRenderer.invoke('plugins:listMatrix'),
  setPluginMeta: (name, meta) => ipcRenderer.invoke('plugins:setMeta', name, meta),
  installPlugin: (instanceId, spec, name) => ipcRenderer.invoke('plugins:install', instanceId, spec, name),
  disablePlugin: (instanceId, name) => ipcRenderer.invoke('plugins:disable', instanceId, name),
  enablePlugin: (instanceId, name) => ipcRenderer.invoke('plugins:enable', instanceId, name),
  uninstallPlugin: (instanceId, name) => ipcRenderer.invoke('plugins:uninstall', instanceId, name),
  updatePlugin: (instanceId, name) => ipcRenderer.invoke('plugins:update', instanceId, name),
  updateLocalPlugin: (name) => ipcRenderer.invoke('plugins:updateLocal', name),
  removeFromLibrary: (name) => ipcRenderer.invoke('plugins:removeFromLibrary', name),
  removeFromLibraryMany: (names) => ipcRenderer.invoke('plugins:removeFromLibraryMany', names),
  libraryRepoInfo: (name) => ipcRenderer.invoke('plugins:libraryRepo', name),
  removeRepoFromLibrary: (name) => ipcRenderer.invoke('plugins:repoRemove', name),
  repairDeps: () => ipcRenderer.invoke('build:repair'),
  rebuild: () => ipcRenderer.invoke('build:rebuild'),
  downloadHarness: () => ipcRenderer.invoke('download:harness'),
  downloadPlugin: (url, subdir, instanceId) => ipcRenderer.invoke('download:plugin', url, subdir, instanceId),
  installBundle: (bundleId, options) => ipcRenderer.invoke('bundles:install', bundleId, options),
  bundles: () => ipcRenderer.invoke('bundles:list'),
  installRuntime: () => ipcRenderer.invoke('runtime:install'),
  updateRuntime: () => ipcRenderer.invoke('runtime:update'),
  getBalance: () => ipcRenderer.invoke('balance:get'),
  searchMarket: (sourceId, page, query, categoryId, force) =>
    ipcRenderer.invoke('market:search', sourceId, page, query, categoryId, force),
  fetchMarketReadme: (owner, repo) => ipcRenderer.invoke('market:readme', owner, repo),
  confirmOpenExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  setDshActive: (instanceId, active, reload) => ipcRenderer.send('dsh:set-active', instanceId, active, reload),
  setGuiActive: (instanceId, active) => ipcRenderer.send('gui:set-active', instanceId, active),
  setDshSidebarWidth: (width) => ipcRenderer.send('dsh:set-sidebar-width', width),
  setDshTopInset: (height) => ipcRenderer.send('dsh:set-top-inset', height),
  setGuiContentInsets: (insets) => ipcRenderer.send('gui:set-insets', insets),
  setWebChat: (show, chatId, url, popout, forceReload) =>
    ipcRenderer.send('webchat:set', show, chatId, url, popout, forceReload),
  releaseWebChat: (chatId) => ipcRenderer.send('webchat:release', chatId),
  reloadWebChat: (chatId) => ipcRenderer.send('webchat:reload-current', chatId),
  getWebChatAlive: () => ipcRenderer.invoke('webchat:alive'),
  setOrbVisible: (visible) => ipcRenderer.send('orb:set-visible', visible),
  orbDragStart: (ox, oy) => ipcRenderer.send('orb:drag-start', ox, oy),
  orbDragMove: (sx, sy) => ipcRenderer.send('orb:drag-move', sx, sy),
  orbDragEnd: () => ipcRenderer.send('orb:drag-end'),
  orbClick: () => ipcRenderer.send('orb:click'),
  onOrbClicked: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('orb:clicked', listener)
    return () => {
      ipcRenderer.removeListener('orb:clicked', listener)
    }
  },
  onEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, data: LauncherEvent): void => cb(data)
    ipcRenderer.on('harness:event', listener)
    return () => {
      ipcRenderer.removeListener('harness:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('dshLauncher', api)
