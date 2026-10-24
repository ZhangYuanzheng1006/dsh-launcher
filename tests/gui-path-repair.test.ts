import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  inferGuiPresetId,
  isGuiExecutableAvailable,
  latestWindowsAppsExecutable,
  resolveGuiExecutable
} from '../src/main/gui-path-repair'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gui-path-repair-'))
  tempDirs.push(dir)
  return dir
}

describe('GUI executable repair', () => {
  it('accepts existing files and protected WindowsApps executables without a stat', () => {
    const root = tempDir()
    const exe = join(root, 'present.exe')
    writeFileSync(exe, 'MZ')
    expect(isGuiExecutableAvailable(exe)).toBe(true)
    expect(isGuiExecutableAvailable(join(root, 'missing.exe'))).toBe(false)
    expect(isGuiExecutableAvailable('C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1013.4894.0_x64__test\\app\\ChatGPT.exe')).toBe(true)
    expect(isGuiExecutableAvailable('C:/Program Files/WindowsApps/Claude_2.42304.0.0_x64__test/app/Claude.exe')).toBe(true)
    expect(isGuiExecutableAvailable('')).toBe(false)
  })

  it('infers the preset from explicit metadata or executable basename', () => {
    expect(inferGuiPresetId({ exe: 'C:\\A\\ChatGPT.exe' })).toBe('codex')
    expect(inferGuiPresetId({ exe: 'C:\\A\\Claude.exe' })).toBe('claude')
    expect(inferGuiPresetId({ exe: 'C:\\A\\chrome.exe' })).toBe('chrome')
    expect(inferGuiPresetId({ exe: 'C:\\A\\Typora.exe' })).toBe('typora')
    expect(inferGuiPresetId({ exe: 'C:\\A\\Code.exe' })).toBe('vscode')
    expect(inferGuiPresetId({ exe: 'C:\\A\\zotero.exe' })).toBe('zotero')
    expect(inferGuiPresetId({ exe: 'C:\\A\\Qoder CN.exe' })).toBe('qoder')
    expect(inferGuiPresetId({ exe: 'C:\\A\\ZCode.exe' })).toBe('zcode')
    expect(inferGuiPresetId({ exe: 'C:\\A\\unknown.exe', guiPresetId: 'codex' })).toBe('codex')
    expect(inferGuiPresetId({ exe: 'C:\\A\\unknown.exe' })).toBeNull()
  })

  it('picks the newest versioned WindowsApps package directory by numeric version order', () => {
    const root = tempDir()
    const apps = join(root, 'WindowsApps')
    for (const version of ['26.9.0.0', '26.10.0.0', '26.2.0.0']) {
      const dir = join(apps, `OpenAI.Codex_${version}_x64__test`, 'app')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'ChatGPT.exe'), 'MZ')
    }
    expect(latestWindowsAppsExecutable(root, 'codex')).toContain('26.10.0.0')
  })

  it('picks the VS Code AppX package executable from the WindowsApps store layout', () => {
    const root = tempDir()
    const apps = join(root, 'WindowsApps')
    const exe = join(apps, 'Microsoft.VisualStudioCode_1.0.141.0_neutral__test', 'Code.exe')
    mkdirSync(join(apps, 'Microsoft.VisualStudioCode_1.0.141.0_neutral__test'), { recursive: true })
    writeFileSync(exe, 'MZ')
    expect(latestWindowsAppsExecutable(root, 'vscode')).toBe(exe)
  })

  it('re-discovers a missing executable and returns the discovered path', async () => {
    const root = tempDir()
    const exe = join(root, 'new', 'ChatGPT.exe')
    mkdirSync(join(root, 'new'), { recursive: true })
    writeFileSync(exe, 'MZ')
    const result = await resolveGuiExecutable(
      { exe: join(root, 'old-version', 'ChatGPT.exe') },
      async () => ({
        presets: [{ id: 'codex', name: 'Codex', exe, args: [], windowPolicy: 'codex-multi' }],
        timings: {},
        timedOut: false
      })
    )
    expect(result.newExe).toBe(exe)
    expect(result.presetId).toBe('codex')
    expect(result.source).toBe('discovery')
  })
})
