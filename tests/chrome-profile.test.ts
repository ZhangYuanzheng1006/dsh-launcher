import { describe, expect, it } from 'vitest'
import {
  chromeLaunchArgs,
  chromeProfileDir,
  isChromeExecutable,
  resolveChromeProfileMode
} from '../src/main/chrome-profile'

describe('isolated Chrome profile', () => {
  it('keeps each instance profile under the launcher app-data directory', () => {
    expect(chromeProfileDir('C:\\Users\\me\\AppData\\Roaming', 'a/b:c')).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\dsh-launcher\\chrome-profiles\\a_b_c'
    )
  })

  it('removes old user-data-dir args and guarantees a new window', () => {
    const args = chromeLaunchArgs(['--user-data-dir=C:\\old', '--new-window', 'about:blank'], 'C:\\profiles\\x')
    expect(args.filter((arg) => arg.startsWith('--user-data-dir='))).toEqual(['--user-data-dir=C:\\profiles\\x'])
    expect(args.filter((arg) => arg === '--new-window')).toHaveLength(1)
    expect(args).toContain('about:blank')
  })

  it('adds --new-window when the configured args omitted it', () => {
    expect(chromeLaunchArgs(['about:blank'], 'C:\\p')).toEqual(['--user-data-dir=C:\\p', '--no-first-run', '--no-default-browser-check', 'about:blank', '--new-window'])
  })

  it('recognizes Chrome executables and defaults legacy configs to isolated', () => {
    expect(isChromeExecutable('C:\\Chrome\\chrome.exe')).toBe(true)
    expect(isChromeExecutable('C:\\Chrome\\notchrome.exe')).toBe(false)
    expect(resolveChromeProfileMode(undefined)).toBe('isolated')
    expect(resolveChromeProfileMode('isolated')).toBe('isolated')
    expect(resolveChromeProfileMode('shared')).toBe('shared')
  })
})
