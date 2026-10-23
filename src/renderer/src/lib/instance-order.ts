/** Move one instance card to the target card's slot, preserving all others. */
export function reorderInstanceItems<T extends { id: string }>(
  items: readonly T[],
  sourceId: string,
  targetId: string
): T[] {
  if (sourceId === targetId) return [...items]
  const from = items.findIndex((item) => item.id === sourceId)
  const to = items.findIndex((item) => item.id === targetId)
  if (from < 0 || to < 0) return [...items]
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
