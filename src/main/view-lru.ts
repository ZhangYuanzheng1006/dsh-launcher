/** A view key and the monotonic sequence number of its most recent activation. */
export interface ViewLruEntry {
  key: string
  lastUsed: number
}

/** Maximum number of inactive views kept alive in the shared WebContentsView pool. */
export const MAX_HIDDEN_VIEWS = 6

/**
 * Choose inactive views to destroy when the pool exceeds its keep-alive cap.
 * The active view is never a candidate, even when its sequence number is oldest.
 *
 * @param entries - Every live view and its last-activation sequence number.
 * @param activeKey - Currently visible view key, or null when no view is visible.
 * @param maxHidden - Maximum number of inactive views to retain.
 * @returns Oldest inactive keys that exceed the cap, in eviction order.
 */
export function selectLruEvictions(
  entries: readonly ViewLruEntry[],
  activeKey: string | null,
  maxHidden: number = MAX_HIDDEN_VIEWS
): string[] {
  const hidden = entries.filter(entry => entry.key !== activeKey)
  const excess = hidden.length - Math.max(0, maxHidden)
  if (excess <= 0) return []
  return hidden
    .slice()
    .sort((a, b) => a.lastUsed - b.lastUsed || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, excess)
    .map(entry => entry.key)
}
