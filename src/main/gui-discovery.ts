// Locate the desktop apps this launcher ships GUI-instance presets for.
// Discovery is deliberately asynchronous and bounded: one batched AppX query,
// one batched shortcut-resolution PowerShell call, plus millisecond-level known
// path checks. It never blocks the Electron main thread on PowerShell.

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import type { GuiAppPreset } from '../shared/types'

const execFileAsync = promisify(execFile)

/** Hard budget for one discovery pass. */
export const GUI_DISCOVERY_TIMEOUT_MS = 3000
const PS_TIMEOUT_MS = 2400
const SHORTCUT_PROBE_TIMEOUT_MS = 2200

export interface GuiShortcut {
  path: string
  targetPath: string
  arguments: string
  workingDirectory: string
}

export interface GuiDiscoveryResult {
  presets: GuiAppPreset[]
  timings: Record<string, number>
  timedOut: boolean
  error?: string
}

export interface KnownGuiInstalls {
  antigravity?: string
  codex?: string
  wechat?: string
  chrome?: string
  typora?: string
  vscode?: string
  zotero?: string
  qoder?: string
  zcode?: string
}

/** Candidate Antigravity install paths for the current user/machine. */
export function antigravityCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const local = env.LOCALAPPDATA?.trim()
  const programFiles = env.ProgramFiles?.trim() || env.PROGRAMFILES?.trim()
  const out: string[] = []
  if (local) {
    out.push(join(local, 'Programs', 'antigravity', 'Antigravity.exe'))
    out.push(join(local, 'Programs', 'Antigravity', 'Antigravity.exe'))
  }
  if (programFiles) out.push(join(programFiles, 'Antigravity', 'Antigravity.exe'))
  return [...new Set(out)]
}

/** Common unpackaged Codex/ChatGPT desktop installs under LOCALAPPDATA. */
export function codexCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const local = env.LOCALAPPDATA?.trim()
  if (!local) return []
  const bases = [
    join(local, 'Programs', 'Codex'),
    join(local, 'Programs', 'codex'),
    join(local, 'Programs', 'OpenAI Codex'),
    join(local, 'Programs', 'OpenAI', 'Codex'),
    join(local, 'Programs', 'ChatGPT')
  ]
  const out: string[] = []
  for (const base of bases) {
    out.push(join(base, 'Codex.exe'))
    out.push(join(base, 'ChatGPT.exe'))
  }
  return [...new Set(out)]
}

/** Common Google Chrome installs on Windows. */
export function chromeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const local = env.LOCALAPPDATA?.trim()
  const programFiles = env.ProgramFiles?.trim() || env.PROGRAMFILES?.trim()
  const programFilesX86 = env['ProgramFiles(x86)']?.trim()
  const out: string[] = []
  if (local) out.push(join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  if (programFiles) out.push(join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  if (programFilesX86) out.push(join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  return [...new Set(out)]
}

/** Common WeChat/Weixin installs, including the 4.x Weixin layout. */
export function wechatCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const programFiles = env.ProgramFiles?.trim() || env.PROGRAMFILES?.trim()
  const programFilesX86 = env['ProgramFiles(x86)']?.trim()
  const out: string[] = []
  if (programFiles) {
    out.push(join(programFiles, 'Tencent', 'Weixin', 'Weixin.exe'))
    out.push(join(programFiles, 'Tencent', 'WeChat', 'WeChat.exe'))
  }
  if (programFilesX86) {
    out.push(join(programFilesX86, 'Tencent', 'Weixin', 'Weixin.exe'))
    out.push(join(programFilesX86, 'Tencent', 'WeChat', 'WeChat.exe'))
  }
  return [...new Set(out)]
}

/** Candidate Typora installs; Store/AppX packages are resolved separately. */
export function typoraCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const local = env.LOCALAPPDATA?.trim()
  const programFiles = env.ProgramFiles?.trim() || env.PROGRAMFILES?.trim()
  const programFilesX86 = env['ProgramFiles(x86)']?.trim()
  const out: string[] = []
  if (local) {
    out.push(join(local, 'Programs', 'Typora', 'Typora.exe'))
    out.push(join(local, 'Typora', 'Typora.exe'))
  }
  if (programFiles) out.push(join(programFiles, 'Typora', 'Typora.exe'))
  if (programFilesX86) out.push(join(programFilesX86, 'Typora', 'Typora.exe'))
  return [...new Set(out)]
}

