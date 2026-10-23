import { describe, expect, it } from 'vitest'
import { fallbackColor, hostFaviconUrl, linkGlyphLetter, linkNameFromUrl, normalizeHttpUrl, parseFaviconHref } from '../src/shared/favicon'

describe('favicon URL handling', () => {
  it('normalizes user-entered HTTP URLs and rejects other schemes', () => {
    expect(normalizeHttpUrl('chat.deepseek.com')).toBe('https://chat.deepseek.com/')
    expect(normalizeHttpUrl('http://example.com/path')).toBe('http://example.com/path')
    expect(normalizeHttpUrl('file:///C:/secret.txt')).toBeNull()
    expect(normalizeHttpUrl('')).toBeNull()
  })

  it('builds the conventional host favicon URL', () => {
    expect(hostFaviconUrl('https://example.com/some/page?q=1')).toBe('https://example.com/favicon.ico')
    expect(hostFaviconUrl('not a url')).toBeNull()
  })

  it('parses relative and absolute icon links from HTML', () => {
    expect(parseFaviconHref('<link rel="icon" href="/assets/icon.png">', 'https://example.com/a')).toBe('https://example.com/assets/icon.png')
    expect(parseFaviconHref("<link rel='shortcut icon' href='https://cdn.example.com/i.ico?v=2'>", 'https://example.com')).toBe('https://cdn.example.com/i.ico?v=2')
    expect(parseFaviconHref('<meta name="x"><link rel="stylesheet" href="a.css">', 'https://example.com')).toBeNull()
  })

  it('produces a deterministic letter tile fallback', () => {
    expect(linkGlyphLetter('  deepseek')).toBe('D')
    expect(linkGlyphLetter('工作台')).toBe('工')
    expect(fallbackColor('example.com')).toBe(fallbackColor('example.com'))
    expect(fallbackColor('example.com')).toMatch(/^#[0-9A-F]{6}$/i)
  })

  it('uses the host as the default link name', () => {
    expect(linkNameFromUrl('https://www.example.com/path')).toBe('example.com')
  })
})