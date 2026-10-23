import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DshInstance, LauncherConfig } from '../shared/types'
import { writeJsonAtomic } from './atomic-json'
import { CURRENT_CONFIG_VERSION, migrateLauncherConfig } from './config-migration'
import { cascadeGroupReferences, reconcileGroupReferences, resolveCurrentGroup } from '../shared/groups'
import { DEFAULT_HOTKEY_SETTINGS, normalizeHotkeySettings } from '../shared/hotkeys'
import { createDefaultProfile } from '../shared/profiles'
import { normalizeBridgeToken, normalizeCookieBridgeConfig } from '../shared/bridge'
import { validateRuntimeSelection } from './runtime-selection'
import { validateInstancePort } from '../shared/runtime-version'

const home = homedir()
const fallbackCookieBridgeToken = randomBytes(32).toString('base64url')

function firstExisting(candidates: string[]): string {
  return candidates.find(c => c && existsSync(resolve(c))) ?? candidates.find(c => c) ?? ''
}

function defaults(): LauncherConfig {
  const harnessRepo = firstExisting([process.env.DSH_REPO ?? '', join(home, 'deepseek-harness')])
  const runtimeRoot = join(home, '.dsh-runtime')
  const systemLang = (app.getLocale() ?? 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
  return {
    configVersion: CURRENT_CONFIG_VERSION,
    groups: [],
    profiles: [createDefaultProfile(systemLang === 'en' ? 'Default (Launcher)' : '默认资料（启动器）')],
    activeGroupId: 'home',
    // A checked-out repo implies we're on the developer machine ⇒ source mode.
    // Anything else targets the portable runtime (sharing the launcher to others).
    installMode: existsSync(harnessRepo) ? 'source' : 'bundled',
    runtimeRoot,
    nodeVersion: '22.20.0',
    dshVersion: '0.1.0-rc.6',
    harnessRepo,
    harnessRepoUrl: 'https://github.com/deepseek-ai/deepseek-harness.git',
    dshHome: firstExisting([process.env.DSH_HOME ?? '', join(home, '.dsh')]),
    pluginDir: firstExisting([join(home, 'DSH-Plugin')]),
    profile: 'web',
    port: 3080,
    nodePath: 'node',
    launchArgs: ['apps/cli/lib/bin.js'],
    buildCmd: 'pnpm run build',
    stopOnQuit: true,
    pnpm: 'pnpm',
    startupTimeoutMs: 90000,
    language: systemLang,
    closeToTray: true,
    splashEnabled: true,
    autoStartOnLaunch: false,
    floatingWhale: false,
    hotkeys: { ...DEFAULT_HOTKEY_SETTINGS, leaderKeys: [...DEFAULT_HOTKEY_SETTINGS.leaderKeys] },
    cookieBridge: normalizeCookieBridgeConfig({ token: fallbackCookieBridgeToken }),
    marketPageSize: 30,
    marketSource: 'github',
    githubToken: '',
    instances: [],
    activeInstanceId: '',
    webChats: [{ id: 'default', name: 'DeepSeek 网页版', description: '', url: 'https://chat.deepseek.com', hidden: false }],
    pluginMeta: {}
  }
}

/**
 * Multi-instance migration + mirror sync. `profile` / `port` / `autoStartOnLaunch`
 * are kept as mirrors of the *active* instance so all pre-instance code paths
 * (and the legacy Settings fields) keep reading the right values.
 *
 * A config with no `instances` is a legacy single-install config: it is turned
 * into one default instance whose workspace is *not* pinned, so
 * {@link resolveWorkspace} keeps returning the historical cwd (harness repo in
 * source mode, runtime root in bundled mode) and existing sessions stay put.
 */
function reconcileInstances(cfg: LauncherConfig): LauncherConfig {
  let instances = cfg.instances ?? []
  let activeInstanceId = cfg.activeInstanceId ?? ''
  if (instances.length === 0) {
    const id = 'default'
    const legacy: DshInstance = {
      id,
      name: cfg.language === 'en' ? 'Default' : '默认实例',
      profile: cfg.profile || 'web',
      port: cfg.port || 3080,
      autoStart: cfg.autoStartOnLaunch ?? false,
      description: '',
      enabled: true
      // workspace left undefined → resolveWorkspace falls back to the legacy cwd
    }
    instances = [legacy]
    activeInstanceId = id
  }
  // Backfill the newer fields so instances written before `description` /
  // `enabled` existed keep working: enabled defaults on, description empty.
  instances = instances.map(i => ({
    ...i,
    description: i.description ?? '',
    enabled: i.enabled !== false
  }))
  const active = instances.find(i => i.id === activeInstanceId)
  if (!active || active.enabled === false) {
    // Never leave the active instance hidden — fall back to the first shown one.
    activeInstanceId = (instances.find(i => i.enabled !== false) ?? instances[0]).id
  }
  const target = instances.find(i => i.id === activeInstanceId) ?? instances[0]
  return {
    ...cfg,
    instances,
    activeInstanceId,
    profile: target.profile,
    port: target.port,
    autoStartOnLaunch: target.autoStart
  }
}

/** Folds a mirror edit (profile/port/autoStartOnLaunch) back into the active instance. */
function reconcileMirrors(cfg: LauncherConfig): LauncherConfig {
  const active = cfg.instances.find(i => i.id === cfg.activeInstanceId) ?? cfg.instances[0]
  if (!active) return cfg
  const instances = cfg.instances.map(i =>
    i.id === active.id ? { ...i, profile: cfg.profile, port: cfg.port, autoStart: cfg.autoStartOnLaunch } : i
  )
  return { ...cfg, instances }
}

let cache: LauncherConfig | null = null
let configPath = ''

function file(): string {
  if (!configPath) configPath = join(app.getPath('userData'), 'launcher-config.json')
  return configPath
}

function persist(cfg: LauncherConfig, preserveBackup = false): void {
  writeJsonAtomic(file(), cfg, { backup: !preserveBackup })
}

export function getConfig(): LauncherConfig {
  if (cache) return cache
  try {
    let raw = readFileSync(file(), 'utf8').replace(/^\uFEFF/, '')
    let recovered = false
    try { JSON.parse(raw) } catch {
      // Never replace an unreadable config with defaults or destroy the good backup.
      const backup = readFileSync(`${file()}.bak`, 'utf8').replace(/^\uFEFF/, '')
      JSON.parse(backup)
      copyFileSync(file(), `${file()}.corrupt-${Date.now()}`)
      raw = backup
      recovered = true
    }
    const parsed = JSON.parse(raw) as Partial<LauncherConfig> & {
      // 旧版单个 webChat 字段(迁移用,类型里已改为数组 webChats)。
      webChat?: { name?: string; description?: string; url?: string; hidden?: boolean }
    }
    let shouldPersist = recovered
    // 迁移:旧版单个 webChat → webChats[0]。
    if (parsed.webChat && !Array.isArray(parsed.webChats)) {
      parsed.webChats = [{
        id: 'default',
        name: parsed.webChat.name || 'DeepSeek 网页版',
        description: parsed.webChat.description || '',
        url: parsed.webChat.url || 'https://chat.deepseek.com',
        hidden: parsed.webChat.hidden === true
      }]
      shouldPersist = true
    }
    // 兜底:webChats 字段缺失时(首次运行本版本)补一个默认 DeepSeek 网页版。
    // 用户手动删空(webChats: [])后不再补——否则删一个又建一个,永远删不完。
    if (!Array.isArray(parsed.webChats)) {
      parsed.webChats = [{ id: 'default', name: 'DeepSeek 网页版', description: '', url: 'https://chat.deepseek.com', hidden: false }]
      shouldPersist = true
    }
    const base = defaults()
    // The fixed bridge token is generated once and then reused from config.
    // Missing/legacy cookieBridge objects get the per-process fallback and are
    // immediately persisted below, so a restart reads the same value.
    if (!normalizeBridgeToken(parsed.cookieBridge?.token)) shouldPersist = true
    const merged = reconcileInstances({
      ...base,
      ...parsed,
      // Preserve an absent/old version for the migration decision; defaults alone
      // would hide whether the on-disk file still needs an upgrade.
      configVersion: typeof parsed.configVersion === 'number' ? parsed.configVersion : 0,
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      hotkeys: normalizeHotkeySettings(parsed.hotkeys),
      cookieBridge: normalizeCookieBridgeConfig({ ...base.cookieBridge, ...parsed.cookieBridge })
    })
    const migration = migrateLauncherConfig(merged)
    cache = migration.config
    // Persist one-time structural migrations so later reads are idempotent.
    if (shouldPersist || migration.migrated || !Array.isArray(parsed.instances) || parsed.instances.length === 0) {
      persist(cache, recovered)
    }
  } catch (error) {
    cache = null
    if (existsSync(file())) {
      throw new Error(`启动器配置读取或保存失败，原文件已保留 / Launcher config could not be read or saved; original preserved: ${file()}`, { cause: error })
    }
    const next = migrateLauncherConfig(reconcileInstances(defaults())).config
    // First run: persist the generated fixed bridge token immediately so a
    // restart cannot replace it with a different fallback.
    persist(next)
    cache = next
  }
  return cache
}

export function setConfig(patch: Partial<LauncherConfig>): LauncherConfig {
  let next: LauncherConfig = { ...getConfig(), ...patch, hotkeys: normalizeHotkeySettings(patch.hotkeys ?? getConfig().hotkeys) }
  if (next.instances.length === 0) {
    // Guard against a caller wiping the instance list — re-derive the default.
    next = reconcileInstances(next)
  } else if (patch.instances || patch.activeInstanceId) {
    // The instance list / active id changed directly → re-sync the mirrors.
    next = reconcileInstances(next)
  } else if (patch.profile !== undefined || patch.port !== undefined || patch.autoStartOnLaunch !== undefined) {
    // A legacy mirror field changed → fold it back into the active instance.
    next = reconcileMirrors(next)
  }

  // Group references are derived from the live instance/link collections.
  // Doing this at the single write choke point guarantees deleted ids cannot
  // survive in any group, including when a caller saves `webChats` directly.
  if (patch.instances || patch.webChats) {
    next = {
      ...next,
      groups: cascadeGroupReferences(next.groups, {
        instanceIds: new Set(next.instances.map((instance) => instance.id)),
        linkIds: new Set((next.webChats ?? []).map((link) => link.id))
      })
    }
  }
  const groups = reconcileGroupReferences(next.groups, next.instances, next.webChats ?? [])
  next = {
    ...next,
    groups,
    activeGroupId: resolveCurrentGroup(groups, patch.activeGroupId ?? next.activeGroupId).id
  }

  // Every config write goes through the same schema migration so profile ids
  // and the fixed launcher-default record cannot drift.
  next = migrateLauncherConfig({ ...next, configVersion: CURRENT_CONFIG_VERSION }).config
  validateRuntimeSelection(next)
  if (patch.instances || patch.port !== undefined) {
    const ports = new Set<number>()
    for (const inst of next.instances) {
      if (inst.kind === 'gui' || inst.kind === 'ps') continue
      const port = validateInstancePort(inst.port, inst.kind === 'web')
      if (port > 0 && ports.has(port)) throw new Error(`端口 ${port} 已分配给其他实例 / Port is assigned to another instance`)
      if (port > 0) ports.add(port)
    }
  }
  persist(next)
  cache = next
  return next
}
