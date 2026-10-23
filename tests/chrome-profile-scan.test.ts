import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromeUserDataRoot, scanChromeProfiles } from '../src/main/chrome-profile-scan'

describe('Chrome profile scan', () => {
  it('reads the Chrome Local State profile cache without touching browser data', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-chrome-profiles-'))
    try {
      mkdirSync(join(root, 'Default'))
      mkdirSync(join(root, 'Profile 2'))
      mkdirSync(join(root, 'Profile 10'))
      writeFileSync(join(root, 'Local State'), JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: '您的 Chrome' },
            'Profile 2': { name: '工作' },
            'Profile 10': { name: '测试' }
          }
        }
      }), 'utf8')

      const profiles = scanChromeProfiles(root)
      expect(profiles.map((profile) => profile.name)).toEqual(['Chrome/默认', 'Chrome/工作', 'Chrome/测试'])
      expect(profiles.every((profile) => profile.source === 'chrome')).toBe(true)
      expect(profiles.every((profile) => profile.partition.startsWith('persist:chrome-'))).toBe(true)
      expect(profiles[0].chromeProfileDir).toBe('Default')
      expect(scanChromeProfiles(root).map((profile) => profile.id)).toEqual(profiles.map((profile) => profile.id))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses the expected Chrome User Data root on Windows', () => {
    expect(chromeUserDataRoot({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32')).toBe(
      'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data'
    )
    expect(chromeUserDataRoot({ DSH_CHROME_USER_DATA: 'D:\\ChromeData' }, 'win32')).toBe('D:\\ChromeData')
  })
})