/** Candidate Visual Studio Code installs, including per-user and machine-wide layouts. */
export function vscodeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const local = env.LOCALAPPDATA?.trim()
  const programFiles = env.ProgramFiles?.trim() || env.PROGRAMFILES?.trim()
  const programFilesX86 = env['ProgramFiles(x86)']?.trim()
  const out: string[] = []
  if (local) {
    out.push(join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'))
    out.push(join(local, 'Programs', 'VSCode', 'Code.exe'))
  }
  if (programFiles) {
    out.push(join(programFiles, 'Microsoft VS Code', 'Code.exe'))
    out.push(join(programFiles, 'VSCode', 'Code.exe'))
  }
  if (programFilesX86) {
    out.push(join(programFilesX86, 'Microsoft VS Code', 'Code.exe'))
    out.push(join(programFilesX86, 'VSCode', 'Code.exe'))
  }
  return [...new Set(out)]
}

/** Candidate Zotero installs (Zotero 7 is XUL/GTK based). */
export function zoteroCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const local = env.LOCALAPPDATA?.trim()
  const programFiles = env.ProgramFiles?.trim() || env.PROGRAMFILES?.trim()
  const programFilesX86 = env['ProgramFiles(x86)']?.trim()
  const out: string[] = []
  if (local) out.push(join(local, 'Programs', 'Zotero', 'zotero.exe'))
  if (programFiles) out.push(join(programFiles, 'Zotero', 'zotero.exe'))
  if (programFilesX86) out.push(join(programFilesX86, 'Zotero', 'zotero.exe'))
  return [...new Set(out)]
}

/** Candidate Qoder installs. The launcher shim is a last-resort fallback. */
export function qoderCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const local = env.LOCALAPPDATA?.trim()
  const programFiles = env.ProgramFiles?.trim() || env.PROGRAMFILES?.trim()
  const programFilesX86 = env['ProgramFiles(x86)']?.trim()
  const out: string[] = []
  if (local) {
    out.push(join(local, 'Programs', 'Qoder CN', 'Qoder CN.exe'))
    out.push(join(local, 'Programs', 'Qoder', 'Qoder.exe'))
    out.push(join(local, 'Qoder CN', 'Qoder CN Launcher', 'Qoder CN Launcher.exe'))
  }
  if (programFiles) {
    out.push(join(programFiles, 'Qoder CN', 'Qoder CN.exe'))
    out.push(join(programFiles, 'Qoder', 'Qoder.exe'))
  }
  if (programFilesX86) {
    out.push(join(programFilesX86, 'Qoder CN', 'Qoder CN.exe'))
    out.push(join(programFilesX86, 'Qoder', 'Qoder.exe'))
  }
  return [...new Set(out)]
}

/** Candidate ZCode installs. */
export function zcodeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const local = env.LOCALAPPDATA?.trim()
  const programFiles = env.ProgramFiles?.trim() || env.PROGRAMFILES?.trim()
  const programFilesX86 = env['ProgramFiles(x86)']?.trim()
  const out: string[] = []
  if (local) out.push(join(local, 'Programs', 'ZCode', 'ZCode.exe'))
  if (programFiles) out.push(join(programFiles, 'ZCode', 'ZCode.exe'))
  if (programFilesX86) out.push(join(programFilesX86, 'ZCode', 'ZCode.exe'))
  return [...new Set(out)]
}

/** Map a VS Code AppX install directory to its full-trust executable. */
export function vscodeExecutableFromInstallLocation(location: string): string {
  return join(location.trim(), 'Code.exe')
}

/** Known-path installs, resolved with only filesystem existence checks. */
export function knownGuiInstalls(env: NodeJS.ProcessEnv = process.env): KnownGuiInstalls {
  return {
    antigravity: antigravityCandidates(env).find((candidate) => existsSync(candidate)),
    codex: codexCandidates(env).find((candidate) => existsSync(candidate)),
    wechat: wechatCandidates(env).find((candidate) => existsSync(candidate)),
    chrome: chromeCandidates(env).find((candidate) => existsSync(candidate)),
    typora: typoraCandidates(env).find((candidate) => existsSync(candidate)),
    vscode: vscodeCandidates(env).find((candidate) => existsSync(candidate)),
    zotero: zoteroCandidates(env).find((candidate) => existsSync(candidate)),
    qoder: qoderCandidates(env).find((candidate) => existsSync(candidate)),
    zcode: zcodeCandidates(env).find((candidate) => existsSync(candidate))
  }
}

