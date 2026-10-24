// Shared types used by main, preload, and renderer.

import type { HotkeySettings } from './hotkeys'
import type { CookieBridgeConfig, CookieBridgeConfigPatch, CookieBridgeState } from './bridge'

export type HarnessStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'degraded' | 'error' | 'external'

export interface HarnessState {
  /** The instance this state belongs to. */
  instanceId: string
  status: HarnessStatus
  pid: number | null
  profile: string
  port: number
  startedAt: number | null
  ready: boolean
  exitCode: number | null
  lastError: string | null
  /** 插件集已改动,需手动重启实例后才生效。 */
  pendingRestart: boolean
  /** GUI 窗口当前是否已嵌入启动器内容区。缺省对非 GUI 实例无意义。 */
  guiAttached?: boolean
}

export interface LogLine {
  stream: 'stdout' | 'stderr'
  line: string
  at: number
}

export type InstallMode = 'source' | 'bundled'

export interface InstanceRuntimeInfo {
  instanceId: string
  mode: 'inherit' | 'fixed'
  requestedVersion: string | null
  installedVersion: string | null
  installed: boolean
  installDir: string
}

export interface DshRuntimeCatalog {
  versions: string[]
  tags: Record<string, string>
}

/** GUI window ownership/selection policy. */
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
export type GuiAppPresetId =
  | 'antigravity'
  | 'codex'
  | 'claude'
  | 'wechat'
  | 'chrome'
  | 'typora'
  | 'vscode'
  | 'zotero'
  | 'qoder'
  | 'zcode'
export type GuiChromeProfileMode = 'isolated' | 'shared'

/** One independently-running DSH: its own profile, port, and session workspace. */
export interface DshInstance {
  /** Stable id (uuid). */
  id: string
  /** User-visible name, e.g. "工作实例". */
  name: string
  /** dsh profile this instance boots (`web`, or a custom profile name). */
  profile: string
  /** Port for `--port`; 0 lets the OS pick a free one (parsed from dsh's log at start). */
  port: number
  /** Start this instance automatically when the launcher boots. */
  autoStart: boolean
  /** User-set note shown on the instance card. */
  description: string
  /** Show the instance in the sidebar / dashboard / plugin matrix. Disabled ones stay configured but hidden. */
  enabled: boolean
  /** Process working directory — isolates this instance's session list (sessions are keyed by cwd). */
  workspace?: string
  /** 创建时选定的数据目录（独立 home 或显式共享目标）；缺省 = 全局 cfg.dshHome。 */
  dshHome?: string
  /** Exact DSH version in a dedicated installation; absent inherits global settings. */
  runtimeVersion?: string
  /** 'dsh'(缺省)用 dsh CLI 启动;'web' 直接跑 command 并内嵌其 HTTP 端口;'gui' 嵌入桌面窗口;'ps' 运行 PowerShell 脚本并把输出写入实例日志。 */
  kind?: 'dsh' | 'web' | 'gui' | 'ps'
  /** kind==='gui' 时的可执行文件绝对路径。 */
  exe?: string
  /** kind==='gui' 时追加给 exe 的参数(按数组传,不经过 shell)。 */
  args?: string[]
  /** kind==='gui' 时可选的主窗口标题过滤(精确或包含匹配)。 */
  windowTitle?: string
  /** kind==='gui' 时的窗口选择/接管策略。 */
  windowPolicy?: GuiWindowPolicy
  /** kind==='gui' 时的精确窗口类名过滤(策略自身也会做类名检查)。 */
  windowClass?: string
  /** 创建时使用的桌面应用 preset，用于 AppX 路径升级后的自动修复。 */
  guiPresetId?: GuiAppPresetId
  /** Chrome GUI 实例使用独立 profile（推荐）还是共享用户 profile。 */
  chromeProfileMode?: GuiChromeProfileMode
  /** kind==='web' 时的启动命令行,在 workspace 下由 cmd /c 执行。 */
  command?: string
  /** kind==='web' 时的健康检查路径,默认 '/'。 */
  healthPath?: string
  /** kind==='web' 时可选的自定义 User-Agent(用于需要桌面布局的 WebUI);留空 = Electron 默认。 */
  userAgent?: string
  /** 侧栏图标:emoji、绝对路径或 data: URL。 */
  icon?: string
  /** 用户手动锁定的图标;自动发现/预设刷新不得覆盖。 */
  iconLocked?: boolean
  /** 无图片图标时的色块颜色(PS 实例 / favicon 回退)。 */
  iconColor?: string
  /** 无图片图标时的色块单字。 */
  iconChar?: string
  /** 可选隔离资料；缺省 = 使用 Electron 旧 defaultSession（保留历史登录态）。 */
  profileId?: string
}

