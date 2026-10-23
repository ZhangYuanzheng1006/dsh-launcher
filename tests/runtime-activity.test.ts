import { describe, expect, it } from 'vitest'
import { acquireRuntimeUse, acquireRuntimeWrite } from '../src/main/runtime-activity'

describe('runtime install/start leases', () => {
  it('prevents a global installer from entering during async startup/plugin work', () => {
    const done = acquireRuntimeUse('a')
    try { expect(() => acquireRuntimeWrite()).toThrow() } finally { done() }
    const finish = acquireRuntimeWrite()
    try { expect(() => acquireRuntimeUse('a')).toThrow(); expect(() => acquireRuntimeWrite('b')).toThrow() } finally { finish() }
  })
  it('isolates instance installs while preventing reads or a second installer of the same instance', () => {
    const finish = acquireRuntimeWrite('a')
    try {
      expect(() => acquireRuntimeUse('a')).toThrow()
      expect(() => acquireRuntimeWrite('a')).toThrow()
      const other = acquireRuntimeUse('b')
      other()
      const otherInstall = acquireRuntimeWrite('b')
      otherInstall()
    } finally { finish() }
  })
  it('counts concurrent users and makes release idempotent', () => {
    const one = acquireRuntimeUse('a')
    const two = acquireRuntimeUse('a')
    one(); one()
    try { expect(() => acquireRuntimeWrite('a')).toThrow() } finally { two() }
    const finish = acquireRuntimeWrite('a')
    finish(); finish()
  })
})
