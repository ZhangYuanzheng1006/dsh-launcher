import { describe, expect, it } from 'vitest'
import {
  clientRegionRect,
  normalizeGuiClientInsets,
  outerRectForClient,
  sameGuiPixelRect
} from '../src/main/gui-content-box'

describe('GUI content box geometry', () => {
  it('expands a client box by the measured non-client frame', () => {
    expect(
      outerRectForClient(
        { x: 100, y: 50, width: 800, height: 600 },
        { left: 13, top: 0, right: 13, bottom: 13 }
      )
    ).toEqual({ x: 87, y: 50, width: 826, height: 613 })
  })

  it('places the client region inside the outer window', () => {
    expect(clientRegionRect({ left: 13, top: 0, right: 13, bottom: 13 }, 800, 600)).toEqual({
      x: 13,
      y: 0,
      width: 800,
      height: 600
    })
  })

  it('clamps negative frame measurements and keeps a positive outer size', () => {
    expect(normalizeGuiClientInsets({ left: -2, top: 1.4, right: 2.6, bottom: -9 })).toEqual({
      left: 0,
      top: 1,
      right: 3,
      bottom: 0
    })
    expect(outerRectForClient({ x: 0, y: 0, width: 0, height: 0 }, { left: 0, top: 0, right: 0, bottom: 0 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1
    })
  })

  it('compares region rectangles with a one-pixel DWM tolerance', () => {
    expect(sameGuiPixelRect({ x: 13, y: 0, width: 800, height: 600 }, { x: 13, y: 1, width: 801, height: 600 })).toBe(true)
    expect(sameGuiPixelRect({ x: 13, y: 0, width: 800, height: 600 }, { x: 15, y: 0, width: 800, height: 600 })).toBe(false)
  })
})