/** Per-plugin user metadata (display-name override + remark), keyed by package name. */
export interface PluginMeta {
  /** Overrides the plugin's displayed name in the launcher UI; empty = use the package name. */
  displayName?: string
  /** Free-text remark shown under the plugin name. */
  remark?: string
}

/** 独立 cookie 资料；partition 在创建 WebContentsView 时固定。 */
export interface Profile {
  id: string
  name: string
  color: string
  letter: string
  /** Electron 隔离分区；默认资料使用 `default-session` 表示不隔离。 */
  partition: string
  source: 'launcher' | 'chrome' | 'edge'
  /** Chrome User Data directory name when this came from a scan (e.g. Default, Profile 2). */
  chromeProfileDir?: string
  archived?: boolean
}
/** 顶栏分组:只控制哪些实例/链接可见,不复制实例,也不拥有进程生命周期。 */
export interface Group {
  /** Stable id; the home group uses `home`. */
  id: string
  name: string
  /** 顶栏色块上的单字。 */
  char: string
  color: string
  /** Home is the fixed default group; every other group is homogeneous. */
  kind: 'home' | 'group'
  showInTopBar: boolean
  /** 首页实例 id 的可见性引用。 */
  visibleInstances: string[]
  /** 链接 id 的可见性引用(共有链接或本组私有链接)。 */
  visibleLinks: string[]
}

/** 新标签页最近历史的一条记录。 */
export interface HistoryEntry {
  id: string
  webChatId: string
  name: string
  url: string
  groupId: string
  openedAt: number
}

export interface LauncherConfig {
  /** 持久化配置结构版本;旧文件由 config-migration.ts 迁移。 */
  configVersion: number
  /** 顶栏分组;迁移后至少包含固定的「首页」组。 */
  groups: Group[]
  /** Profiles are manual registry entries; only new web links may reference one. */
  profiles: Profile[]
  /** One-time migration of the legacy Electron default session cookies. */
  profileCookieMigration?: { version: number; from: string; to: string; completedAt: number; count: number }
  /** 当前选中的分组;缺省/失效时回退到首页。 */
  activeGroupId?: string
  /** One shared recent-history list for every group. */
  recentHistory?: HistoryEntry[]
  /** 'source' runs the checked-out harness repo with a system Node; 'bundled' runs the portable runtime. */
  installMode: InstallMode
  /** Directory holding the portable Node runtime + bundled @deepseek-ai/dsh install. */
  runtimeRoot: string
  /** Portable Node version pinned by installRuntime (mirrored from npmmirror). */
  nodeVersion: string
  /** Bundled @deepseek-ai/dsh version pinned by installRuntime / updateRuntime. */
  dshVersion: string
  harnessRepo: string
  /** Remote URL used by the one-click download / update in Settings. */
  harnessRepoUrl: string
  dshHome: string
  pluginDir: string
  /** The active instance's profile (mirror of instances[active].profile). */
  profile: string
  /** The active instance's port (mirror of instances[active].port). */
  port: number
  nodePath: string
  /** e.g. ['--import', 'tsx/esm', 'apps/cli/src/bin.ts'] — the dsh profile name is appended at run time. */
  launchArgs: string[]
  buildCmd: string
  stopOnQuit: boolean
  pnpm: string
  /** Abort the boot with an error if the port has not become ready within this many ms. */
  startupTimeoutMs: number
  /** GUI 停止后扫描同 exe 新进程的间隔(ms);缺省 1200,最多按 guiStopRescanRetries 重试。 */
  guiStopRescanMs?: number
  /** GUI 停止后最多重扫并终止同 exe 自启进程的次数;缺省 2,上限 2。 */
  guiStopRescanRetries?: number
  /** UI + main-process log language. Defaults from the system locale on first run. */
  language: 'zh' | 'en'
  /** Hide to the system tray on window close instead of quitting. */
  closeToTray: boolean
  /** Startup splash: play the whale-lightbulb animation before showing the window. Default on. */
  splashEnabled: boolean
  /** Launch: auto-start the active instance on app start. Default off; flips on automatically after a successful deploy. */
  autoStartOnLaunch: boolean
  /** DSH view: replace the collapsed whale rail with a draggable floating orb. Default off. */
  floatingWhale: boolean
  /** How many plugin-market entries are fetched per page (10–50). */
  marketPageSize: number
  /** 插件市场当前来源,持久化(见 shared/plugin-sources.ts)。 */
  marketSource?: MarketSourceId
  /** Optional GitHub personal access token, used to clone private plugin repos. */
  githubToken?: string
  /** All DSH instances. Migration turns the legacy single profile/port into one instance. */
  instances: DshInstance[]
  /** The instance whose state/view the UI currently shows. */
  activeInstanceId: string
  /** Per-plugin user metadata (display-name override + remark), keyed by package name. */
  pluginMeta?: Record<string, PluginMeta>
  /** 安全设置:dsh-audit 探针开关 / 是否记录原文 / 第三方工具白名单。 */
  security?: { probeEnabled?: boolean; logRawContent?: boolean; thirdPartyTools?: string[] }
  /** 数字快捷键与全局引导键;缺省启用、应用键 + Copilot、1500ms。 */
  hotkeys?: HotkeySettings
  /** 本地 Chrome Cookie 桥;缺省启用,端口 17321,固定写入 defaultSession。 */
  cookieBridge?: CookieBridgeConfig
  /** 网页版免费对话(虚拟实例)列表:每个是一条可内嵌打开的链接卡片。 */
  webChats?: WebChatConfig[]
  /** 上次窗口位置/大小(用于恢复);displayCount 记录当时的显示器数量,变化则不用恢复。 */
  windowBounds?: { x: number; y: number; width: number; height: number; displayCount: number }
}

