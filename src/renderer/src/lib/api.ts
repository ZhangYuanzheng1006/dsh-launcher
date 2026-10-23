import type {
  BalanceData,
  BalanceResult,
  BootstrapState,
  CmdResult,
  DshInstance,
  GuiAppDiscoverySnapshot,
  GuiAppPresetId,
  GuiChromeProfileMode,
  GuiExecutableCheckResult,
  GuiExecutableRepairResult,
  GuiAppPreset,
  GuiWindowPolicy,
  HarnessState,
  InstanceOperationEvent,
  LauncherConfig,
  LauncherEvent,
  LogLine,
  LocalPlugin,
  InstalledPlugin,
  MarketPage,
  MarketReadme,
  MarketRepo,
  NewInstanceInput,
  PluginCellStatus,
  PluginListResult,
  PluginMatrixColumn,
  PluginMatrixResult,
  PluginMatrixRow,
  PluginMeta,
  PluginSubPackage,
  ProbeStatus,
  Profile,
  SecurityAuditEvent,
  WebChatConfig,
  SecurityConfig,
  TaskEvent
} from '../../../shared/types'

export type {
  BalanceData,
  BalanceResult,
  BootstrapState,
  CmdResult,
  DshInstance,
  GuiAppDiscoverySnapshot,
  GuiAppPresetId,
  GuiChromeProfileMode,
  GuiExecutableCheckResult,
  GuiExecutableRepairResult,
  GuiAppPreset,
  GuiWindowPolicy,
  HarnessState,
  InstanceOperationEvent,
  LauncherConfig,
  LauncherEvent,
  LogLine,
  LocalPlugin,
  InstalledPlugin,
  MarketPage,
  MarketReadme,
  MarketRepo,
  NewInstanceInput,
  PluginCellStatus,
  PluginListResult,
  PluginMatrixColumn,
  PluginMatrixResult,
  PluginMatrixRow,
  PluginMeta,
  PluginSubPackage,
  ProbeStatus,
  Profile,
  SecurityAuditEvent,
  WebChatConfig,
  SecurityConfig,
  TaskEvent
}

export interface TaskLog {
  label: string
  running: boolean
  code: number | null
  lines: { stream: 'stdout' | 'stderr'; line: string }[]
  updatedAt: number
  /** 0..1 when determinable, null = indeterminate */
  progress: number | null
  /** short phase label, e.g. '下载 Node' */
  phase: string | null
  startedAt: number
}

export const api = window.dshLauncher
