// Pure geometry for matching a native window's client rectangle to the
// launcher content box. Win32 frame metrics are supplied by gui-win32.

/** Screen-space rectangle in physical pixels. */
export interface GuiPixelRect {
  x: number
  y: number
  width: number
  height: number
}

/** Non-client pixels surrounding a window's client rectangle. */
export interface GuiClientInsets {
  left: number
  top: number
  right: number
  bottom: number
}

/** Clamp and round measured non-client insets. */
export function normalizeGuiClientInsets(insets: GuiClientInsets): GuiClientInsets {
  return {
    left: Math.max(0, Math.round(insets.left)),
    top: Math.max(0, Math.round(insets.top)),
    right: Math.max(0, Math.round(insets.right)),
    bottom: Math.max(0, Math.round(insets.bottom))
  }
}

/** Expand a desired client rectangle into the outer window rectangle. */
export function outerRectForClient(rect: GuiPixelRect, insets: GuiClientInsets): GuiPixelRect {
  const frame = normalizeGuiClientInsets(insets)
  return {
    x: Math.round(rect.x - frame.left),
    y: Math.round(rect.y - frame.top),
    width: Math.max(1, Math.round(rect.width) + frame.left + frame.right),
    height: Math.max(1, Math.round(rect.height) + frame.top + frame.bottom)
  }
}

/** Rectangle of the client area in window-relative coordinates. */
export function clientRegionRect(
  insets: GuiClientInsets,
  clientWidth: number,
  clientHeight: number
): GuiPixelRect {
  const frame = normalizeGuiClientInsets(insets)
  return {
    x: frame.left,
    y: frame.top,
    width: Math.max(0, Math.round(clientWidth)),
    height: Math.max(0, Math.round(clientHeight))
  }
}

/** Compare two pixel rectangles with a tolerance for DWM rounding. */
export function sameGuiPixelRect(a: GuiPixelRect, b: GuiPixelRect, tolerance = 1): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  )
}