/** 网页版免费对话(虚拟实例):名称 / 介绍 / 链接地址 / 是否在侧边栏显示。 */
export interface WebChatConfig {
  id: string
  name: string
  description: string
  url: string
  hidden: boolean
  /** 卡片图标:emoji、绝对路径或 data: URL。 */
  icon?: string
  /** 用户手动锁定的图标;自动 favicon/预设刷新不得覆盖。 */
  iconLocked?: boolean
  /** 私有链接所属分组;缺省/空 = 共有链接。 */
  groupId?: string
  /** 可选隔离资料；缺省 = 使用 Electron 旧 defaultSession。 */
  profileId?: string
  /** favicon 失败时的字母色块颜色。 */
  iconColor?: string
  /** 分组删除后归档;保留数据但不参与普通列表。 */
  archived?: boolean
  archivedFromGroupId?: string
  archivedFromGroupName?: string
  archivedAt?: number
}

export interface InstalledPlugin {
  name: string
  version: string
  description: string
  spec: string
  localPath: string | null
  enabled: boolean
  isBundle: boolean
  inBox: boolean
}

/** Two-state plugin status: a plugin is either enabled for an instance or absent from it. */
export type LocalStatus = 'not-installed' | 'installed' | 'enabled'

export interface LocalPlugin {
  name: string
  version: string
  description: string
  path: string
  isBundle: boolean
  platform: string | null
  status: LocalStatus
}

export interface PluginListResult {
  profile: string
  bundles: string[]
  installed: InstalledPlugin[]
  local: LocalPlugin[]
}

/** Plugin×instance matrix: rows are local plugins, columns are instances. */
export type PluginCellStatus = 'not-installed' | 'installed' | 'enabled'

export interface PluginMatrixColumn {
  id: string
  name: string
  profile: string
  running: boolean
}

export interface PluginMatrixRow {
  /** Package name (stable key). */
  name: string
  /** Display name — pluginMeta override or the package name. */
  displayName: string
  version: string
  description: string
  /** User remark (pluginMeta); empty when none. */
  remark: string
  /** 本地库源码目录。空字符串 = 未在本地库、由 `dsh plugin add` 直装进某实例(见 spec)。 */
  path: string
  isBundle: boolean
  platform: string | null
  /** 直装行(未在本地库)的安装 spec(github:owner/repo 或 npm 包名);本地库行为空串。 */
  spec: string
}

export interface PluginMatrixResult {
  rows: PluginMatrixRow[]
  columns: PluginMatrixColumn[]
  /** row name → instance id → status. */
  cells: Record<string, Record<string, PluginCellStatus>>
}

export interface TaskEvent {
  label: string
  status: 'start' | 'end'
  code: number | null
  stream?: 'stdout' | 'stderr'
  line?: string
  /** 0..1 completion when determinable (e.g. file downloads); undefined = indeterminate. */
  progress?: number
  /** Short phase label for the progress UI, e.g. '下载 Node'. */
  phase?: string
}

export type LauncherEvent =
  | { type: 'state'; state: HarnessState }
  | { type: 'log'; stream: 'stdout' | 'stderr'; line: string; at: number; instanceId: string }
  | { type: 'task'; task: TaskEvent }
  | { type: 'instances'; instances: DshInstance[]; activeInstanceId: string }
  | { type: 'popup'; instanceId: string; open: boolean }
  /** 保活中的网页卡 id(常驻视图还在);侧栏据此点亮/熄灭卡片状态点。 */
  | { type: 'webchat-views'; ids: string[] }
  | { type: 'dsh-update'; latest: string | null; current: string | null }
  | { type: 'launcher-update'; latest: string | null; current: string; url: string | null; update: boolean }
  | { type: 'logs-cleared' }
  | { type: 'gui-discovery'; snapshot: GuiAppDiscoverySnapshot }
  | { type: 'launcher-page'; page: 'settings' }
  | { type: 'instance-operation'; operation: InstanceOperationEvent }
  /** 低级键盘钩子进入/离开 leader 状态;渲染层据此高亮数字徽标。 */
  | { type: 'hotkey-leader'; active: boolean }
  /** 全局 leader 模式捕获到数字;渲染层执行对应切换。 */
  | { type: 'hotkey-trigger'; digit: string }

