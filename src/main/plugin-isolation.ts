import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LauncherConfig } from '../shared/types'
import { instanceRuntimeDir, runtimeInstanceForProfile } from './runtime-selection'

function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Frozen local plugin copies keep Node resolution away from the shared library. */
export async function isolateLocalPluginSpec(cfg: LauncherConfig, home: string, profile: string, spec: string): Promise<string> {
  const inst = runtimeInstanceForProfile(cfg, home, profile)
  if (!inst?.runtimeVersion) return spec
  let source = spec.replace(/^(?:file:|link:)/, '')
  if (spec.startsWith('file://')) source = fileURLToPath(spec)
  if (/^(?:file:|link:)/.test(spec) && !isAbsolute(source)) source = resolve(process.cwd(), source)
  if (/^(?:file:|link:)/.test(spec) && !existsSync(join(source, 'package.json'))) {
    throw new Error('本地插件目录不存在或缺少 package.json / Local plugin directory or package.json is missing')
  }
  if (!isAbsolute(source) || !existsSync(join(source, 'package.json'))) return spec
  source = realpathSync(source)
  const root = join(home, 'launcher-plugin-snapshots')
  if (within(source, root)) throw new Error('插件源目录不能包含目标快照目录 / Plugin source cannot contain the snapshot directory')
  mkdirSync(root, { recursive: true })
  const snapshot = join(mkdtempSync(join(root, 'plugin-')), 'package')
  await cp(source, snapshot, {
    recursive: true,
    filter: path => !['node_modules', '.git', '.env', '.credentials.yaml'].includes(basename(path)) && !lstatSync(path).isSymbolicLink()
  })
  writeFileSync(join(dirname(snapshot), 'source.json'), JSON.stringify({ source, runtimeVersion: inst.runtimeVersion, createdAt: new Date().toISOString() }))
  return `file:${snapshot}`
}

export function originalPluginSource(home: string, snapshot: string): string | null {
  if (!within(join(home, 'launcher-plugin-snapshots'), snapshot)) return null
  try {
    const data = JSON.parse(readFileSync(join(dirname(snapshot), 'source.json'), 'utf8'))
    return typeof data.source === 'string' && isAbsolute(data.source) && existsSync(join(data.source, 'package.json')) ? data.source : null
  } catch { return null }
}

/** Fail closed for old links rather than silently loading another version's peers. */
export function assertIsolatedPluginPaths(cfg: LauncherConfig, home: string, profile: string): void {
  const inst = runtimeInstanceForProfile(cfg, home, profile)
  if (!inst?.runtimeVersion) return
  const dir = join(home, 'profiles', profile)
  if (!existsSync(join(dir, 'package.json'))) return
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, '')) as { dependencies?: Record<string, string> }
  const runtimeDir = instanceRuntimeDir(cfg, inst)
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (!/^(?:link:|file:)/.test(spec)) continue
    let target = spec.startsWith('file://') ? fileURLToPath(spec) : resolve(dir, spec.replace(/^(?:link:|file:)/, ''))
    try { target = realpathSync(join(dir, 'node_modules', name)) } catch { /* Missing install still needs the location check. */ }
    if (!within(home, target) && !within(runtimeDir, target)) {
      throw new Error(`插件 ${name} 仍链接到共享目录，请在本实例重新安装以建立隔离副本 / Reinstall this linked plugin for runtime isolation`)
    }
  }
}