/** Desktop and Start Menu folders that can contain app shortcuts. */
export function shortcutSearchDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.USERPROFILE?.trim()
  const appData = env.APPDATA?.trim()
  const programData = env.ProgramData?.trim()
  const publicDir = env.PUBLIC?.trim()
  return [
    home ? join(home, 'Desktop') : '',
    publicDir ? join(publicDir, 'Desktop') : '',
    appData ? join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '',
    programData ? join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : ''
  ].filter(Boolean)
}

/** AppExecutionAlias files and installer shims are not real GUI executables. */
export function isStubExecutable(path: string): boolean {
  const name = basename(path).toLowerCase()
  if (['update.exe', 'squirrel.exe', 'launcher.exe', 'explorer.exe', 'cmd.exe', 'powershell.exe'].includes(name)) return true
  try {
    if (statSync(path).size === 0) return true
  } catch {
    return true
  }
  return false
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function collectShortcutFiles(
  dir: string,
  matcher: (name: string) => boolean,
  out: string[],
  deadline: number,
  depth: number,
  maxDepth: number
): Promise<void> {
  if (depth > maxDepth || Date.now() >= deadline) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    // Junctions/symlinks can point at multi-hundred-thousand-file project
    // trees (including node_modules); shortcut roots never need to follow them.
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < maxDepth) await collectShortcutFiles(full, matcher, out, deadline, depth + 1, maxDepth)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lnk') && matcher(entry.name)) {
      out.push(full)
    }
  }
}

async function resolveShortcutFiles(files: readonly string[], timeoutMs = PS_TIMEOUT_MS): Promise<GuiShortcut[]> {
  if (files.length === 0 || process.platform !== 'win32') return []
  const escaped = files.map(psQuote).join(', ')
  const command = `$ErrorActionPreference = 'Stop'; $shell = New-Object -ComObject WScript.Shell; $items = @(${escaped}) | ForEach-Object { if (Test-Path -LiteralPath $_) { $s = $shell.CreateShortcut($_); [pscustomobject]@{ path = $_; targetPath = $s.TargetPath; arguments = $s.Arguments; workingDirectory = $s.WorkingDirectory } } }; $items | ConvertTo-Json -Compress`
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    })
    const text = stdout.trim()
    if (!text) return []
    const parsed = JSON.parse(text) as GuiShortcut | GuiShortcut[]
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

/** Resolve matching .lnk files through one WScript.Shell PowerShell call. */
export async function resolveGuiShortcuts(
  matcher: (name: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = PS_TIMEOUT_MS
): Promise<GuiShortcut[]> {
  if (process.platform !== 'win32') return []
  const deadline = Date.now() + Math.max(200, timeoutMs - 100)
  const files: string[] = []
  for (const dir of shortcutSearchDirs(env)) {
    if (Date.now() >= deadline) break
    // Desktop roots only hold .lnk files directly; recursing into them walks
    // the user's entire project tree. Start Menu app folders are shallow.
    const maxDepth = basename(dir).toLowerCase() === 'desktop' ? 0 : 4
    await collectShortcutFiles(dir, matcher, files, deadline, 0, maxDepth)
  }
  if (files.length === 0) return []
  return await resolveShortcutFiles(files, Math.max(200, deadline - Date.now()))
}

/** One batched shortcut scan for every app we know how to launch. */
async function resolveAllGuiShortcuts(
  env: NodeJS.ProcessEnv,
  timeoutMs = SHORTCUT_PROBE_TIMEOUT_MS
): Promise<GuiShortcut[]> {
  return await resolveGuiShortcuts(
    (name) =>
      /claude|wechat|weixin|微信|chrome|typora|visual studio code|vscode|zotero|qoder|zcode/i.test(name) &&
      !/history viewer/i.test(name),
    env,
    Math.max(400, timeoutMs - 100)
  )
}

interface Timed<T> {
  value?: T
  timedOut: boolean
  error?: unknown
  elapsedMs: number
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<Timed<T>> {
  return new Promise((resolve) => {
    const started = performance.now()
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ timedOut: true, elapsedMs: performance.now() - started })
    }, timeoutMs)
    timer.unref?.()
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ value, timedOut: false, elapsedMs: performance.now() - started })
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ timedOut: false, error, elapsedMs: performance.now() - started })
      }
    )
  })
}