/** Progress for the serialized start/stop/restart queue. */
export interface InstanceOperationEvent {
  operationId: string
  kind: 'start' | 'stop' | 'restart' | 'adopt' | 'detach' | 'stop-all'
  phase: 'running' | 'done' | 'error'
  instanceId?: string
  instanceName?: string
  /** Completed items in the current batch (0-based while running). */
  completed: number
  /** Total items in the current batch. */
  total: number
  /** Short user-visible phase text. */
  message?: string
  error?: string
}

export interface BootstrapState {
  /** state per instance id. */
  states: Record<string, HarnessState>
  /** log per instance id. */
  logs: Record<string, LogLine[]>
  config: LauncherConfig
  /** 当前 dsh 版本(内置运行时);源码模式为 null。 */
  dshVersion: string | null
}

export interface CmdResult {
  ok: boolean
  code: number | null
  error?: string
  /** Tail of the child process's stderr (last ~8k chars), for diagnosing failures. */
  stderr?: string
  /**
   * Tail of the child process's stdout (last ~8k chars). pnpm prints some error
   * reports (e.g. ERR_PNPM_UNEXPECTED_STORE) on **stdout**, so classifiers must
   * look at both streams — keeping only stderr silently missed them.
   */
  stdout?: string
  /** When a repo ships several plugin packages (e.g. skins in subdirs), the caller can choose one. */
  packages?: PluginSubPackage[]
  /** Instance ids affected by a cross-instance operation (e.g. removeFromLibrary). */
  affected?: string[]
  /** Non-fatal notes from a multi-step operation (e.g. a bundle install that skipped a plugin). */
  warnings?: string[]
  /** installBundle:失败插件的安装 spec 列表,一键重试时原样传回 installBundle(bundleId, specs)。 */
  bundleFailed?: string[]
}

/** A plugin package found inside a cloned repo (the repo root may not be one itself). */
export interface PluginSubPackage {
  /** Repo-relative directory of the package, e.g. 'maid-atelier'. */
  path: string
  /** Package name from its package.json. */
  name: string
}

export interface BalanceData {
  currency: string
  total_balance: string
  granted_balance: string
  topped_up_balance: string
  is_available: boolean
}

export interface BalanceResult {
  ok: boolean
  data?: BalanceData
  error?: string
}

/** 一条被 dsh-audit 探针记录的会话数据流审计事件。 */
export interface SecurityAuditEvent {
  t: number
  sid: string
  seq: number
  type: string
  core: number
  h: string
  /** 操作者:发出该事件的插件/角色(如 user、模型名、某第三方工具/插件) */
  actor?: string
  /** 原始内容(探针在 logRawContent 开启时记录) */
  raw?: string
  /** 风险等级:1=低(密钥键名/部分),2=高(完整密钥明文)。有 flags 时才有 */
  sev?: number
  /** 脱敏的密钥预览(如 sk-•••ab12),不含完整明文 */
  key?: string
  flags?: string[]
  home?: string
  /** 所属实例 id(启动器读取时标注) */
  instanceId?: string
  /** 所属实例名(启动器读取时标注,如 web-2) */
  instanceName?: string
}

/** 安全设置(探针开关 / 是否记录原文 / 第三方工具白名单)。 */
export interface SecurityConfig {
  probeEnabled: boolean
  logRawContent: boolean
  /** 第三方工具/插件白名单:只对名单内的工具事件做风险告警 */
  thirdPartyTools: string[]
}

/** 每个实例的探针(dsh-audit)状态。 */
export interface ProbeStatus {
  instanceId: string
  name: string
  installed: boolean
  enabled: boolean
}

/** 插件市场来源:GitHub topic 搜索 / deepseek1024.com / dshfind.com。 */
export type MarketSourceId = 'github' | 'dsh1024' | 'dshfind'

/** 某源的分类项(与服务端格式无关的归一化形态;id='all' 为「全部」)。 */
export interface SourceCategory {
  id: string
  zhName: string
  enName: string
  count?: number
}

