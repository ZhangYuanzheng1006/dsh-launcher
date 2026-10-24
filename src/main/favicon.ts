import { net } from 'electron'
import { hostFaviconUrl, normalizeHttpUrl, parseFaviconHref } from '../shared/favicon'

const PROBE_TIMEOUT_MS = 5_000
const MAX_HTML_BYTES = 1024 * 1024

async function imageResponds(url: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await net.fetch(url, { method: 'GET', signal: controller.signal })
    if (!response.ok) return false
    const type = (response.headers.get('content-type') ?? '').toLowerCase()
    return type.startsWith('image/') || type === 'application/octet-stream' || type === ''
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve a link icon in the required order: conventional /favicon.ico first,
 * then the document's `<link rel="icon">`. Any network or format failure returns
 * null so the renderer can use its deterministic letter tile.
 */
export async function resolveLinkFavicon(input: string): Promise<string | null> {
  const conventional = hostFaviconUrl(input)
  if (conventional && await imageResponds(conventional)) return conventional

  const pageUrl = normalizeHttpUrl(input)
  if (!pageUrl) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await net.fetch(pageUrl, { signal: controller.signal })
    if (!response.ok) return null
    const type = (response.headers.get('content-type') ?? '').toLowerCase()
    if (type && !type.includes('html')) return null
    const html = (await response.text()).slice(0, MAX_HTML_BYTES)
    const href = parseFaviconHref(html, response.url || pageUrl)
    return href && await imageResponds(href) ? href : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}