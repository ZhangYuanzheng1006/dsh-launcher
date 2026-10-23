import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import type { CmdResult, DshInstance, DshRuntimeCatalog, InstanceRuntimeInfo, LauncherConfig } from '../shared/types'
import { isDshInstance, normalizeRuntimeVersion } from '../shared/runtime-version'
import { getConfig } from './config'
import { removeDirSafe } from './fs-safe'
import { bundledEnv, compareSemver, currentDshVersion, dshInstallDir, ensureInstallAllowBuilds, nodeDir, resolveBundledNode } from './runtime'
import { instanceRuntimeDir, installedInstanceRuntime, runtimeBin, runtimePackageVersion, validateRuntimeSelection } from './runtime-selection'
import { outputOf, runAsync, taskDone, taskLine } from './task'
import { writeJsonAtomic } from './atomic-json'

export interface InstanceCli {
  cmd: string
  args: string[]
  cwd: string
  envPatch: NodeJS.ProcessEnv
  version: string | null
  packaged: boolean
}

let catalogCache: { at: number; catalog: DshRuntimeCatalog } | null = null

export async function listDshRuntimeVersions(): Promise<DshRuntimeCatalog> {
  if (catalogCache && Date.now() - catalogCache.at < 5 * 60_000) return catalogCache.catalog
  const response = await fetch('https://registry.npmjs.org/@deepseek-ai/dsh', {
    headers: { Accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(8000)
  })
  if (!response.ok) throw new Error(`获取 DSH 版本失败 / Cannot fetch DSH versions: HTTP ${response.status}`)
  const data = await response.json() as { versions?: Record<string, unknown>; 'dist-tags'?: Record<string, unknown> }
  const versions = Object.keys(data.versions ?? {}).filter(version => {
    try { return normalizeRuntimeVersion(version) === version } catch { return false }
  }).sort((a, b) => compareSemver(b, a))
  const tags = Object.fromEntries(Object.entries(data['dist-tags'] ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && versions.includes(entry[1])))
  const catalog = { versions: versions.slice(0, 200), tags }
  catalogCache = { at: Date.now(), catalog }
  return catalog
}

export function getInstanceRuntimeInfo(inst: DshInstance, cfg = getConfig()): InstanceRuntimeInfo {
  const version = normalizeRuntimeVersion(inst.runtimeVersion)
  const dir = version ? instanceRuntimeDir(cfg, inst, version) : cfg.installMode === 'bundled' ? dshInstallDir() : cfg.harnessRepo
  return {
    instanceId: inst.id,
    mode: version ? 'fixed' : 'inherit',
    requestedVersion: version ?? null,
    installedVersion: version ? runtimePackageVersion(dir) : currentDshVersion(),
    installed: version ? installedInstanceRuntime(cfg, inst) : cfg.installMode === 'bundled'
      ? existsSync(runtimeBin(dir)) && !!resolveBundledNode()
      : !!cfg.harnessRepo && cfg.launchArgs.some(arg => !arg.startsWith('-') && existsSync(isAbsolute(arg) ? arg : join(cfg.harnessRepo, arg))),
    installDir: dir
  }
}

/** The same resolution is used for boot and every `dsh plugin` command. */
export function resolveInstanceCli(inst: DshInstance, cfg = getConfig()): InstanceCli {
  const version = normalizeRuntimeVersion(inst.runtimeVersion)
  const home = inst.dshHome ?? cfg.dshHome
  if (version) {
    validateRuntimeSelection(cfg)
    if (!installedInstanceRuntime(cfg, inst)) {
      throw new Error(`DSH ${version} 未安装或不完整，请在实例设置中安装 / Install this instance's fixed runtime first`)
    }
    const dir = instanceRuntimeDir(cfg, inst, version)
    const cmd = resolveBundledNode() ?? cfg.nodePath
    return {
      cmd, args: [runtimeBin(dir)], cwd: dir, version, packaged: true,
      envPatch: { ...bundledEnv(), DSH_HOME: home, ...(isAbsolute(cmd) ? { PATH: `${dirname(cmd)}${delimiter}${process.env.PATH ?? ''}` } : {}) }
    }
  }
  if (cfg.installMode === 'bundled') {
    const node = resolveBundledNode()
    const dir = dshInstallDir()
    if (!node || !existsSync(runtimeBin(dir))) throw new Error('共享运行环境未安装完整，请到设置安装 / Install the shared runtime in Settings')
    return { cmd: node, args: [runtimeBin(dir)], cwd: dir, version: currentDshVersion(), packaged: true, envPatch: { ...bundledEnv(), DSH_HOME: home } }
  }
  return {
    cmd: cfg.nodePath,
    args: cfg.launchArgs.map(arg => !arg.startsWith('-') && !isAbsolute(arg) && existsSync(join(cfg.harnessRepo, arg)) ? join(cfg.harnessRepo, arg) : arg),
    cwd: cfg.harnessRepo, version: currentDshVersion(), packaged: false, envPatch: { DSH_HOME: home }
  }
}

/** Resolve pnpm's JS entry so paths with spaces never pass through cmd.exe. */
function pnpmRunner(cfg: LauncherConfig, node: string): { cmd: string; args: string[] } {
  const candidates = [join(nodeDir(), 'pnpm.cmd'), cfg.pnpm]
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['pnpm'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    candidates.push(...found.trim().split(/\r?\n/))
  } catch { /* Explicit/portable paths can still work. */ }
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || !existsSync(candidate)) continue
    if (/\.(?:c?js|mjs)$/i.test(candidate)) return { cmd: node, args: [candidate] }
    for (const script of [join(dirname(candidate), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), join(dirname(candidate), '..', 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')]) {
      if (existsSync(script)) return { cmd: node, args: [script] }
    }
    if (/\.exe$/i.test(candidate)) return { cmd: candidate, args: [] }
  }
  throw new Error('未找到 pnpm，请先安装共享运行环境或 pnpm / Install pnpm or the shared runtime first')
}

/** Publish a completion marker only after verifying the exact package and entry. */
export async function installInstanceRuntime(inst: DshInstance): Promise<CmdResult> {
  const cfg = getConfig()
  const label = `runtime:instance:${inst.id}`
  let stage: string | undefined
  try {
    if (!isDshInstance(inst)) throw new Error('仅 DSH 实例支持运行版本隔离 / Only DSH instances support runtime isolation')
    const version = normalizeRuntimeVersion(inst.runtimeVersion)
    if (!version) throw new Error('请先保存固定版本号 / Save a fixed version first')
    validateRuntimeSelection(cfg)
    if (installedInstanceRuntime(cfg, inst)) {
      taskDone(label, 0)
      return { ok: true, code: 0 }
    }
    const target = instanceRuntimeDir(cfg, inst, version)
    // Never overwrite even a corrupt install; retain it for diagnosis/recovery.
    if (existsSync(target)) throw new Error(`运行目录不完整，请先将其移走再重试 / Move the incomplete runtime aside first: ${target}`)
    mkdirSync(target, { recursive: true })
    // Windows pnpm junctions contain absolute paths: never rename this tree.
    // Consumers require launcher-runtime.json, which is published atomically last.
    stage = target
    const node = resolveBundledNode() ?? cfg.nodePath
    const env = { ...bundledEnv(), DSH_HOME: inst.dshHome, ...(isAbsolute(node) ? { PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ''}` } : {}) }
    const probe = await runAsync(node, ['--eval', 'process.stdout.write(process.versions.node)'], stage, label, false, env, 10_000)
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(probe.stdout?.trim() ?? '')
    if (!probe.ok || !match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 19)) {
      throw new Error('固定版本需要 Node.js 22.19+，请先安装运行环境 / Node.js 22.19+ is required')
    }
    const runner = pnpmRunner(cfg, node)
    writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'dsh-instance-runtime', private: true, version: '0.0.0' }) + '\n')
    ensureInstallAllowBuilds(stage)
    taskLine(label, `安装 / Installing @deepseek-ai/dsh@${version}`)
    const result = await runAsync(runner.cmd, [...runner.args, 'add', '--save-exact', `@deepseek-ai/dsh@${version}`, '--registry=https://registry.npmjs.org', '--config.strictDepBuilds=false'], stage, label, false, env, 20 * 60_000)
    if (!result.ok) {
      const missing = /NO_MATCHING_VERSION|No matching version/.test(outputOf(result))
      return { ...result, error: missing
        ? `DSH ${version} 尚未发布，请从已发布版本列表选择 / This DSH version is not published; choose a listed version`
        : result.error ?? '运行版本安装失败，请查看日志 / Runtime installation failed; see the log' }
    }
    if (runtimePackageVersion(stage) !== version || !existsSync(runtimeBin(stage))) {
      throw new Error('安装校验失败：版本或入口不匹配 / Installed version or entry point does not match')
    }
    writeJsonAtomic(join(target, 'launcher-runtime.json'), { version, installedAt: new Date().toISOString(), nodeVersion: probe.stdout?.trim() })
    stage = undefined
    taskLine(label, `DSH ${version} 已就绪 / Ready; ${target}`)
    taskDone(label, 0)
    return { ok: true, code: 0 }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    taskLine(label, message, 'stderr')
    taskDone(label, 1)
    return { ok: false, code: 1, error: message }
  } finally {
    // This directory was created by this attempt; existing installs are never removed.
    if (stage) await removeDirSafe(stage)
  }
}
