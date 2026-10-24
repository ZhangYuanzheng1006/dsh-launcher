import { describe, expect, it } from 'vitest'
import { MAX_HIDDEN_VIEWS, selectLruEvictions, type ViewLruEntry } from '../src/main/view-lru'

function entry(key: string, lastUsed: number): ViewLruEntry {
  return { key, lastUsed }
}

describe('selectLruEvictions', () => {
  it('keeps at most six inactive views', () => {
    expect(MAX_HIDDEN_VIEWS).toBe(6)
  })

  it('keeps exactly six inactive views by default', () => {
    const entries = [
      entry('active', 0),
      ...Array.from({ length: MAX_HIDDEN_VIEWS }, (_, i) => entry(`hidden-${i}`, i + 1))
    ]
    expect(selectLruEvictions(entries, 'active')).toEqual([])
  })

  it('evicts the oldest inactive views beyond the cap', () => {
    const entries = [
      entry('active', 0),
      entry('oldest', 1),
      entry('second', 2),
      entry('third', 3),
      entry('fourth', 4),
      entry('fifth', 5),
      entry('sixth', 6),
      entry('seventh', 7),
      entry('newest', 8)
    ]

    expect(selectLruEvictions(entries, 'active')).toEqual(['oldest', 'second'])
  })

  it('never evicts the active view even when it is the oldest', () => {
    const entries = [
      entry('active', 0),
      ...Array.from({ length: 7 }, (_, i) => entry(`hidden-${i}`, i + 1))
    ]

    expect(selectLruEvictions(entries, 'active')).toEqual(['hidden-0'])
  })

  it('enforces the cap across all hidden views when nothing is active', () => {
    const entries = Array.from({ length: 9 }, (_, i) => entry(`hidden-${i}`, i))

    expect(selectLruEvictions(entries, null)).toEqual(['hidden-0', 'hidden-1', 'hidden-2'])
  })

  it('breaks ties deterministically by key', () => {
    const entries = [
      entry('b', 1),
      entry('a', 1),
      ...Array.from({ length: 6 }, (_, i) => entry(`newer-${i}`, i + 2))
    ]

    expect(selectLruEvictions(entries, null)).toEqual(['a', 'b'])
  })
})
