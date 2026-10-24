import { useEffect, useState, type JSX } from 'react'
import type { Group } from '../../../shared/types'
import { linkGlyphLetter } from '../../../shared/favicon'
import { chipLabel, chipWidth } from '../../../shared/chip'

function looksLikeImage(value: string): boolean {
  return /^(data:image\/|https?:|file:)/i.test(value) || /\.(png|jpe?g|gif|webp|svg|ico)(?:[?#].*)?$/i.test(value) || /[\\/]/.test(value)
}

/** Square color/letter tile with an optional image override. */
export function GlyphTile({
  icon,
  letter,
  color,
  size = 28,
  title,
  fontScale = 0.46,
  rounded = 8
}: {
  icon?: string
  letter: string
  color: string
  size?: number
  title?: string
  fontScale?: number
  rounded?: number
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [icon])
  const showImage = Boolean(icon && looksLikeImage(icon) && !failed)
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center justify-center overflow-hidden font-semibold select-none"
      style={{
        width: size,
        height: size,
        borderRadius: rounded,
        background: color,
        color: '#fff',
        fontSize: Math.max(10, Math.round(size * fontScale)),
        lineHeight: 1
      }}
    >
      {showImage ? (
        <img src={icon} alt="" className="h-full w-full object-contain" draggable={false} onError={() => setFailed(true)} />
      ) : icon && !looksLikeImage(icon) ? (
        <span>{Array.from(icon)[0]}</span>
      ) : (
        <span>{linkGlyphLetter(letter)}</span>
      )}
    </span>
  )
}

/** Top-bar group marker: solid, optionally width-adaptive by group name. */
export function GroupBadge({ group, active, size = 34, adaptive = false }: { group: Group; active: boolean; size?: number; adaptive?: boolean }): JSX.Element {
  const name = group.name || group.char || '组'
  const label = adaptive ? chipLabel(name) : (Array.from(group.char || name)[0] ?? '组')
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center font-semibold transition-transform"
      style={{
        width: adaptive ? chipWidth(Array.from(name).length, size) : size,
        height: size,
        padding: adaptive ? '0 7px' : 0,
        boxSizing: 'border-box',
        borderRadius: 9,
        background: group.color,
        color: '#fff',
        border: `1px solid color-mix(in srgb, ${group.color} 72%, #000)`,
        fontSize: Math.round(size * (adaptive ? 0.38 : 0.40)),
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        boxShadow: active ? `0 0 0 2px var(--panel), 0 0 0 4px ${group.color}80` : 'none',
        transform: active ? 'translateY(-1px)' : undefined
      }}
      title={group.name}
    >
      {label}
    </span>
  )
}