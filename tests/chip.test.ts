import { describe, expect, it } from 'vitest'
import { chipLabel, chipWidth } from '../src/shared/chip'

describe('top-bar group chip geometry', () => {
  it('keeps one character square and grows for 2-4 characters', () => {
    expect(chipWidth(1)).toBe(34)
    expect(chipWidth(2)).toBe(46)
    expect(chipWidth(3)).toBe(58)
    expect(chipWidth(4)).toBe(70)
  })

  it('uses a fixed maximum width and ellipsis beyond four characters', () => {
    expect(chipWidth(5)).toBe(chipWidth(8))
    expect(chipWidth(5)).toBe(82)
    expect(chipLabel('临时验收二')).toBe('临时验收…')
    expect(chipLabel('工作')).toBe('工作')
  })

  it('falls back to one chip slot for invalid counts', () => {
    expect(chipWidth(0)).toBe(34)
    expect(chipWidth(Number.NaN)).toBe(34)
    expect(chipLabel('')).toBe('组')
  })
})