interface AppxBatchResult {
  locations: Map<string, string>
  timedOut: boolean
  elapsedMs: number
  error?: string
}

/** One PowerShell call for all AppX packages discovery needs. */
async function queryAppxPackages(timeoutMs = PS_TIMEOUT_MS): Promise<AppxBatchResult> {
  if (process.platform !== 'win32') return { locations: new Map(), timedOut: false, elapsedMs: 0 }
  const started = performance.now()
  const command = "$names = @('OpenAI.Codex','Claude','Microsoft.VisualStudioCode'); $items = @(Get-AppxPackage | Where-Object { $names -contains $_.Name } | Select-Object Name,InstallLocation); $items | ConvertTo-Json -Compress"
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      timeout: Math.max(500, timeoutMs - 100),
      maxBuffer: 256 * 1024
    })
    const text = stdout.trim()
    const parsed = text ? JSON.parse(text) : []
    const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ Name?: string; InstallLocation?: string }>
    const locations = new Map<string, string>()
    for (const row of rows) {
      if (row.Name && row.InstallLocation) locations.set(row.Name, row.InstallLocation.trim())
    }
    return { locations, timedOut: false, elapsedMs: performance.now() - started }
  } catch (error) {
    return {
      locations: new Map(),
      timedOut: false,
      elapsedMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/** Map a Codex AppX install directory to its main full-trust executable. */
export function codexExecutableFromInstallLocation(location: string): string {
  return join(location.trim(), 'app', 'ChatGPT.exe')
}

/** Map a Claude AppX install directory to its main full-trust executable. */
export function claudeExecutableFromInstallLocation(location: string): string {
  return join(location.trim(), 'app', 'Claude.exe')
}

/** Minimal second-level resolution for Squirrel-style shortcut stubs. */
export function executableFromShortcutArgs(shortcut: GuiShortcut): string | null {
  const match = shortcut.arguments.match(/"([^"]+\.exe)"|([^\s"]+\.exe)/i)
  const raw = match?.[1] ?? match?.[2]
  if (!raw) return null
  const candidates = [
    raw,
    join(shortcut.workingDirectory || dirname(shortcut.targetPath), raw),
    join(dirname(shortcut.targetPath), raw),
    join(dirname(shortcut.targetPath), '..', 'current', raw)
  ]
  return candidates.find((candidate) => candidate && existsSync(candidate) && !isStubExecutable(candidate)) ?? null
}

function executableFromShortcut(shortcut: GuiShortcut): string | null {
  if (shortcut.targetPath && existsSync(shortcut.targetPath) && !isStubExecutable(shortcut.targetPath)) {
    return shortcut.targetPath
  }
  if (shortcut.targetPath || shortcut.arguments) return executableFromShortcutArgs(shortcut)
  return null
}

function shortcutFor(shortcuts: readonly GuiShortcut[], pattern: RegExp): GuiShortcut | undefined {
  return shortcuts.find((shortcut) => pattern.test(shortcut.path))
}

/**
 * Discover installable desktop-app presets with a 3s hard budget. The batched
 * AppX and shortcut PowerShell calls run concurrently; if they miss the budget,
 * known-path results are returned and callers can offer manual browsing.
 */
