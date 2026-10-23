import { describe, expect, it } from 'vitest'
import { beginProfileBoot, withProfileOperation } from '../src/main/profile-activity'

describe('profile startup/plugin transaction exclusion', () => {
  it('holds the complete mutation through post-command work and allows nested operations by its owner', async () => {
    let finish!: () => void
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const changing = withProfileOperation('C:/test/profile-home', 'web', async () => {
      await withProfileOperation('C:/test/profile-home', 'web', async () => 'nested command')
      entered()
      await new Promise<void>(resolve => { finish = resolve })
      return 'manifest enabled'
    })
    await ready
    await expect(withProfileOperation('C:/test/profile-home', 'web', async () => 'startup')).rejects.toThrow(/修改插件/)
    expect(await withProfileOperation('C:/test/profile-home', 'other', async () => 'independent')).toBe('independent')
    finish()
    expect(await changing).toBe('manifest enabled')
    expect(await withProfileOperation('C:/test/profile-home', 'web', async () => 'startup')).toBe('startup')
  })
  it('continues blocking plugin changes after spawn until the boot lease is released', async () => {
    const done = beginProfileBoot('C:/test/boot-home', 'web')
    try { await expect(withProfileOperation('C:/test/boot-home', 'web', async () => 'plugin')).rejects.toThrow(/启动/) }
    finally { done() }
    done()
    expect(await withProfileOperation('C:/test/boot-home', 'web', async () => 'plugin')).toBe('plugin')
  })
  it('releases the lock after errors instead of leaving the instance permanently busy', async () => {
    await expect(withProfileOperation('C:/test/failing-home', 'web', async () => { throw new Error('install failed') })).rejects.toThrow('install failed')
    expect(await withProfileOperation('C:/test/failing-home', 'web', async () => 'retry')).toBe('retry')
  })
})
