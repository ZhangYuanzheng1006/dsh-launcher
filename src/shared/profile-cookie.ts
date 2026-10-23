/** Minimal cookie fields shared by Electron's Cookie and CookiesSetDetails APIs. */
export interface ProfileCookieSnapshot {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  session?: boolean
  hostOnly?: boolean
  expirationDate?: number
  sameSite?: string
}

export interface ProfileCookieSetDetails {
  url: string
  name: string
  value: string
  path?: string
  secure: boolean
  httpOnly: boolean
  domain?: string
  expirationDate?: number
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

/** URL used by Electron's cookies.set; covers both host-only and domain cookies. */
export function cookieUrl(cookie: Pick<ProfileCookieSnapshot, 'domain' | 'path' | 'secure'>): string | null {
  const host = (cookie.domain ?? '').replace(/^\./, '').trim()
  if (!host) return null
  const path = cookie.path?.startsWith('/') ? cookie.path : '/'
  return `${cookie.secure ? 'https' : 'http'}://${host}${path}`
}

/** Stable identity within a cookie partition (domain+path+name). */
export function cookieKey(cookie: Pick<ProfileCookieSnapshot, 'domain' | 'path' | 'name'>): string {
  return [(cookie.domain ?? '').toLowerCase().replace(/^\./, ''), cookie.path || '/', cookie.name].join('\0')
}

function sameSite(value: string | undefined): ProfileCookieSetDetails['sameSite'] {
  return value === 'no_restriction' || value === 'lax' || value === 'strict' || value === 'unspecified' ? value : undefined
}

/** Convert a source cookie to the details accepted by session.cookies.set. */
export function toCookieSetDetails(cookie: ProfileCookieSnapshot): ProfileCookieSetDetails | null {
  const url = cookieUrl(cookie)
  if (!url || !cookie.name) return null
  return {
    url,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path?.startsWith('/') ? cookie.path : '/',
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    // hostOnly cookies must omit domain so Chromium keeps them host-scoped.
    ...(cookie.hostOnly === true ? {} : { domain: cookie.domain }),
    ...(cookie.session === true || typeof cookie.expirationDate !== 'number' ? {} : { expirationDate: cookie.expirationDate }),
    ...(sameSite(cookie.sameSite) ? { sameSite: sameSite(cookie.sameSite) } : {})
  }
}