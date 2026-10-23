/** Pure URL/favicon helpers shared by the main-process probe and the renderer. */

/** Normalize a user-entered HTTP(S) URL, adding https:// when the scheme is omitted. */
export function normalizeHttpUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!url.hostname) return null
    return url.toString()
  } catch {
    return null
  }
}

/** The conventional favicon location required by the acceptance criteria. */
export function hostFaviconUrl(input: string): string | null {
  const normalized = normalizeHttpUrl(input)
  if (!normalized) return null
  const url = new URL(normalized)
  return `${url.origin}/favicon.ico`
}

function decodeAttribute(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .trim()
}

/** Extract the best `<link rel="icon">` URL from an HTML document. */
export function parseFaviconHref(html: string, documentUrl: string): string | null {
  const base = normalizeHttpUrl(documentUrl)
  if (!base) return null
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? []
  let fallback: string | null = null
  for (const tag of linkTags) {
    const attrs = new Map<string, string>()
    for (const match of tag.matchAll(/([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs.set(match[1].toLowerCase(), decodeAttribute(match[2] ?? match[3] ?? match[4] ?? ''))
    }
    const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/)
    if (!rel.includes('icon') && !rel.includes('shortcut')) continue
    const href = attrs.get('href') ?? ''
    if (!href || href.startsWith('data:')) continue
    try {
      const resolved = new URL(href, base)
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
      if (rel.includes('icon')) return resolved.toString()
      fallback ??= resolved.toString()
    } catch {
      // A malformed href is skipped; another icon link may still be usable.
    }
  }
  return fallback
}

/** First visible character used by the fallback color tile. */
export function linkGlyphLetter(name: string): string {
  const char = Array.from(name.trim())[0] ?? '?'
  return /^[a-z]$/i.test(char) ? char.toUpperCase() : char
}

const FALLBACK_COLORS = ['#4F7DFF', '#16A34A', '#D97706', '#DC4C64', '#7C3AED', '#0891B2', '#DB2777', '#65A30D']

/** Stable color for a link/instance fallback tile. */
export function fallbackColor(seed: string): string {
  let hash = 0
  for (const char of seed) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length]
}

/** Short display name from a URL host (used by Enter-to-create links). */
export function linkNameFromUrl(input: string): string {
  const normalized = normalizeHttpUrl(input)
  if (!normalized) return 'New link'
  const host = new URL(normalized).hostname.replace(/^www\./i, '')
  return host || normalized
}