import { join } from 'node:path'
import type { GuiChromeProfileMode } from '../shared/types'

/** True when the executable's basename is chrome.exe. */
export function isChromeExecutable(exePath: string): boolean {
  return /(?:^|[\\/])chrome\.exe$/i.test(exePath.trim())
}

/** Per-instance Chrome profile directory under %APPDATA%\dsh-launcher. */
export function chromeProfileDir(appDataDir: string, instanceId: string): string {
  const safeId = instanceId.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'instance'
  return join(appDataDir, 'dsh-launcher', 'chrome-profiles', safeId)
}

/** Add the isolated --user-data-dir + a guaranteed new-window request. */
export function chromeLaunchArgs(args: readonly string[], profileDir: string): string[] {
  const out = args.filter((arg) => !/^--user-data-dir=/i.test(arg))
  if (!out.some((arg) => /^--new-window$/i.test(arg))) out.push('--new-window')
  const flags = ['--no-first-run', '--no-default-browser-check'].filter(
    (flag) => !out.some((arg) => arg.toLowerCase() === flag)
  )
  return [`--user-data-dir=${profileDir}`, ...flags, ...out]
}

/** Resolve the effective mode for a Chrome instance (legacy configs use the isolated profile). */
export function resolveChromeProfileMode(mode: GuiChromeProfileMode | undefined): GuiChromeProfileMode {
  return mode === 'shared' ? 'shared' : 'isolated'
}
