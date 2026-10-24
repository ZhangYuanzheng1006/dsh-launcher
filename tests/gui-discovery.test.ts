import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  antigravityCandidates,
  chromeCandidates,
  claudeExecutableFromInstallLocation,
  codexCandidates,
  codexExecutableFromInstallLocation,
  executableFromShortcutArgs,
  isStubExecutable,
  shortcutSearchDirs,
  typoraCandidates,
  vscodeCandidates,
  vscodeExecutableFromInstallLocation,
  wechatCandidates,
  zoteroCandidates,
  qoderCandidates,
  zcodeCandidates,
  GUI_DISCOVERY_TIMEOUT_MS,
  type GuiShortcut
} from '../src/main/gui-discovery'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('GUI app discovery helpers', () => {
  it('keeps the total discovery budget at three seconds', () => {
    expect(GUI_DISCOVERY_TIMEOUT_MS).toBe(3000)
  })

  it('checks the per-user Antigravity install before the machine-wide install', () => {
    expect(antigravityCandidates({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ProgramFiles: 'C:\\Program Files' })).toEqual([
      'C:\\Users\\me\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe',
      'C:\\Users\\me\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe',
      'C:\\Program Files\\Antigravity\\Antigravity.exe'
    ])
  })

  it('checks common LocalAppData locations for an unpackaged Codex desktop build', () => {
    const candidates = codexCandidates({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })
    expect(candidates).toContain('C:\\Users\\me\\AppData\\Local\\Programs\\Codex\\Codex.exe')
    expect(candidates).toContain('C:\\Users\\me\\AppData\\Local\\Programs\\ChatGPT\\ChatGPT.exe')
  })

  it('maps the versioned Codex AppX directory to its actual window process', () => {
    expect(
      codexExecutableFromInstallLocation('C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1007.9446.0_x64__2p2nqsd0c76g0')
    ).toBe('C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1007.9446.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe')
  })
})


describe('new GUI app discovery candidates', () => {
  it('checks per-user and machine-wide Chrome installs', () => {
    expect(chromeCandidates({
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)'
    })).toEqual([
      'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ])
  })

  it('checks both classic WeChat and 4.x Weixin layouts', () => {
    const candidates = wechatCandidates({
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)'
    })
    expect(candidates).toContain('C:\\Program Files\\Tencent\\Weixin\\Weixin.exe')
    expect(candidates).toContain('C:\\Program Files\\Tencent\\WeChat\\WeChat.exe')
    expect(candidates).toContain('C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe')
  })

  it('searches both desktop and Start Menu shortcut roots', () => {
    expect(shortcutSearchDirs({
      USERPROFILE: 'C:\\Users\\me',
      PUBLIC: 'C:\\Users\\Public',
      APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
      ProgramData: 'C:\\ProgramData'
    })).toEqual([
      'C:\\Users\\me\\Desktop',
      'C:\\Users\\Public\\Desktop',
      'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs',
      'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs'
    ])
  })

  it('maps the Claude AppX install to its full-trust executable', () => {
    expect(claudeExecutableFromInstallLocation('C:\\Program Files\\WindowsApps\\Claude_2.0.0.0_x64__abc'))
      .toBe('C:\\Program Files\\WindowsApps\\Claude_2.0.0.0_x64__abc\\app\\Claude.exe')
  })

  it('checks Typora per-user and machine-wide layouts', () => {
    const candidates = typoraCandidates({
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)'
    })
    expect(candidates).toContain('C:\\Users\\me\\AppData\\Local\\Programs\\Typora\\Typora.exe')
    expect(candidates).toContain('C:\\Program Files\\Typora\\Typora.exe')
    expect(candidates).toContain('C:\\Program Files (x86)\\Typora\\Typora.exe')
  })

  it('checks Visual Studio Code per-user and machine-wide layouts', () => {
    const candidates = vscodeCandidates({
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)'
    })
    expect(candidates).toContain('C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe')
    expect(candidates).toContain('C:\\Program Files\\Microsoft VS Code\\Code.exe')
    expect(candidates).toContain('C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe')
  })

  it('checks Zotero, Qoder and ZCode install roots', () => {
    const env = {
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)'
    }
    expect(zoteroCandidates(env)).toContain('C:\\Program Files\\Zotero\\zotero.exe')
    expect(qoderCandidates(env)).toContain('C:\\Users\\me\\AppData\\Local\\Programs\\Qoder CN\\Qoder CN.exe')
    expect(zcodeCandidates(env)).toContain('C:\\Program Files\\ZCode\\ZCode.exe')
  })

  it('maps the VS Code AppX install to its full-trust executable', () => {
    expect(vscodeExecutableFromInstallLocation('C:\\Program Files\\WindowsApps\\Microsoft.VisualStudioCode_1.0.0.0_neutral__abc'))
      .toBe('C:\\Program Files\\WindowsApps\\Microsoft.VisualStudioCode_1.0.0.0_neutral__abc\\Code.exe')
  })
})

describe('shortcut stub resolution', () => {
  it('treats zero-byte AppExecutionAlias files as stubs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gui-discovery-'))
    tempDirs.push(dir)
    const alias = join(dir, 'claude-desktop.exe')
    const real = join(dir, 'Claude.exe')
    writeFileSync(alias, '')
    writeFileSync(real, 'MZ')
    expect(isStubExecutable(alias)).toBe(true)
    expect(isStubExecutable(real)).toBe(false)
  })

  it('performs second-level resolution from Squirrel-style shortcut arguments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gui-discovery-'))
    tempDirs.push(dir)
    const exe = join(dir, 'Claude.exe')
    writeFileSync(exe, 'MZ')
    const shortcut: GuiShortcut = {
      path: join(dir, 'Claude.lnk'),
      targetPath: join(dir, 'Update.exe'),
      arguments: '--processStart "Claude.exe"',
      workingDirectory: dir
    }
    expect(executableFromShortcutArgs(shortcut)).toBe(exe)
  })
})
