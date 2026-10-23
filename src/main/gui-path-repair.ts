import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { GuiAppPresetId } from '../shared/types'
import type { GuiDiscoveryResult } from './gui-discovery'

export interface GuiExecutableRepairInput {
  exe: string
  guiPresetId?: GuiAppPresetId
}

export interface GuiExecutableRepair {
  oldExe: string
  newExe: string | null
  presetId?: GuiAppPresetId
  source?: 'existing' | 'discovery' | 'windowsapps'
}

const PRESET_IDS = new Set<GuiAppPresetId>([
  'antigravity',
  'codex',
  'claude',
  'wechat',
  'chrome',
  'typora',
  'vscode',
  'zotero',
  'qoder',
  'zcode'
])

/** Program Files\WindowsApps is ACL-restricted; a missing stat there does not mean the package is absent. */
const WINDOWS_APPS_EXE = /^[a-z]:\\program files(?: \(x86\))?\\windowsapps\\/i

/** True when the path names an executable under the protected WindowsApps store. */
export function isWindowsAppsExecutablePath(exe: string): boolean {
  return WINDOWS_APPS_EXE.test(exe.trim().replaceAll('/', '\\'))
}

/**
 * Check whether a GUI instance executable can be used. WindowsApps entries are
 * accepted without a stat because the store ACL commonly rejects it for a normal
 * user process even while the package executable is valid.
 */
export function isGuiExecutableAvailable(exe: string): boolean {
  const value = exe.trim()
  if (!value) return false
  return isWindowsAppsExecutablePath(value) || existsSync(value)
}

const WINDOWS_APPS_LAYOUT: Partial<Record<GuiAppPresetId, { pattern: RegExp; relative: string[] }>> = {
  codex: { pattern: /^OpenAI\.Codex_/i, relative: ['app', 'ChatGPT.exe'] },
  claude: { pattern: /^Claude_/i, relative: ['app', 'Claude.exe'] },
  vscode: { pattern: /^Microsoft\.VisualStudioCode_/i, relative: ['Code.exe'] },
  typora: { pattern: /^Typora_/i, relative: ['Typora.exe'] },
  zotero: { pattern: /^Zotero_/i, relative: ['zotero.exe'] }
}

/** Infer the preset from an explicit selection or the executable basename. */
export function inferGuiPresetId(input: GuiExecutableRepairInput): GuiAppPresetId | null {
  if (input.guiPresetId && PRESET_IDS.has(input.guiPresetId)) return input.guiPresetId
  const name = basename(input.exe).toLowerCase()
  if (name === 'antigravity.exe') return 'antigravity'
  if (name === 'chatgpt.exe' || name === 'codex.exe') return 'codex'
  if (name === 'claude.exe') return 'claude'
  if (name === 'weixin.exe' || name === 'wechat.exe') return 'wechat'
  if (name === 'chrome.exe') return 'chrome'
  if (name === 'typora.exe') return 'typora'
  if (name === 'code.exe') return 'vscode'
  if (name === 'zotero.exe') return 'zotero'
  if (name === 'qoder.exe' || name === 'qoder cn.exe') return 'qoder'
  if (name === 'zcode.exe') return 'zcode'
  return null
}

/** Pick the newest versioned WindowsApps package executable for an AppX preset. */
export function latestWindowsAppsExecutable(programFilesDir: string, presetId: GuiAppPresetId): string | null {
  const layout = WINDOWS_APPS_LAYOUT[presetId]
  if (!layout) return null
  const root = join(programFilesDir, 'WindowsApps')
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  const packages = entries
    .filter((entry) => entry.isDirectory() && layout.pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const name of packages) {
    const candidate = join(root, name, ...layout.relative)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Resolve a missing executable via discovery, then versioned WindowsApps fallback. */
export async function resolveGuiExecutable(
  input: GuiExecutableRepairInput,
  discover: () => Promise<GuiDiscoveryResult>
): Promise<GuiExecutableRepair> {
  const oldExe = input.exe.trim()
  if (oldExe && existsSync(oldExe)) {
    return { oldExe, newExe: oldExe, presetId: inferGuiPresetId(input) ?? undefined, source: 'existing' }
  }
  const presetId = inferGuiPresetId(input) ?? undefined
  if (presetId) {
    try {
      const result = await discover()
      const preset = result.presets.find((item) => item.id === presetId)
      if (preset?.exe && existsSync(preset.exe)) {
        return { oldExe, newExe: preset.exe, presetId, source: 'discovery' }
      }
    } catch {
      // Discovery is best effort; the versioned WindowsApps scan below still runs.
    }
    const programFiles = process.env.ProgramFiles?.trim() || process.env.PROGRAMFILES?.trim() || 'C:\\Program Files'
    const fallback = latestWindowsAppsExecutable(programFiles, presetId)
    if (fallback) return { oldExe, newExe: fallback, presetId, source: 'windowsapps' }
  }
  return { oldExe, newExe: null, presetId }
}