export async function discoverGuiApps(
  env: NodeJS.ProcessEnv = process.env
): Promise<GuiDiscoveryResult> {
  const started = performance.now()
  const timings: Record<string, number> = {}

  const knownStarted = performance.now()
  const known = knownGuiInstalls(env)
  timings.knownPathsMs = performance.now() - knownStarted

  const appxBudget = GUI_DISCOVERY_TIMEOUT_MS - 300
  const shortcutBudget = SHORTCUT_PROBE_TIMEOUT_MS
  const [appx, shortcuts] = await Promise.all([
    withTimeout(queryAppxPackages(appxBudget), appxBudget),
    withTimeout(resolveAllGuiShortcuts(env, shortcutBudget), shortcutBudget)
  ])
  timings.appxMs = appx.elapsedMs
  timings.shortcutsMs = shortcuts.elapsedMs
  timings.psWaitMs = Math.max(appx.elapsedMs, shortcuts.elapsedMs)

  const shortcutList = shortcuts.value ?? []
  const appxLocations = appx.value?.locations ?? new Map<string, string>()
  const codexFromAppx = appxLocations.has('OpenAI.Codex')
    ? codexExecutableFromInstallLocation(appxLocations.get('OpenAI.Codex')!)
    : null
  const claudeFromAppx = appxLocations.has('Claude')
    ? claudeExecutableFromInstallLocation(appxLocations.get('Claude')!)
    : null
  const vscodeFromAppx = appxLocations.has('Microsoft.VisualStudioCode')
    ? vscodeExecutableFromInstallLocation(appxLocations.get('Microsoft.VisualStudioCode')!)
    : null

  const codexShortcut = shortcutFor(shortcutList, /codex|chatgpt/i)
  const claudeShortcut = shortcutFor(shortcutList, /claude/i)
  const wechatShortcut = shortcutFor(shortcutList, /wechat|weixin|微信/i)
  const chromeShortcut = shortcutFor(shortcutList, /chrome/i)
  const typoraShortcut = shortcutFor(shortcutList, /typora/i)
  const vscodeShortcut = shortcutFor(shortcutList, /visual studio code|vscode/i)
  const zoteroShortcut = shortcutFor(shortcutList, /zotero/i)
  const qoderShortcut = shortcutFor(shortcutList, /qoder/i)
  const zcodeShortcut = shortcutFor(shortcutList, /zcode/i)

  const codex = (codexShortcut ? executableFromShortcut(codexShortcut) : null)
    ?? known.codex
    ?? (codexFromAppx && existsSync(codexFromAppx) ? codexFromAppx : null)
  const claudeFromShortcut = claudeShortcut ? executableFromShortcut(claudeShortcut) : null
  const claudeExe = claudeFromShortcut
    ?? (claudeFromAppx && existsSync(claudeFromAppx) ? claudeFromAppx : null)
  const wechat = (wechatShortcut ? executableFromShortcut(wechatShortcut) : null) ?? known.wechat
  const chrome = (chromeShortcut ? executableFromShortcut(chromeShortcut) : null) ?? known.chrome
  const typora = (typoraShortcut ? executableFromShortcut(typoraShortcut) : null) ?? known.typora
  const vscode = (vscodeShortcut ? executableFromShortcut(vscodeShortcut) : null)
    ?? known.vscode
    ?? (vscodeFromAppx && existsSync(vscodeFromAppx) ? vscodeFromAppx : null)
  const zotero = (zoteroShortcut ? executableFromShortcut(zoteroShortcut) : null) ?? known.zotero
  // The Qoder Start Menu shortcut points at a small launcher shim; prefer the
  // real app executable when a known install path exists.
  const qoder = known.qoder ?? (qoderShortcut ? executableFromShortcut(qoderShortcut) : null)
  const zcode = (zcodeShortcut ? executableFromShortcut(zcodeShortcut) : null) ?? known.zcode

  const presets: GuiAppPreset[] = []
  if (known.antigravity) {
    presets.push({ id: 'antigravity', name: 'Antigravity', exe: known.antigravity, args: [], windowPolicy: 'default' })
  }
  if (codex) {
    presets.push({
      id: 'codex',
      name: 'Codex',
      exe: codex,
      args: [],
      windowPolicy: 'codex-multi',
      windowClass: 'Chrome_WidgetWin_1'
    })
  }
  if (claudeExe) {
    const viaAppx = !claudeFromShortcut && Boolean(claudeFromAppx) && claudeExe === claudeFromAppx
    presets.push({
      id: 'claude',
      name: 'Claude',
      exe: claudeExe,
      args: [],
      windowPolicy: 'default',
      windowClass: 'Chrome_WidgetWin_1',
      ...(viaAppx ? { note: 'Desktop .lnk had no filesystem target (AppX alias); resolved via Get-AppxPackage.' } : {})
    })
  }
  if (wechat) {
    presets.push({
      id: 'wechat',
      name: '微信 / WeChat',
      exe: wechat,
      args: [],
      windowPolicy: 'wechat-main',
      note: 'Only the WeChat main window is embedded; tool windows, owned windows and chat/dialog windows are excluded.'
    })
  }
  if (chrome) {
    presets.push({
      id: 'chrome',
      name: 'Google Chrome',
      exe: chrome,
      args: ['--new-window'],
      windowPolicy: 'chrome-newest',
      windowClass: 'Chrome_WidgetWin_1',
      chromeProfileMode: 'isolated',
      note: 'Embeds only a newly-created Chrome_WidgetWin_1 window; existing Chrome windows are never modified or killed.'
    })
  }

  if (typora) {
    presets.push({
      id: 'typora',
      name: 'Typora',
      exe: typora,
      args: [],
      windowPolicy: 'electron-main',
      windowClass: 'Chrome_WidgetWin_1',
      windowTitle: 'Typora',
      note: 'Electron single-window; a minimized window is restored after attach. If discovery misses it, click "Browse…" and pick Typora.exe.'
    })
  }
  if (vscode) {
    presets.push({
      id: 'vscode',
      name: 'Visual Studio Code',
      exe: vscode,
      args: ['--new-window'],
      windowPolicy: 'vscode-main',
      windowClass: 'Chrome_WidgetWin_1',
      windowTitle: 'Visual Studio Code',
      note: 'Embeds only the new main window created by --new-window; extension-host/devtools windows and existing VS Code windows stay external. If discovery misses it, click "Browse…" and pick Code.exe.'
    })
  }
  if (zotero) {
    presets.push({
      id: 'zotero',
      name: 'Zotero',
      exe: zotero,
      args: [],
      windowPolicy: 'zotero-main',
      windowClass: 'MozillaWindowClass',
      note: 'XUL/GTK MozillaWindowClass; the progress dialog and preferences stay external. If discovery misses it, click "Browse…" and pick zotero.exe.'
    })
  }
  if (qoder) {
    presets.push({
      id: 'qoder',
      name: 'Qoder CN',
      exe: qoder,
      args: [],
      windowPolicy: 'electron-main',
      windowClass: 'Chrome_WidgetWin_1',
      windowTitle: 'Qoder CN',
      note: 'Electron main window; Qoder starts hidden/minimized, so attach restores it. If discovery misses it, click "Browse…" and pick Qoder CN.exe.'
    })
  }
  if (zcode) {
    presets.push({
      id: 'zcode',
      name: 'ZCode',
      exe: zcode,
      args: [],
      windowPolicy: 'electron-main',
      windowClass: 'Chrome_WidgetWin_1',
      windowTitle: 'ZCode',
      note: 'Electron main window; helper/tray windows stay external. If discovery misses it, click "Browse…" and pick ZCode.exe.'
    })
  }

  const expectedIds = [
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
  ] as const
  const missingAny = expectedIds.some((id) => !presets.some((preset) => preset.id === id))
  const timedOut =
    missingAny &&
    (appx.timedOut || shortcuts.timedOut || appx.value?.timedOut === true)
  const errors = [appx.error, appx.value?.error, shortcuts.error].filter((x): x is string => Boolean(x))
  timings.totalMs = performance.now() - started
  console.info(`[gui-discovery] known-paths ${timings.knownPathsMs.toFixed(1)}ms`)
  console.info(`[gui-discovery] appx ${timings.appxMs.toFixed(1)}ms${appx.timedOut ? ' TIMEOUT' : ''}`)
  console.info(`[gui-discovery] shortcuts ${timings.shortcutsMs.toFixed(1)}ms${shortcuts.timedOut ? ' TIMEOUT' : ''}`)
  console.info(`[gui-discovery] total ${timings.totalMs.toFixed(1)}ms presets=${presets.length}${timedOut ? ' TIMEOUT' : ''}`)
  return {
    presets,
    timings,
    timedOut,
    ...(errors.length > 0 ? { error: errors.join('; ') } : {})
  }
}
