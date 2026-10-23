import { describe, expect, it } from 'vitest'
import { parsePowerShellCommand, splitWindowsCommandLine } from '../src/shared/ps-command'

describe('PowerShell command parsing', () => {
  it('accepts a bare script and preserves line breaks', () => {
    const result = parsePowerShellCommand('Write-Host "hello"\nGet-Date')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.command.executable).toBe('powershell.exe')
      expect(result.command.script).toContain('Get-Date')
    }
  })

  it('unwraps a powershell -Command wrapper', () => {
    const result = parsePowerShellCommand('powershell -NoProfile -Command "Write-Host hello"')
    expect(result).toEqual({ ok: true, command: { executable: 'powershell.exe', script: 'Write-Host hello' } })
  })

  it('selects pwsh when the wrapper uses pwsh', () => {
    const result = parsePowerShellCommand("pwsh -Command 'Get-Process | Select-Object -First 3'")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.command.executable).toBe('pwsh.exe')
  })

  it('rejects empty and incomplete wrappers', () => {
    expect(parsePowerShellCommand('   ').ok).toBe(false)
    expect(parsePowerShellCommand('powershell -NoProfile').ok).toBe(false)
    expect(parsePowerShellCommand('powershell -Command').ok).toBe(false)
  })

  it('splits quoted Windows arguments', () => {
    expect(splitWindowsCommandLine('pwsh -Command "Get-Date"')).toEqual(['pwsh', '-Command', 'Get-Date'])
  })
})