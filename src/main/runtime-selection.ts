import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { DshInstance, LauncherConfig } from '../shared/types'
import { isDshInstance, normalizeRuntimeVersion } from '../shared/runtime-version'

function pathKey(path: string): string {
  let result = resolve(path)
  try { result = realpathSync(result) } catch { /* New home, not created yet. */ }
  return process.platform === 'win32' ? result.toLowerCase() : result
}

export function sameRuntimeHome(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b)
}

export function runtimeInstanceForProfile(cfg: LauncherConfig, home: string, profile: string): DshInstance | undefined {
  return cfg.instances.find(inst => isDshInstance(inst) && inst.profile === profile && sameRuntimeHome(inst.dshHome ?? cfg.dshHome, home))
}

/** Dedicated DSH installs are never targets of the global runtime updater. */
export function instanceRuntimeDir(cfg: LauncherConfig, inst: DshInstance, version = normalizeRuntimeVersion(inst.runtimeVersion)): string {
  const normalized = normalizeRuntimeVersion(version)
  if (!normalized) throw new Error('实例未选择固定版本 / No fixed version selected')
  if (!isAbsolute(cfg.runtimeRoot)) throw new Error('运行环境根目录必须是绝对路径 / Runtime root must be an absolute path')
  const key = createHash('sha256').update(inst.id).digest('hex').slice(0, 24)
  return join(cfg.runtimeRoot, 'instance-runtimes', key, normalized)
}

export function runtimePackageVersion(dir: string): string | null {
  try {
    const data = JSON.parse(readFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
    return typeof data.version === 'string' ? data.version : null
  } catch { return null }
}

export function runtimeBin(dir: string): string {
  return join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

export function installedInstanceRuntime(cfg: LauncherConfig, inst: DshInstance): boolean {
  const version = normalizeRuntimeVersion(inst.runtimeVersion)
  if (!version) return false
  const dir = instanceRuntimeDir(cfg, inst, version)
  try {
    const ready = JSON.parse(readFileSync(join(dir, 'launcher-runtime.json'), 'utf8'))
    return ready.version === version && runtimePackageVersion(dir) === version && existsSync(runtimeBin(dir))
  } catch { return false }
}

/** DSH maintains a home-wide fallback layer: incompatible runtimes must not share it. */
export function validateRuntimeSelection(cfg: LauncherConfig): void {
  for (const inst of cfg.instances) {
    const version = normalizeRuntimeVersion(inst.runtimeVersion)
    if (!version) continue
    if (!isDshInstance(inst)) throw new Error('只有 DSH 实例可选择运行版本 / Only DSH instances can select a runtime')
    const home = inst.dshHome
    if (!home || !isAbsolute(home) || sameRuntimeHome(home, cfg.dshHome)) {
      throw new Error('固定版本需要独立数据目录，请新建独立数据实例 / Fixed versions require a dedicated DSH home')
    }
    if (cfg.instances.some(other => other.id !== inst.id && isDshInstance(other) && sameRuntimeHome(other.dshHome ?? cfg.dshHome, home))) {
      throw new Error(`实例「${inst.name}」的数据目录被其他实例共享，不能隔离运行版本 / This home is shared by another instance`)
    }
  }
}
