import { describe, expect, it } from 'vitest'
import { isGoogleAccountUrl } from '../src/shared/google-auth'

describe('Google login URL detection', () => {
  it('detects Google account and Gemini hosts', () => {
    expect(isGoogleAccountUrl('https://accounts.google.com/')).toBe(true)
    expect(isGoogleAccountUrl('https://gemini.google.com/app')).toBe(true)
    expect(isGoogleAccountUrl('https://www.google.com/')).toBe(true)
  })
  it('does not flag unrelated hosts', () => {
    expect(isGoogleAccountUrl('https://example.com/?next=google.com')).toBe(false)
    expect(isGoogleAccountUrl('https://google.example.com/')).toBe(false)
    expect(isGoogleAccountUrl('not a url')).toBe(false)
  })
})