/** A dsh plugin discovered on GitHub (topic:dsh-plugin), mapped from the search API response. */
export interface MarketRepo {
  id: number
  owner: string
  /** Repository name (without owner), e.g. 'dsh-plugin-xxx'. */
  repo: string
  /** owner/repo */
  fullName: string
  description: string | null
  htmlUrl: string
  cloneUrl: string
  stars: number
  forks: number
  language: string | null
  /** ISO date string of the last push. */
  updatedAt: string
  topics: string[]
  avatarUrl: string
  defaultBranch: string
  /** 来源源 id(卡片/弹窗据此分支展示;GitHub 源不填)。 */
  source?: MarketSourceId
  /** 源B:近 30 天安装量。 */
  installs30d?: number
  /** 源C:质量评分(0-100)。 */
  score?: number
  /** 源C:风险标记。 */
  isRisky?: boolean
  /** 源C:风险说明。 */
  riskNote?: string
  /** 源C:仓库已归档。 */
  archived?: boolean
  /** 源B:从 install 命令解析出的子包路径(下载时作为 subdir 提示)。 */
  subdirHint?: string
}

export interface MarketPage {
  ok: boolean
  repos: MarketRepo[]
  totalCount: number
  page: number
  /** 该源实际每页条数(源B 服务端固定 100/页,忽略 per_page 参数);缺省时用配置的 marketPageSize。 */
  pageSize?: number
  error?: string
  /** 源B/源C 的分类列表(含计数);GitHub 源不填,渲染层直接用 MARKET_CATEGORIES。 */
  categories?: SourceCategory[]
}

export interface MarketReadme {
  ok: boolean
  /** Raw markdown of the repository README. */
  text?: string
  error?: string
}

/** Input for creating a new DSH instance. */
export interface NewInstanceInput {
  /** Exact DSH version; requires an isolated data home. Empty inherits global settings. */
  runtimeVersion?: string
  name: string
  /** DSH profile base; required for kind 'dsh', ignored for 'gui'. */
  profile?: string
  /** DSH port; required for kind 'dsh', ignored for 'gui'. */
  port?: number
  autoStart: boolean
  /** User-set note shown on the instance card. */
  description?: string
  /** 'isolated' = 新建独立 DSH_HOME(复制所选 home 的 .credentials.yaml);缺省 'shared'(共享到 home 字段指定的 home)。 */
  homeMode?: 'shared' | 'isolated'
  /** homeMode='shared' 时的共享目标 home 路径;缺省 = 全局 cfg.dshHome(现状行为)。isolated 时忽略。 */
  home?: string
  /** 'dsh'(缺省) 创建 DSH 实例;'web' 创建端口探活 WebUI;'gui' 创建桌面应用附属窗口;'ps' 创建 PowerShell 脚本实例。 */
  kind?: 'dsh' | 'web' | 'gui' | 'ps'
  /** kind==='gui' 时的可执行文件绝对路径。 */
  exe?: string
  /** kind==='gui' 时的启动参数(每项原样传给子进程)。 */
  args?: string[]
  /** kind==='gui' 时可选的主窗口标题过滤。 */
  windowTitle?: string
  /** kind==='gui' 时的窗口选择/接管策略。 */
  windowPolicy?: GuiWindowPolicy
  /** kind==='gui' 时的精确窗口类名过滤。 */
  windowClass?: string
  /** 创建时使用的桌面应用 preset。 */
  guiPresetId?: GuiAppPresetId
  /** Chrome GUI 实例 profile 模式。 */
  chromeProfileMode?: GuiChromeProfileMode
  /** 实例图标(绝对路径或 data URL)。 */
  icon?: string
  /** 用户手动锁定的图标;自动发现/预设刷新不得覆盖。 */
  iconLocked?: boolean
  /** 无图片图标时的色块颜色。 */
  iconColor?: string
  /** 无图片图标时的色块单字。 */
  iconChar?: string
  /** kind==='web' / 'ps' 的启动命令。 */
  command?: string
  /** kind==='web' 的健康检查路径,默认 '/'。 */
  healthPath?: string
  /** kind==='web' / 'ps' 的工作目录。 */
  workspace?: string
  /** 创建时选择的资料。 */
  profileId?: string
}

/** 整合包安装选项:新建实例的数据目录选择 + 失败插件重试清单。 */
export interface BundleInstallOptions {
  /** 'isolated' = 为整合包新建独立 DSH_HOME;缺省 'shared'(共享到 home 字段指定的 home)。 */
  homeMode?: 'shared' | 'isolated'
  /** homeMode='shared' 时的共享目标 home 路径;缺省 = 全局 cfg.dshHome。 */
  home?: string
  /** 上次安装失败的插件 spec 清单(bundleFailed):只重装这些,跳过建实例与成功项。 */
  retrySpecs?: string[]
}

/**
 * A plugin that ships with a recommended bundle (整合包). 有公开源,安装时用
 * `dsh plugin add <spec>` 直装最新版;`name` 仅用于展示。
 */
