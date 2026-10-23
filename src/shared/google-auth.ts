/** Google login pages are known to reject embedded browsers; expose a visible fallback hint. */
export function isGoogleAccountUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '')
    return host === 'google.com' ||
      host === 'google.com.cn' ||
      host.endsWith('.google.com') ||
      host.endsWith('.google.com.cn')
  } catch {
    return false
  }
}