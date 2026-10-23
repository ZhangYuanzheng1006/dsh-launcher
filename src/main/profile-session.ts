import type { Profile } from '../shared/types'
import { DEFAULT_PROFILE_ID } from '../shared/profiles'

// If the one-time default-session cookie copy fails, the default profile must
// keep using Electron's legacy default session for this run. The next launch
// retries the copy; config remains on the stable persist partition.
let defaultSessionFallback = false

export function setDefaultSessionFallback(enabled: boolean): void {
  defaultSessionFallback = enabled
}

export function profilePartition(profile: Profile | undefined): string | undefined {
  // The fixed default profile is the legacy Electron defaultSession. It holds
  // the user's pre-S4 cookies, localStorage and IndexedDB, so isolated views must
  // never be created for it. Only an explicitly selected non-default profile
  // gets a persistent partition.
  if (!profile || profile.id === DEFAULT_PROFILE_ID) return undefined
  return profile.partition || undefined
}