/** 插件包插件项(对齐 dsh-plugin-pack 规范):plugin = 宿主/基础,extension = 扩展。 */
export interface BundlePlugin {
  /** 插件 id(包内唯一,供 requires 引用)。缺省用 name。 */
  id?: string
  /** 展示名(去掉 scope / dsh- 前缀后更易读)。 */
  name?: string
  /** 插件种类:plugin(宿主/基础)或 extension(扩展,需 requires 指向宿主)。缺省 plugin。 */
  kind?: 'plugin' | 'extension'
  /** 依赖的包内插件 id(extension 用)。 */
  requires?: string[]
  /** `dsh plugin add <spec>` 的源:npm 包名、`github:owner/repo` 或 URL。 */
  spec?: string
  /** 源码仓库 URL(展示用)。 */
  repository?: string
  /** 插件的中文功能简介(详情弹窗展示)。 */
  description?: string
  /** 额外透传给 `dsh plugin add` 的参数(原样追加,用于绕过不可满足的 peer 依赖等)。 */
  flags?: string[]
}

/**
 * A recommended bundle (整合包):对齐 dsh-plugin-pack 的清单结构。
 * 下载时新建实例,并逐个 `dsh plugin add` 直装最新版。
 */
export interface RecommendedBundle {
  /** dsh-plugin-pack schema 版本。 */
  schemaVersion?: number
  id: string
  name: string
  version?: string
  description: string
  license?: string
  /** Base name for the new instance's profile (defaults to `web`). */
  profileBase?: string
  /** 插件清单 —— 计入数量,安装时逐个 `dsh plugin add` 直装。 */
  community: BundlePlugin[]
}

export interface GuiAppPreset {
  id: GuiAppPresetId
  name: string
  /** Absolute executable path. */
  exe: string
  args: string[]
  windowPolicy: GuiWindowPolicy
  windowClass?: string
  windowTitle?: string
  /** Bundled absolute icon path filled by the main process. */
  icon?: string
  /** Discovery caveat shown as a tooltip in the launcher UI. */
  note?: string
  /** Chrome preset default; isolated keeps user's normal Chrome untouched. */
  chromeProfileMode?: GuiChromeProfileMode
}

/** Availability of one GUI instance executable for card health display. */
export interface GuiExecutableCheckResult {
  exe: string
  available: boolean
}

/** Cached, non-blocking GUI app discovery snapshot returned to the renderer. */
export interface GuiExecutableRepairResult {
  ok: boolean
  oldExe: string
  newExe: string | null
  presetId?: GuiAppPresetId
  error?: string
}

export interface GuiAppDiscoverySnapshot {
  presets: GuiAppPreset[]
  /** True when the returned presets came from the memory/disk cache. */
  cached: boolean
  /** True while a background refresh is running. */
  refreshing: boolean
  /** True when one of the batched PowerShell probes hit its deadline. */
  timedOut: boolean
  error: string | null
  /** Epoch ms of the last completed discovery. */
  updatedAt: number | null
  /** Per-phase timings from the last completed discovery. */
  timings: Record<string, number>
}

