/** Adaptive width for a top-bar group chip. Height stays constant. */
export const CHIP_BASE_SIZE = 34
export const CHIP_CHAR_STEP = 12
export const CHIP_MAX_CHARS = 4

export function chipWidth(chars: number, base = CHIP_BASE_SIZE, step = CHIP_CHAR_STEP): number {
  const count = Math.max(1, Math.floor(Number.isFinite(chars) ? chars : 1))
  if (count <= 1) return base
  if (count <= CHIP_MAX_CHARS) return base + (count - 1) * step
  return base + CHIP_MAX_CHARS * step
}

export function chipLabel(name: string, maxChars = CHIP_MAX_CHARS): string {
  const chars = Array.from((name ?? '').trim() || '组')
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : chars.join('')
}