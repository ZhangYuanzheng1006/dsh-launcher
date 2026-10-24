import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertIsolatedPluginPaths, isolateLocalPluginSpec } from '../src/main/plugin-isolation'
import { config, instance } from './helpers/runtime-fixture'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-plugin-isolation-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('fixed-version plugin isolation', () => {
  it('takes an independent local package snapshot without shared dependencies or private files', async () => {
    const inst = instance('a', root, '0.2.1-rc.2')
    const cfg = config(root, [inst])
    const source = join(root, 'library', 'sample')
    mkdirSync(join(source, 'node_modules'), { recursive: true })
    writeFileSync(join(source, 'package.json'), '{"name":"sample","version":"1.0.0"}')
    writeFileSync(join(source, 'index.js'), 'old')
    writeFileSync(join(source, '.env'), 'private')
    writeFileSync(join(source, 'node_modules', 'shared'), 'must not copy')
    const spec = await isolateLocalPluginSpec(cfg, inst.dshHome!, inst.profile, source)
    expect(spec.startsWith('file:')).toBe(true)
    const snapshot = spec.slice(5)
    writeFileSync(join(source, 'index.js'), 'changed')
    expect(readFileSync(join(snapshot, 'index.js'), 'utf8')).toBe('old')
    expect(existsSync(join(snapshot, 'node_modules'))).toBe(false)
    expect(existsSync(join(snapshot, '.env'))).toBe(false)
    expect(await isolateLocalPluginSpec(cfg, inst.dshHome!, inst.profile, 'sample@1.0.0')).toBe('sample@1.0.0')
  })
  it('refuses preexisting external local links while preserving their manifest', () => {
    const inst = instance('a', root, '0.2.1-rc.2')
    const cfg = config(root, [inst])
    const dir = join(inst.dshHome!, 'profiles', inst.profile)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'package.json')
    const manifest = JSON.stringify({ dependencies: { sample: `link:${join(root, 'shared-library')}` } })
    writeFileSync(file, manifest)
    expect(() => assertIsolatedPluginPaths(cfg, inst.dshHome!, inst.profile)).toThrow(/重新安装/)
    expect(readFileSync(file, 'utf8')).toBe(manifest)
    writeFileSync(file, JSON.stringify({ dependencies: { sample: `file:${join(inst.dshHome!, 'launcher-plugin-snapshots', 'sample')}` } }))
    expect(() => assertIsolatedPluginPaths(cfg, inst.dshHome!, inst.profile)).not.toThrow()
  })
  it('snapshots relative file/link specs and rejects missing local packages at install time', async () => {
    const inst = instance('relative', root, '0.2.1-rc.2')
    const cfg = config(root, [inst])
    const source = join(root, 'local-package')
    mkdirSync(source)
    writeFileSync(join(source, 'package.json'), '{"name":"local-package","version":"1.0.0"}')
    const rel = relative(process.cwd(), source)
    for (const prefix of ['file:', 'link:']) {
      const spec = await isolateLocalPluginSpec(cfg, inst.dshHome!, inst.profile, prefix + rel)
      expect(spec.startsWith(`file:${inst.dshHome}`)).toBe(true)
      expect(existsSync(join(spec.slice(5), 'package.json'))).toBe(true)
    }
    await expect(isolateLocalPluginSpec(cfg, inst.dshHome!, inst.profile, 'file:../does-not-exist-qa')).rejects.toThrow(/不存在/)
  })
})
