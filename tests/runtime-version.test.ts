import { describe, expect, it } from 'vitest'
import { dshSupportsNoOpen, normalizeRuntimeVersion, validateInstancePort } from '../src/shared/runtime-version'

describe('fixed runtime input', () => {
  it.each(['0.2.1-rc.2', '1.0.0', '0.1.0-alpha.1'])('accepts exact version %s', version => expect(normalizeRuntimeVersion(version)).toBe(version))
  it('normalizes an optional v prefix and leaves inheritance absent', () => {
    expect(normalizeRuntimeVersion(' v0.2.1-rc.2 ')).toBe('0.2.1-rc.2')
    expect(normalizeRuntimeVersion('')).toBeUndefined()
    expect(normalizeRuntimeVersion(undefined)).toBeUndefined()
  })
  it.each(['latest', '^0.2.1', '../escape', '0.2.1;echo secret', '0.2.1&whoami', '01.2.1', '0.2.1-01', '--help', 12])('rejects mutable or unsafe input %s', value => expect(() => normalizeRuntimeVersion(value)).toThrow())
})

describe('CLI compatibility', () => {
  it.each(['0.1.0-rc.7', '0.1.0', '0.1.1-rc.2', '0.2.0-alpha.1', '1.0.0'])('disables browser auto-open for supported %s', version => expect(dshSupportsNoOpen(version)).toBe(true))
  it.each(['0.1.0-rc.6', '0.0.9', '0.1.0-alpha.8', 'unknown'])('does not pass unsupported flags to %s', version => expect(dshSupportsNoOpen(version)).toBe(false))
})

describe('port input', () => {
  it.each([-1, 65536, 1.5, NaN, Infinity])('rejects invalid port %s', port => expect(() => validateInstancePort(port)).toThrow())
  it('allows auto allocation only for DSH', () => {
    expect(validateInstancePort(0)).toBe(0)
    expect(validateInstancePort(65535, true)).toBe(65535)
    expect(() => validateInstancePort(0, true)).toThrow()
  })
})
