/** A fixed runtime must be an exact npm version, never a tag, range or path. */
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/

export function normalizeRuntimeVersion(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('DSH 版本必须是精确版本号 / An exact DSH version is required')
  const version = value.trim().replace(/^v/, '')
  if (!version) return undefined
  if (version.length > 100 || !EXACT_VERSION.test(version)) {
    throw new Error('请输入精确 DSH 版本（如 0.2.1-rc.2），不支持 latest、范围或路径 / Enter an exact DSH version')
  }
  return version
}

export function isDshInstance(instance: { kind?: string }): boolean {
  return !instance.kind || instance.kind === 'dsh'
}

/** CLI --no-open was introduced in 0.1.0-rc.7; later minor/major lines support it too. */
export function dshSupportsNoOpen(version: string | null): boolean {
  if (!version) return false
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/.exec(version.replace(/^v/, ''))
  if (!match) return false
  const [, major, minor, patch, pre] = match
  if (Number(major) > 0 || Number(minor) > 1 || (Number(minor) === 1 && Number(patch) > 0)) return true
  if (Number(minor) !== 1 || Number(patch) !== 0) return false
  if (!pre) return true
  const rc = /^rc\.(\d+)$/.exec(pre)
  return !!rc && Number(rc[1]) >= 7
}

export function validateInstancePort(value: unknown, fixed = false): number {
  const port = Number(value ?? 0)
  if (!Number.isInteger(port) || port < (fixed ? 1 : 0) || port > 65535) {
    throw new Error(fixed ? 'Web 实例端口必须为 1–65535 / Web port must be 1–65535' : '端口必须为 0–65535 的整数 / Port must be an integer from 0 to 65535')
  }
  return port
}