export interface DshLauncherApi {
  listDshRuntimeVersions(): Promise<DshRuntimeCatalog>
  getInstanceRuntime(instanceId: string): Promise<InstanceRuntimeInfo>
  installInstanceRuntime(instanceId: string): Promise<CmdResult>
  getState(): Promise<BootstrapState>
  /** Start one instance (idle/external → running). */
  startInstance(instanceId: string): Promise<CmdResult>
  /** Stop one instance. */
  stopInstance(instanceId: string): Promise<void>
  /** Stop then start one instance. */
  restartInstance(instanceId: string): Promise<CmdResult>
  /** Stop every managed instance through the serial lifecycle queue. */
  stopAllInstances(): Promise<CmdResult>
  /** Restore one embedded GUI window and leave its process running. */
  detachInstanceKeepAlive(instanceId: string): Promise<CmdResult>
  /** Re-attach a GUI instance to an already-running window without spawning a new process. */
  adoptExistingGuiInstance(instanceId: string): Promise<CmdResult>
  /** Switch the UI's active instance and show its embedded DSH view. */
  setActiveInstance(instanceId: string): Promise<LauncherConfig>
  /** Open a native file picker for a GUI instance executable. */
  pickGuiExecutable(): Promise<string | null>
  /** Detected Antigravity / Codex desktop installs, used as quick-fill presets. */
  discoverGuiApps(): Promise<GuiAppDiscoverySnapshot>
  /** Force a background discovery refresh; resolves within the 3s budget. */
  refreshGuiAppsDiscovery(): Promise<GuiAppDiscoverySnapshot>
  /** Check whether one GUI instance's configured executable is available. */
  checkGuiExecutable(instanceId: string): Promise<GuiExecutableCheckResult>
  /** Re-discover and persist a GUI instance executable (AppX upgrade self-heal). */
  repairGuiExecutable(instanceId: string): Promise<GuiExecutableRepairResult>
  /** Create a new instance and return the new config. */
  addInstance(input: NewInstanceInput): Promise<LauncherConfig>
  /** Rename / re-profile / re-port / toggle autoStart of an instance. */
  updateInstance(instanceId: string, patch: Partial<DshInstance>): Promise<LauncherConfig>
  /** Delete an instance (refuses the last one). */
  removeInstance(instanceId: string): Promise<LauncherConfig>
  /** Open the instance's DSH Web UI in the system browser. Optional instance id; defaults to the active instance. */
  openUi(instanceId?: string): Promise<void>
  /** Open the instance's DSH Web UI in a launcher child window (multi-screen), focusing it if already open. */
  openInstanceWindow(instanceId: string): Promise<void>
  /** Close the instance's separate window, popping it back into the embedded launcher view. */
  closeInstanceWindow(instanceId: string): Promise<void>
  getConfig(): Promise<LauncherConfig>
  setConfig(patch: Partial<LauncherConfig>): Promise<LauncherConfig>
  /** Current local cookie bridge status (token, port, connection and counters). */
  bridgeGetState(): Promise<CookieBridgeState>
  /** Persist bridge settings and restart the loopback server when needed. */
  bridgeSetConfig(patch: CookieBridgeConfigPatch): Promise<CookieBridgeState>
  /** Invalidate enrollment/reconnect secrets and issue a fresh one-time token. */
  bridgeRegenerateToken(): Promise<CookieBridgeState>
  /** Plugin list for the active instance (installed + local). */
  listPlugins(): Promise<PluginListResult>
  /** The plugin×instance matrix for the local-plugins page. */
  listPluginMatrix(): Promise<PluginMatrixResult>
  /** Persist a plugin's display-name override / remark. */
  setPluginMeta(name: string, meta: PluginMeta): Promise<void>
  /** Install a plugin into an instance's profile and enable it. `name` (the package name) is passed by the matrix so enablement is explicit; when omitted, the newly-added dependency is enabled automatically. */
  installPlugin(instanceId: string, spec: string, name?: string): Promise<CmdResult>
  /** Uninstall a plugin from an instance's profile (removes it from both dependencies and bundles). */
  disablePlugin(instanceId: string, name: string): Promise<CmdResult>
  enablePlugin(instanceId: string, name: string): Promise<CmdResult>
  uninstallPlugin(instanceId: string, name: string): Promise<CmdResult>
  /** Reinstall/update an installed plugin (git pull + reinstall for `file:` plugins, `dsh plugin up` otherwise). */
  updatePlugin(instanceId: string, name: string): Promise<CmdResult>
  /** Update a locally-held plugin (by local path): uninstall its repo's plugins from all instances, pull latest from GitHub, reinstall. */
  updateLocalPlugin(localPath: string): Promise<CmdResult>
  /** Remove a plugin from the local library entirely: delete its source folder and uninstall it from every instance. */
  removeFromLibrary(name: string): Promise<CmdResult>
  /** Remove several plugins from the local library in one go (批量删除本地插件): delete each source folder and uninstall it from every instance. */
  removeFromLibraryMany(names: string[]): Promise<CmdResult>
  /** 本地库条目的仓库归属(一个仓库可能含多个插件);找不到时返回 null。 */
  libraryRepoInfo(name: string): Promise<{ repoName: string; plugins: { name: string }[] } | null>
  /** 删除整个本地库仓库:卸载并删除它名下的全部插件。 */
  removeRepoFromLibrary(name: string): Promise<CmdResult>
  repairDeps(): Promise<CmdResult>
  rebuild(): Promise<CmdResult>
  /** Clone/update the harness repo, install deps, then auto-configure paths. */
  downloadHarness(): Promise<CmdResult>
  /** Clone a plugin from a GitHub repo URL into pluginDir, then install it into an instance's profile. An optional repo-relative subdir installs that sub-package (some repos ship plugins in subfolders). */
  downloadPlugin(url: string, subdir?: string, instanceId?: string): Promise<CmdResult>
  /** Download a recommended bundle (整合包): create the instance and `dsh plugin add` each community plugin into its profile. Options: `homeMode`/`home` pick the new instance's data directory (shared target or a fresh isolated DSH_HOME); `retrySpecs` (previous `bundleFailed`) re-installs only the failed plugins into the existing instance. */
  installBundle(bundleId: string, options?: BundleInstallOptions): Promise<CmdResult>
  /** Download + unpack the portable runtime (Node, bundled dsh, pnpm) and auto-configure paths. */
  installRuntime(): Promise<CmdResult>
  /** Upgrade only the bundled dsh package inside runtimeRoot; leaves ~/.dsh untouched. */
  updateRuntime(): Promise<CmdResult>
  /** DeepSeek balance for the configured API key. */
  getBalance(): Promise<BalanceResult>
  /** Security: list all audited session data-flow events (from the dsh-audit probe). */
  securityList(): Promise<SecurityAuditEvent[]>
  /** Security: truly delete all audit history files. */
  securityClearAudit(): Promise<{ ok: boolean; removed: number }>
  /** Security: export the full aggregated audit log to a user-chosen file (JSONL). */
  securityExportAudit(): Promise<{ ok: boolean; code: number | null; error?: string; canceled?: boolean; count?: number }>
  /** Security: current third-party tool whitelist (read from file). */
  securityGetWhitelist(): Promise<string[]>
  /** Security: open the whitelist file with the system editor. */
  securityOpenWhitelistFile(): Promise<CmdResult>
  /** Security: current probe/settings. */
  securityGetConfig(): Promise<SecurityConfig>
  /** Security: update probe/settings. */
  securitySetConfig(patch: Partial<SecurityConfig>): Promise<SecurityConfig>
  /** Security: per-instance probe (dsh-audit) status. */
  securityListProbeStatus(): Promise<ProbeStatus[]>
  /** Security: install the probe (npm dsh-audit) into one instance. */
  securityInstallProbe(instanceId: string): Promise<CmdResult>
  /** Security: uninstall the probe from one instance. */
  securityRemoveProbe(instanceId: string): Promise<CmdResult>
  /** Security: reinstall the probe (latest) on one instance. */
  securityReinstallProbe(instanceId: string): Promise<CmdResult>
  /** One page of the plugin market: GitHub repos tagged `dsh-plugin`, sorted by stars. An optional keyword and an optional category id (see shared/market-categories.ts) are combined server-side with GitHub search qualifiers. */
  searchMarket(sourceId: MarketSourceId, page: number, query?: string, categoryId?: string, force?: boolean): Promise<MarketPage>
  /** Raw markdown of a repository README for the market detail modal. */
  fetchMarketReadme(owner: string, repo: string): Promise<MarketReadme>
  /** Show a confirm dialog for an external link, then open it in the system browser if confirmed. */
  confirmOpenExternal(url: string): Promise<boolean>
  /** Show/hide the embedded DSH view for an instance; reload when the harness (re)became ready. */
  setDshActive(instanceId: string, active: boolean, reload?: boolean): void
  /** Show/hide a GUI instance's owned native window (only the active one is visible). */
  setGuiActive(instanceId: string, active: boolean): void
  /** Web chat (虚拟实例) cards: popout → separate window; embedded keeps one live view per card (`chatId`) so switching cards / leaving and returning never reloads. `forceReload` (double-click refresh / F5) reloads it. */
  setWebChat(show: boolean, chatId: string, url: string, popout: boolean, forceReload?: boolean): void
  /** Release a web-chat card's persistent embedded view immediately (e.g. the card was removed). */
  releaseWebChat(chatId: string): void
  /** Reload the current page in an embedded web-chat view without resetting its URL. */
  reloadWebChat(chatId: string): void
  /** Ids of web-chat cards whose embedded view is currently kept alive (polled once at mount). */
  getWebChatAlive(): Promise<string[]>
  /** Resolve and validate a link favicon; custom icons bypass this in the renderer. */
  resolveLinkFavicon(url: string): Promise<string | null>
  /** Scan Chrome User Data/Local State and return read-only profile descriptors. */
  scanChromeProfiles(): Promise<Profile[]>
  /** Sync the sidebar width so the DSH view sits flush against it. */
  setDshSidebarWidth(width: number): void
  /** Reserve the top-bar height above embedded DSH/web views. */
  setDshTopInset(height: number): void
  /** Reserve top/right/bottom chrome space for GUI windows (S2 top bar can pass its height). */
  setGuiContentInsets(insets: { top?: number; right?: number; bottom?: number }): void
  /** Show/hide the floating whale orb (used while the DSH view is open with floatingWhale enabled). */
  setOrbVisible(visible: boolean): void
  /** The orb page: press start, reporting the pointer offset within the orb view. */
  orbDragStart(ox: number, oy: number): void
  /** The orb page: pointer's absolute screen position while dragging (the view follows it). */
  orbDragMove(sx: number, sy: number): void
  /** The orb page: drag finished (position kept). */
  orbDragEnd(): void
  /** The orb page: short click — return the orb to the top-left and expand the menu. */
  orbClick(): void
  /** Fired when the floating orb is clicked — the launcher should expand its sidebar. */
  onOrbClicked(cb: () => void): () => void
  onEvent(cb: (e: LauncherEvent) => void): () => void
  clearLogs(): Promise<boolean>
  confirm(message: string): Promise<boolean>
  bundles(): Promise<{ bundles: RecommendedBundle[]; connected: boolean }>
}
