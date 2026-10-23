// Icon resolution for discovered GUI-app presets. Icons live under final/ at the
// repository root (extraResources copies that directory next to the packaged
// app); no Electron import keeps this testable under plain Node.

import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

export const GUI_ICON_IDS = [
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
export type GuiIconId = typeof GUI_ICON_IDS[number]

/** Map an executable name to the matching bundled preset icon. */
export function guiIconIdForExecutable(exePath: string): GuiIconId | null {
  const name = basename(exePath).toLowerCase()
  if (name === 'antigravity.exe') return 'antigravity'
  if (name === 'codex.exe' || name === 'chatgpt.exe') return 'codex'
  if (name === 'claude.exe') return 'claude'
  if (name === 'wechat.exe' || name === 'weixin.exe') return 'wechat'
  if (name === 'chrome.exe') return 'chrome'
  if (name === 'typora.exe') return 'typora'
  if (name === 'code.exe') return 'vscode'
  if (name === 'zotero.exe') return 'zotero'
  if (name === 'qoder.exe' || name === 'qoder cn.exe') return 'qoder'
  if (name === 'zcode.exe') return 'zcode'
  return null
}

/** Candidate icon paths under each app/resource root, in priority order. */
export function guiIconCandidates(iconId: GuiIconId, roots: readonly string[]): string[] {
  const out: string[] = []
  for (const root of roots) {
    if (!root) continue
    out.push(join(root, 'final', `${iconId}.png`))
  }
  return [...new Set(out)]
}

/** Resolve the first existing bundled icon for one preset id. */
export function findGuiIcon(iconId: GuiIconId, roots: readonly string[]): string | undefined {
  return guiIconCandidates(iconId, roots).find((candidate) => existsSync(candidate))
}
