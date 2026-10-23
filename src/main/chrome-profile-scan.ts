import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Profile } from '../shared/types'

const COLORS = ['#4285F4', '#7C3AED', '#0891B2', '#16A34A', '#D97706', '#DC4C64', '#DB2777', '#64748B']

interface LocalStateProfile {
  name?: string
  gaia_name?: string
  user_name?: string
}

interface LocalState {
  profile?: {
    info_cache?: Record<string, LocalStateProfile>
  }
}

export function chromeUserDataRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (env.DSH_CHROME_USER_DATA?.trim()) return env.DSH_CHROME_USER_DATA.trim()
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA) return undefined
    return join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data')
  }
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
  return join(homedir(), '.config', 'google-chrome')
}

function stableId(root: string, directory: string): string {
  const hash = createHash('sha1').update(`${root}|${directory}`).digest('hex').slice(0, 16)
  return `chrome-${hash}`
}

function profileDirectories(root: string, infoCache: Record<string, LocalStateProfile>): string[] {
  const fromCache = Object.keys(infoCache)
  if (fromCache.length > 0) return fromCache.filter((directory) => existsSync(join(root, directory)))
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function displayName(directory: string, profile: LocalStateProfile | undefined): string {
  if (directory === 'Default') return '默认'
  return (profile?.name ?? profile?.gaia_name ?? profile?.user_name ?? directory).trim() || directory
}

/**
 * Read the Chrome profile list from `User Data/Local State`.
 * This is read-only: no cookie database, local storage or Chrome files are modified.
 */
export function scanChromeProfiles(root = chromeUserDataRoot()): Profile[] {
  if (!root || !existsSync(root)) return []
  let state: LocalState = {}
  try {
    state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8')) as LocalState
  } catch {
    state = {}
  }
  const infoCache = state.profile?.info_cache ?? {}
  return profileDirectories(root, infoCache)
    .sort((left, right) => {
      if (left === 'Default') return -1
      if (right === 'Default') return 1
      return left.localeCompare(right, undefined, { numeric: true })
    })
    .map((directory, index) => {
      const name = displayName(directory, infoCache[directory])
      const id = stableId(root, directory)
      return {
        id,
        name: `Chrome/${name}`,
        color: COLORS[index % COLORS.length],
        letter: Array.from(name)[0]?.toUpperCase() ?? 'C',
        partition: `persist:${id}`,
        source: 'chrome',
        archived: false,
        chromeProfileDir: directory
      } satisfies Profile
    })
}