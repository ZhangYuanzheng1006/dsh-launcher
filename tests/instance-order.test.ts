import { describe, expect, it } from 'vitest'
import { reorderInstanceItems } from '../src/renderer/src/lib/instance-order'

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]

describe('reorderInstanceItems', () => {
  it('moves a card down to the target slot', () => {
    expect(reorderInstanceItems(items, 'a', 'c').map((x) => x.id)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves a card up to the target slot', () => {
    expect(reorderInstanceItems(items, 'd', 'b').map((x) => x.id)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('ignores no-op or unknown ids and never mutates the input', () => {
    expect(reorderInstanceItems(items, 'b', 'b')).toEqual(items)
    expect(reorderInstanceItems(items, 'missing', 'b')).toEqual(items)
    expect(items.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})
