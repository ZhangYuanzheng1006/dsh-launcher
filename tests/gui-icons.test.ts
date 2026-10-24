import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GUI_ICON_IDS, findGuiIcon, guiIconCandidates, guiIconIdForExecutable } from '../src/main/gui-icons'

function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

describe('bundled GUI app icons', () => {
  it('ships an icon for every preset', () => {
    for (const id of GUI_ICON_IDS) {
      const file = join(process.cwd(), 'final', `${id}.png`)
      expect(existsSync(file), file).toBe(true)
      const { width, height } = pngSize(file)
      expect(width).toBeGreaterThanOrEqual(128)
      expect(height).toBe(width)
    }
  })

  it('uses 256px icons for Claude, WeChat and Chrome', () => {
    for (const id of ['claude', 'wechat', 'chrome'] as const) {
      expect(pngSize(join(process.cwd(), 'final', `${id}.png`))).toEqual({ width: 256, height: 256 })
    }
  })

  it('maps preset executables to their icons and resolves the bundled file', () => {
    expect(guiIconIdForExecutable('C:\\Apps\\Antigravity.exe')).toBe('antigravity')
    expect(guiIconIdForExecutable('C:\\Apps\\ChatGPT.exe')).toBe('codex')
    expect(guiIconIdForExecutable('C:\\Apps\\Claude.exe')).toBe('claude')
    expect(guiIconIdForExecutable('C:\\Tencent\\Weixin\\Weixin.exe')).toBe('wechat')
    expect(guiIconIdForExecutable('C:\\Chrome\\chrome.exe')).toBe('chrome')
    expect(guiIconIdForExecutable('C:\\Apps\\Typora.exe')).toBe('typora')
    expect(guiIconIdForExecutable('C:\\Apps\\Microsoft VS Code\\Code.exe')).toBe('vscode')
    expect(guiIconIdForExecutable('C:\\Apps\\zotero.exe')).toBe('zotero')
    expect(guiIconIdForExecutable('C:\\Apps\\Qoder CN.exe')).toBe('qoder')
    expect(guiIconIdForExecutable('C:\\Apps\\ZCode.exe')).toBe('zcode')
    expect(guiIconIdForExecutable('C:\\Apps\\Notepad.exe')).toBeNull()
    expect(findGuiIcon('wechat', [process.cwd()])).toBe(join(process.cwd(), 'final', 'wechat.png'))
    expect(guiIconCandidates('chrome', [process.cwd()])).toEqual([join(process.cwd(), 'final', 'chrome.png')])
  })
})
