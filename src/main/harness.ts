// Per-instance dsh lifecycle: one spawn per DshInstance (own profile, port,
// session workspace), all sharing the same runtime and DSH_HOME. Instances run
// in parallel; each has its own state/log, port probe, and external monitor.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { createConnection } from 'node:net'
import { watchPort } from './browser-guard'
import { getConfig } from './config'
import { getInstance, getInstances, ensureWorkspace, instanceDshHome, stripBomIfPresent, ensureProfile, updateInstance } from './instances'
import { t } from './i18n'
import { resolveInstanceCli } from './instance-runtime'
import { acquireRuntimeUse } from './runtime-activity'
import { assertIsolatedPluginPaths } from './plugin-isolation'
import { beginProfileBoot, withProfileOperation } from './profile-activity'
import { dshSupportsNoOpen, isDshInstance, validateInstancePort } from '../shared/runtime-version'
import { broadcast } from './bus'
import { ensureRuntimeLinks, healBrokenDeps, missingProfilePlugin, removeBrokenPlugin } from './plugins'
import * as guiView from './gui-view'
import * as guiDiscovery from './gui-discovery'
import { resolveGuiExecutable } from './gui-path-repair'
import { chromeLaunchArgs, chromeProfileDir, resolveChromeProfileMode } from './chrome-profile'
import { guiChildEnv, guiPolicyRequiresNewWindow, guiPolicyStopMode, resolveGuiWindowPolicy, type GuiWindowPolicy } from './gui-window-pure'
import { findProcessIdsByImagePath } from './gui-win32'
import type { DshInstance, HarnessState, InstanceOperationEvent, LauncherConfig, LogLine } from '../shared/types'
import { GUI_APP_LOG_PREFIX } from '../shared/log'
import { parsePowerShellCommand } from '../shared/ps-command'

const MAX_LOG = 6000
// Strip ANSI colour/control sequences so the console stays clean.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

interface Runtime {
  instanceId: string
  child: ChildProcess | null
  state: HarnessState
  log: LogLine[]
  portTimer: NodeJS.Timeout | null
  startTimer: NodeJS.Timeout | null
  stopping: boolean
  /** 同步防并发双启动:startInstance 入口置位,函数返回/异常后清除。 */
  starting: boolean
  startCancelled: boolean
  releaseProfileBoot: (() => void) | null
  /** 主动停止完成的时间戳(ms);external 判定冷却期起点,0 表示未停止过。 */
  stoppedAt: number
  /** 跨 chunk 的行缓冲:stdout/stderr 分界处的半行在下一 chunk 续接,防止日志行被截断。 */
  pending: { stdout: string; stderr: string }
  /** Actual bound port: the configured one, or parsed from dsh's log when the instance uses port 0. */
  effectivePort: number
  /** Last time the child produced any output (for the stuck-detection grace period). */
  lastOutputAt: number
  /** 启动失败自愈是否已重试(每次 start 只自愈重试一次,防止损坏插件连环重试死循环)。 */
  healRetried: boolean
  /** GUI 实例实际窗口所属进程(已运行应用接管或 spawn 的根进程退出后仍可停止)。 */
  guiTargetPid: number | null
  /** Chrome 等共享进程只关闭选中窗口,绝不 taskkill 整个浏览器进程树。 */
  guiStopMode: 'tree' | 'window' | 'detach' | null
  /** GUI 窗口选择策略(当前用于 Chrome 根进程退出后继续轮询)。 */
  guiPolicy: GuiWindowPolicy | null
  /** 每次 start 递增;后台停止清扫据此避免误杀重启后的新进程。 */
  lifecycleEpoch: number
}

// Startup timeout is not a hard wall-clock deadline: dsh cold boots (source
// build, many plugins) can legitimately take minutes while still printing
// progress. The timer only marks a failure once the process has been *silent*
// for START_IDLE_GRACE — alive-but-idle is the real "stuck" signal. Every
// START_CHECK_INTERVAL a "still starting" notice is emitted so a long boot
// never reads as hung.
const START_IDLE_GRACE = 120_000
const START_CHECK_INTERVAL = 15_000

const runtimes = new Map<string, Runtime>()

function makeState(inst: DshInstance): HarnessState {
  return {
    instanceId: inst.id,
    status: 'stopped',
    pid: null,
    profile: inst.profile,
    port: inst.port,
    startedAt: null,
    ready: false,
    exitCode: null,
    lastError: null,
    pendingRestart: false,
    guiAttached: false
  }
}

function ensureRuntime(id: string): Runtime {
  const inst = getInstance(id)
  let rt = runtimes.get(id)
  if (!rt) {
    rt = {
      instanceId: id,
      child: null,
      state: inst ? makeState(inst) : { instanceId: id, status: 'stopped', pid: null, profile: 'web', port: 0, startedAt: null, ready: false, exitCode: null, lastError: null, pendingRestart: false },
      log: [],
      portTimer: null,
      startTimer: null,
      stopping: false,
      starting: false,
      startCancelled: false,
      releaseProfileBoot: null,
      stoppedAt: 0,
      pending: { stdout: '', stderr: '' },
      effectivePort: inst?.port ?? 0,
      lastOutputAt: 0,
      healRetried: false,
      guiTargetPid: null,
      guiStopMode: null,
      guiPolicy: null,
      lifecycleEpoch: 0
    }
    runtimes.set(id, rt)
  }
  return rt
}

export function getState(id: string): HarnessState {
  return { ...ensureRuntime(id).state }
}

export function instanceHasProcess(id: string): boolean {
  const rt = runtimes.get(id)
  return !!rt && (rt.starting || !!rt.child || !!rt.guiTargetPid)
}

export function getLog(id: string): LogLine[] {
  return ensureRuntime(id).log.slice()
}

/**
 * Mark a running instance as awaiting a manual restart (its plugin set changed
 * and only takes effect on next boot). Ignored unless the instance is running —
 * a stopped instance simply picks the change up when it starts.
 */
export function markPendingRestart(id: string): void {
  const rt = ensureRuntime(id)
  if (rt.state.status !== 'running') return
  patch(rt, { pendingRestart: true })
}

/** States for every configured instance (id → state), used by the boot bootstrap. */
export function getAllStates(): Record<string, HarnessState> {
  const out: Record<string, HarnessState> = {}
  for (const inst of getInstances()) out[inst.id] = getState(inst.id)
  return out
}

export function getAllLogs(): Record<string, LogLine[]> {
  const out: Record<string, LogLine[]> = {}
  for (const inst of getInstances()) out[inst.id] = getLog(inst.id)
  return out
}

/** 清空所有实例的日志缓冲,并广播让 UI 清空显示。 */
export function clearAllLogs(): void {
  for (const inst of getInstances()) {
    const rt = runtimes.get(inst.id)
    if (rt) rt.log = []
  }
  broadcast({ type: 'logs-cleared' })
}

function patch(rt: Runtime, p: Partial<HarnessState>): void {
  if (p.status === 'running' || ((p.status === 'stopped' || p.status === 'error') && !rt.child)) {
    rt.releaseProfileBoot?.()
    rt.releaseProfileBoot = null
  }
  rt.state = { ...rt.state, ...p }
  broadcast({ type: 'state', state: getState(rt.instanceId) })
}

// 每个实例的 dsh web 认证 URL(带 launchToken)。安全:只留在主进程,不广播给渲染层;
// 日志显示时会把 token 抹掉。
const authUrls = new Map<string, string>()
let onAuthUrlCb: ((id: string, url: string) => void) | null = null

/** 注册 dsh web 认证 URL 变化回调(供 dshview 在活动实例拿到新 token 时重载视图)。 */
export function onInstanceAuthUrl(cb: (id: string, url: string) => void): void {
  onAuthUrlCb = cb
}

/** 主进程持有的实例认证 URL(带 launchToken);渲染层拿不到。 */
export function getInstanceAuthUrl(id: string): string | undefined {
  return authUrls.get(id)
}

/** 取走并销毁实例的认证 URL。安全:全部退出时 dsh 必停,下次启动是新 token,销毁无风险。 */
export function consumeInstanceAuthUrl(id: string): string | undefined {
  const url = authUrls.get(id)
  authUrls.delete(id)
  return url
}


function pushLine(rt: Runtime, stream: 'stdout' | 'stderr', raw: string): void {
  let line = raw.replace(ANSI, '')
  if (!line) return
  const at = Date.now()
  // 新版 dsh 的认证:捕获 `dsh web: http://…?launchToken=…` 里的完整 URL(主进程用),
  // 并在日志里把 token 抹掉,避免渲染层日志控制台泄露 token。
  if (stream === 'stdout') {
    const m = line.match(/dsh web:\s*(\S+)/)
    // 新版 dsh 认证 URL 的 token 查询参数名是 `token`(兼容旧 `launchToken`)。
    if (m && /[?&](?:token|launchToken)=/.test(m[1])) {
      authUrls.set(rt.instanceId, m[1])
      onAuthUrlCb?.(rt.instanceId, m[1])
    }
    // 日志脱敏:URL 查询参数里的 token / launchToken 值都抹掉,渲染层不可见。
    line = line.replace(/([?&](?:token|launchToken)=)[^&\s"']+/g, '$1***')
  }
  rt.lastOutputAt = at
  rt.log.push({ stream, line, at })
  if (rt.log.length > MAX_LOG) rt.log.splice(0, rt.log.length - MAX_LOG)
  broadcast({ type: 'log', stream, line, at, instanceId: rt.instanceId })
  // Port 0 instances: adopt the actual port from dsh's own log output once it
  // prints the web URL, so the probe and the embedded view know where to look.
  const inst = getInstance(rt.instanceId)
  if (inst?.kind !== 'gui' && rt.effectivePort === 0 && inst?.port === 0) {
    const port = parsePortFromLine(line)
    if (port && port > 0) {
      rt.effectivePort = port
      patch(rt, { port })
    }
  }
}

/** Match `http(s)://host:port` / `ws(s)://host:port` and return the port. */
function parsePortFromLine(line: string): number | null {
  // 端口后允许 `/`、`?`(新版 dsh 的 URL 带 `?launchToken=…`)、`#`、空格或行尾。
  const m = line.match(/(?:https?|wss?):\/\/(?:\[[^\]]*\]|[^\s/:]+)(?::(\d+))?(?:[/?#]|$|\s)/i)
  if (m && m[1]) return Number(m[1])
  return null
}

function chunkToLines(rt: Runtime, stream: 'stdout' | 'stderr', prefix = ''): (chunk: Buffer) => void {
  return (chunk: Buffer) => {
    // 行缓冲:一个 chunk 里的半行可能在下个 chunk 续完,直接 split 会把一行拆成
    // 两段错误日志。挂到 rt.pending,进程退出时统一 flush。
    rt.pending[stream] += chunk.toString('utf8')
    const lines = rt.pending[stream].split(/\r?\n/)
    rt.pending[stream] = lines.pop() ?? ''
    for (const line of lines) if (line) pushLine(rt, stream, `${prefix}${line}`)
  }
}

interface LaunchPlan {
  cmd: string
  args: string[]
  cwd: string
  envPatch?: NodeJS.ProcessEnv
}

/** Decide how to launch dsh for one instance based on the install mode. */
function launchPlan(cfg: LauncherConfig, inst: DshInstance): LaunchPlan {
  // dsh's CLI boots any named profile via `--profile <name>` — the `web`
  // subcommand is just an alias for `--profile web`, so the flag works for the
  // default instance too. A bare positional would be handed to the booted app
  // and the CLI would error with "--profile <name> is required"; instance
  // profiles are auto-named (`web-2`, …), so the flag is required everywhere.
  const cli = resolveInstanceCli(inst, cfg)
  const inner = [...cli.args, '--profile', inst.profile || 'web', '--port', String(inst.port)]
  // --no-open:新版 dsh(0.1.0-rc.7+,含 0.1.1-*)启动 web 后默认会用系统浏览器打开
  // 自身地址,launcher 已有内嵌视图,必须禁用。该参数只存在于**内置(npm 包)**dsh:
  // 源码版本地 harness 不含它(传了报 unknown option,且本地 harness 不自动开浏览器)。
  // 所以仅 bundled 模式按版本传。
  if (cli.packaged && dshSupportsNoOpen(cli.version)) inner.push('--no-open')
  // 实例的 DSH_HOME:独立 home(inst.dshHome)或共享 cfg.dshHome。显式钉住 env,
  // 防系统级 $DSH_HOME 环境变量漂移(共享实例此前未注入,行为是隐式继承)。
  const home = instanceDshHome(inst)
  return {
    cmd: cli.cmd,
    args: inner,
    cwd: ensureWorkspace(inst),
    envPatch: { ...cli.envPatch, DSH_HOME: home, DSH_AUDIT_PROFILE: inst.profile || 'web' }
  }
}

/** 通用 Web 实例:杀旧端口 → 跑启动命令 → HTTP 探活。用于 Kimi/Codex/agy 等非 dsh 服务。 */
async function startWebInstance(inst: DshInstance, rt: Runtime): Promise<{ ok: boolean; error?: string }> {
  const cfg = getConfig()
  const port = inst.port
  const command = (inst.command ?? '').trim()
  if (!command) return { ok: false, error: t(`实例「${inst.name}」缺少启动命令。`, `Instance "${inst.name}" has no launch command.`) }
  if (!port || port <= 0) return { ok: false, error: t(`实例「${inst.name}」必须配置固定端口。`, `Instance "${inst.name}" requires a fixed port.`) }
  if (await portInUse(port)) {
    const pid = await findListeningPid(port)
    // An executable name (especially node.exe) cannot establish ownership.
    return { ok: false, error: t(`端口 ${port} 已被占用 (pid=${pid ?? '?'})，未结束外部进程，请更换端口或手动处理。`, `Port ${port} is occupied (pid=${pid ?? '?'}); no external process was terminated. Choose another port or resolve it manually.`) }
  }
  rt.effectivePort = port
  patch(rt, { status: 'starting', pid: null, profile: inst.profile || 'web', port, startedAt: Date.now(), ready: false, exitCode: null, lastError: null })
  pushLine(rt, 'stderr', t(`[launcher] 启动 Web 实例「${inst.name}」: ${command}`, `[launcher] Starting web instance "${inst.name}": ${command}`))
  const cwd = inst.workspace && existsSync(inst.workspace) ? inst.workspace : process.cwd()
  let proc: ChildProcess
  try {
    // 落盘成临时 .cmd 再执行:直接 spawn cmd /c "<command>" 会被 Node 的 Windows
    // 参数转义把内层引号变成 \"...\",cmd 找不到可执行文件(2026-10-17 实测)。
    const runDir = join(tmpdir(), 'dsh-launcher-web')
    mkdirSync(runDir, { recursive: true })
    const scriptPath = join(runDir, `${inst.id}.cmd`)
    writeFileSync(scriptPath, `@echo off\r\ncd /d "${cwd}"\r\n${command}\r\n`, 'utf8')
    proc = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${scriptPath}"`], {
      cwd,
      env: { ...process.env },
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    patch(rt, { status: 'error', lastError: message })
    return { ok: false, error: message }
  }
  rt.child = proc
  rt.stopping = false
  rt.stoppedAt = 0
  rt.lastOutputAt = Date.now()
  patch(rt, { pid: proc.pid ?? null })
  proc.stdout?.on('data', chunkToLines(rt, 'stdout'))
  proc.stderr?.on('data', chunkToLines(rt, 'stderr'))
  proc.on('error', (err) => {
    pushLine(rt, 'stderr', t(`[launcher] 进程错误: ${err.message}`, `[launcher] Process error: ${err.message}`))
    patch(rt, { status: 'error', lastError: err.message })
  })
  proc.on('exit', (code, signal) => {
    for (const s of ['stdout', 'stderr'] as const) {
      if (rt.pending[s]) { pushLine(rt, s, rt.pending[s]); rt.pending[s] = '' }
    }
    pushLine(rt, 'stderr', t(`[launcher] 进程退出 code=${code ?? 'null'} signal=${signal ?? 'none'}`, `[launcher] Process exited code=${code ?? 'null'} signal=${signal ?? 'none'}`))
    rt.child = null
    stopPortProbe(rt)
    clearStartTimer(rt)
    if (!rt.stopping) {
      const bad = rt.state.status === 'starting' || rt.state.status === 'running'
      patch(rt, { status: bad ? 'error' : 'stopped', pid: null, ready: false, exitCode: code, startedAt: null, lastError: code === 0 ? null : t('进程意外退出', 'Process exited unexpectedly') })
    }
  })
  const url = `http://127.0.0.1:${port}${inst.healthPath || '/'}`
  const timeout = cfg.startupTimeoutMs > 0 ? cfg.startupTimeoutMs : 90000
  const ok = await waitHttpOk(url, timeout, rt)
  if (!ok) {
    const msg = t(`健康检查超时或失败: ${url}`, `Health check failed or timed out: ${url}`)
    pushLine(rt, 'stderr', `[launcher] ${msg}`)
    patch(rt, { status: 'error', lastError: msg })
    return { ok: false, error: msg }
  }
  patch(rt, { status: 'running', ready: true, startedAt: Date.now() })
  pushLine(rt, 'stderr', t(`[launcher] Web 实例已就绪: ${url}`, `[launcher] Web instance ready: ${url}`))
  return { ok: true }
}

/** Run a PowerShell script instance; stdout/stderr feed the normal per-instance log. */
async function startPowerShellInstance(inst: DshInstance, rt: Runtime): Promise<{ ok: boolean; error?: string }> {
  const parsed = parsePowerShellCommand(inst.command ?? '')
  if (!parsed.ok) {
    pushLine(rt, 'stderr', `[launcher] ${parsed.error}`)
    patch(rt, { status: 'error', lastError: parsed.error })
    return { ok: false, error: parsed.error }
  }
  const cwd = inst.workspace && existsSync(inst.workspace) ? inst.workspace : process.cwd()
  const runDir = join(tmpdir(), 'dsh-launcher-ps')
  mkdirSync(runDir, { recursive: true })
  const scriptPath = join(runDir, `${inst.id}.ps1`)
  // Windows PowerShell 5.1 treats UTF-8 without BOM as ANSI; the BOM keeps
  // Chinese output readable while pwsh also accepts it.
  writeFileSync(scriptPath, `\uFEFF${parsed.command.script}`, 'utf8')

  rt.effectivePort = 0
  patch(rt, {
    status: 'starting',
    pid: null,
    profile: 'ps',
    port: 0,
    startedAt: Date.now(),
    ready: false,
    exitCode: null,
    lastError: null
  })
  pushLine(rt, 'stderr', t(`[launcher] 启动 PowerShell 实例「${inst.name}」`, `[launcher] Starting PowerShell instance "${inst.name}"`))
  pushLine(rt, 'stderr', `[launcher] ${parsed.command.executable} -File ${scriptPath}`)

  let proc: ChildProcess
  try {
    proc = spawn(
      parsed.command.executable,
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { cwd, env: { ...process.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    patch(rt, { status: 'error', lastError: message })
    pushLine(rt, 'stderr', `[launcher] ${message}`)
    return { ok: false, error: message }
  }

  rt.child = proc
  rt.stopping = false
  rt.stoppedAt = 0
  rt.lastOutputAt = Date.now()
  patch(rt, { status: 'running', pid: proc.pid ?? null, ready: true, startedAt: Date.now() })
  proc.stdout?.on('data', chunkToLines(rt, 'stdout'))
  proc.stderr?.on('data', chunkToLines(rt, 'stderr'))
  proc.on('error', (error) => {
    pushLine(rt, 'stderr', t(`[launcher] 进程错误: ${error.message}`, `[launcher] Process error: ${error.message}`))
    patch(rt, { status: 'error', lastError: error.message })
  })
  proc.on('exit', (code, signal) => {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (rt.pending[stream]) {
        pushLine(rt, stream, rt.pending[stream])
        rt.pending[stream] = ''
      }
    }
    pushLine(rt, 'stderr', t(`[launcher] PowerShell 退出 code=${code ?? 'null'} signal=${signal ?? 'none'}`, `[launcher] PowerShell exited code=${code ?? 'null'} signal=${signal ?? 'none'}`))
    rt.child = null
    clearStartTimer(rt)
    stopPortProbe(rt)
    if (!rt.stopping) {
      patch(rt, {
        status: code === 0 || code === null ? 'stopped' : 'error',
        pid: null,
        ready: false,
        exitCode: code,
        startedAt: null,
        lastError: code && code !== 0 ? t('PowerShell 命令执行失败', 'PowerShell command failed') : null
      })
    }
  })
  proc.on('exit', () => { rt.starting = false })
  return { ok: true }
}
/**
 * Attach one already-running GUI window without spawning the executable.
 * Shared by automatic pre-spawn adoption and the explicit "接管现有窗口" action.
 */
async function adoptExistingGuiWindow(
  inst: DshInstance,
  rt: Runtime,
  existing: NonNullable<ReturnType<typeof guiView.findGuiWindowForProcess>>,
  windowPolicy: GuiWindowPolicy,
  foregroundBeforeSpawn: number
): Promise<{ ok: boolean; error?: string }> {
  rt.effectivePort = 0
  rt.guiTargetPid = existing.pid
  rt.guiStopMode = 'detach'
  rt.guiPolicy = windowPolicy
  rt.lifecycleEpoch += 1
  patch(rt, {
    status: 'starting',
    pid: existing.pid,
    profile: 'gui',
    port: 0,
    startedAt: Date.now(),
    ready: false,
    exitCode: null,
    lastError: null,
    guiAttached: false
  })
  pushLine(
    rt,
    'stderr',
    t(
      `[launcher] 检测到同程序的已运行窗口 (pid=${existing.pid}),接管现有实例…`,
      `[launcher] Found an existing window for the same executable (pid=${existing.pid}); adopting it…`
    )
  )
  const adopted = await guiView.attachGuiInstance({
    instanceId: inst.id,
    foregroundBeforeSpawn,
    rootPid: existing.pid,
    exePath: (inst.exe ?? '').trim(),
    windowTitle: inst.windowTitle?.trim() || undefined,
    windowClass: inst.windowClass?.trim() || undefined,
    windowPolicy,
    stopMode: 'detach',
    timeoutMs: 8_000,
    isAlive: () => rt.guiTargetPid === existing.pid && rt.state.status !== 'stopping',
    onLog: (line) => pushLine(rt, 'stderr', line),
    onError: (message) => {
      pushLine(rt, 'stderr', `[launcher] ${message}`)
      if (rt.state.status === 'running' || rt.state.status === 'degraded') {
        patch(rt, { status: 'error', ready: false, startedAt: null, lastError: message })
      }
    },
    onDegraded: (message) => {
      pushLine(rt, 'stderr', `[launcher] ${message}`)
      patch(rt, { status: 'degraded', ready: true, lastError: message })
    }
  })
  if (!adopted.ok) {
    const message = adopted.error ?? t('接管已运行桌面应用失败', 'Failed to adopt the running desktop app')
    if (rt.state.status === 'stopping' || rt.state.status === 'stopped' || rt.guiTargetPid !== existing.pid) {
      return { ok: false, error: message }
    }
    rt.guiTargetPid = null
    rt.guiStopMode = null
    rt.guiPolicy = null
    patch(rt, { status: 'error', pid: null, ready: false, startedAt: null, lastError: message, guiAttached: false })
    pushLine(rt, 'stderr', `[launcher] ${message}`)
    return { ok: false, error: message }
  }
  rt.guiStopMode = adopted.stopMode ?? 'detach'
  patch(rt, {
    status: adopted.degraded ? 'degraded' : 'running',
    pid: adopted.pid ?? existing.pid,
    ready: true,
    startedAt: Date.now(),
    exitCode: null,
    lastError: adopted.degradedReason ?? null,
    guiAttached: true
  })
  guiView.focusGuiInstance(inst.id)
  pushLine(
    rt,
    'stderr',
    t(
      `[launcher] 已接管桌面应用窗口 (HWND=${adopted.hwnd ?? existing.hwnd})${adopted.degraded ? ' [degraded]' : ''}`,
      `[launcher] Adopted the desktop app window (HWND=${adopted.hwnd ?? existing.hwnd})${adopted.degraded ? ' [degraded]' : ''}`
    )
  )
  return { ok: true }
}

/**
 * GUI instance: spawn the app, wait until its main window can be adopted, then
 * hand the window to gui-view for owned-toolwindow embedding. Unlike web
 * instances there is no port/HTTP probe; readiness means "HWND found and the
 * embedding styles/owner verified".
 */
async function startGuiInstance(inst: DshInstance, rt: Runtime): Promise<{ ok: boolean; error?: string }> {
  const cfg = getConfig()
  const foregroundBeforeSpawn = guiView.captureGuiForegroundWindow()
  let exe = (inst.exe ?? '').trim()
  if (!exe) return { ok: false, error: t(`实例「${inst.name}」缺少桌面程序路径。`, `Instance "${inst.name}" has no desktop executable path.`) }
  if (!isAbsolute(exe) || !existsSync(exe)) {
    const repaired = await resolveGuiExecutable(
      { exe, guiPresetId: inst.guiPresetId },
      () => guiDiscovery.discoverGuiApps()
    )
    if (!repaired.newExe) {
      return { ok: false, error: t(`桌面程序不存在或不是绝对路径: ${exe}`, `Desktop executable does not exist or is not absolute: ${exe}`) }
    }
    const oldExe = exe
    exe = repaired.newExe
    inst = {
      ...inst,
      exe,
      ...(repaired.presetId ? { guiPresetId: repaired.presetId } : {})
    }
    const nextCfg = updateInstance(inst.id, {
      exe,
      ...(repaired.presetId ? { guiPresetId: repaired.presetId } : {})
    })
    broadcast({ type: 'instances', instances: nextCfg.instances, activeInstanceId: nextCfg.activeInstanceId })
    pushLine(rt, 'stderr', t(
      `[launcher] exe 已自动更新: ${oldExe} → ${exe}`,
      `[launcher] exe auto-updated: ${oldExe} → ${exe}`
    ))
  }
  let args = Array.isArray(inst.args) ? inst.args.map((arg) => String(arg)) : []
  const windowTitle = inst.windowTitle?.trim() || undefined
  const windowClass = inst.windowClass?.trim() || undefined
  const windowPolicy = resolveGuiWindowPolicy({ exePath: exe, windowPolicy: inst.windowPolicy })
  rt.guiPolicy = windowPolicy
  rt.guiStopMode = guiPolicyStopMode(windowPolicy)
  if (windowPolicy === 'chrome-newest' && resolveChromeProfileMode(inst.chromeProfileMode) === 'isolated') {
    const appDataDir = process.env.APPDATA?.trim() || join(process.env.USERPROFILE?.trim() || tmpdir(), 'AppData', 'Roaming')
    const profileDir = chromeProfileDir(appDataDir, inst.id)
    mkdirSync(profileDir, { recursive: true })
    args = chromeLaunchArgs(args, profileDir)
    pushLine(rt, 'stderr', t(
      `[launcher] Chrome 使用独立 profile（首次启动需要登录，不影响用户自己的 Chrome）: ${profileDir}`,
      `[launcher] Chrome is using an isolated profile (first launch needs sign-in; the user's normal Chrome is untouched): ${profileDir}`
    ))
  }

  // Single-instance Electron apps (notably Antigravity) hand a fresh spawn off
  // to the already-running process and exit. Adopt that existing same-exe window
  // instead of falsely reporting a launch failure. Shared-process multi-window
  // apps (Chrome, VS Code) are deliberately excluded: their existing windows must
  // stay untouched, so a --new-window launch must produce a new HWND selected by
  // the pre-spawn baseline.
  const existing = guiPolicyRequiresNewWindow(windowPolicy)
    ? null
    : guiView.findGuiWindowForProcess({ rootPid: 0, exePath: exe, windowTitle, windowClass }, windowPolicy)
  if (existing) {
    return await adoptExistingGuiWindow(inst, rt, existing, windowPolicy, foregroundBeforeSpawn)
  }
  rt.lifecycleEpoch += 1
  rt.effectivePort = 0
  patch(rt, {
    status: 'starting',
    pid: null,
    profile: 'gui',
    port: 0,
    startedAt: Date.now(),
    ready: false,
    exitCode: null,
    lastError: null,
    guiAttached: false
  })
  pushLine(rt, 'stderr', t(`[launcher] 启动桌面应用「${inst.name}」: ${exe}`, `[launcher] Starting desktop app "${inst.name}": ${exe}`))
  if (args.length) pushLine(rt, 'stderr', `[launcher] args=${JSON.stringify(args)}`)

  // Chrome and VS Code are shared-process/multi-window. Snapshot existing HWNDs
  // immediately before spawn so the attach pass can select only the new window.
  const baselineHwnds = guiPolicyRequiresNewWindow(windowPolicy)
    ? guiView.captureTopLevelWindowBaseline()
    : undefined

  let proc: ChildProcess
  try {
    proc = spawn(exe, args, {
      cwd: dirname(exe),
      // Critical: a GUI Electron app must not inherit the launcher shell's
      // ELECTRON_RUN_AS_NODE=1, or it starts as plain Node and never makes a window.
      env: guiChildEnv(process.env),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    patch(rt, { status: 'error', lastError: message })
    pushLine(rt, 'stderr', t(`[launcher] 桌面应用启动失败: ${message}`, `[launcher] Failed to start desktop app: ${message}`))
    return { ok: false, error: message }
  }

  rt.child = proc
  rt.stopping = false
  rt.stoppedAt = 0
  rt.lastOutputAt = Date.now()
  patch(rt, { pid: proc.pid ?? null })
  proc.stdout?.on('data', chunkToLines(rt, 'stdout', GUI_APP_LOG_PREFIX))
  proc.stderr?.on('data', chunkToLines(rt, 'stderr', GUI_APP_LOG_PREFIX))
  proc.on('error', (err) => {
    pushLine(rt, 'stderr', t(`[launcher] 桌面应用进程错误: ${err.message}`, `[launcher] Desktop app process error: ${err.message}`))
    patch(rt, { status: 'error', lastError: err.message })
  })
  proc.on('exit', (code, signal) => {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (rt.pending[stream]) {
        pushLine(rt, stream, `${GUI_APP_LOG_PREFIX}${rt.pending[stream]}`)
        rt.pending[stream] = ''
      }
    }
    pushLine(rt, 'stderr', t(`[launcher] 桌面应用进程退出 code=${code ?? 'null'} signal=${signal ?? 'none'}`, `[launcher] Desktop app exited code=${code ?? 'null'} signal=${signal ?? 'none'}`))
    rt.child = null
    stopPortProbe(rt)
    clearStartTimer(rt)
    const wasStarting = rt.state.status === 'starting'
    const windowAlive = guiView.isGuiInstanceWindowAlive(inst.id)
    if (!windowAlive) {
      guiView.detachGuiInstance(inst.id)
      patch(rt, { guiAttached: false })
    }
    if (rt.guiPolicy === 'chrome-newest' && wasStarting && !rt.stopping) {
      // Chrome's --new-window launcher process commonly exits immediately after
      // asking the already-running browser process to create a window. Keep the
      // attach loop polling; never treat this handoff as a launch failure.
      pushLine(rt, 'stderr', t(
        '[launcher] Chrome 启动器进程已退出；继续等待共享浏览器进程创建新窗口…',
        '[launcher] Chrome launcher exited; continuing to wait for the shared browser process to create the new window…'
      ))
      return
    }
    if (wasStarting && !rt.stopping) {
      // AppX activation and single-instance apps often exit the spawned stub and
      // create the real window in another process. Let the attach loop resolve
      // the real PID by executable path and continue polling.
      pushLine(rt, 'stderr', t(
        '[launcher] 启动器进程已退出；继续按 exe 路径查找真实窗口进程…',
        '[launcher] Launcher process exited; resolving the real window process by executable path…'
      ))
      patch(rt, { pid: null })
      return
    }
    if (rt.stopping) {
      // Preserve an explicit launch/embedding error instead of replacing it with
      // a generic "stopped" state when our cleanup taskkill lands.
      rt.guiTargetPid = null
      rt.guiStopMode = null
      guiView.detachGuiInstance(inst.id)
      const status = rt.state.status === 'error' ? 'error' : 'stopped'
      patch(rt, { status, pid: null, ready: false, exitCode: code, startedAt: null, guiAttached: false })
      rt.stopping = false
      return
    }
    if ((rt.state.status === 'running' || rt.state.status === 'degraded') && windowAlive) {
      // A launcher stub exited after handing off to the real app process. The
      // owned window remains, so keep the instance running and stop via guiTargetPid.
      pushLine(rt, 'stderr', t('[launcher] 启动器进程已退出,目标窗口仍在运行;已切换到窗口进程托管模式。', '[launcher] The launcher process exited but the target window is still alive; switched to window-process management.'))
      patch(rt, { pid: rt.guiTargetPid ?? rt.state.pid })
      return
    }
    if (wasStarting) {
      patch(rt, { status: 'error', pid: null, ready: false, exitCode: code, startedAt: null, lastError: t('桌面应用在窗口出现前退出', 'Desktop app exited before its window appeared'), guiAttached: false })
    } else if (rt.state.status === 'running' || rt.state.status === 'degraded') {
      patch(rt, { status: 'error', pid: null, ready: false, exitCode: code, startedAt: null, lastError: t('桌面应用意外退出', 'Desktop app exited unexpectedly'), guiAttached: false })
    } else {
      patch(rt, { status: 'stopped', pid: null, ready: false, exitCode: code, startedAt: null, guiAttached: false })
    }
  })

  const timeoutMs = Math.max(15_000, Math.min(cfg.startupTimeoutMs > 0 ? cfg.startupTimeoutMs : 15_000, 30_000))
  const attached = await guiView.attachGuiInstance({
    instanceId: inst.id,
    foregroundBeforeSpawn,
    rootPid: proc.pid ?? 0,
    exePath: exe,
    windowTitle,
    windowClass,
    windowPolicy,
    baselineHwnds,
    keepPollingAfterRootExit: true,
    shouldAbort: () => rt.stopping,
    timeoutMs,
    isAlive: () => !rt.stopping && rt.child === proc && proc.exitCode === null && !proc.killed,
    onLog: (line) => pushLine(rt, 'stderr', line),
    onError: (message) => {
      pushLine(rt, 'stderr', `[launcher] ${message}`)
      if (rt.state.status === 'running' || rt.state.status === 'degraded') {
        patch(rt, { status: 'error', ready: false, startedAt: null, lastError: message })
      } else if (rt.child) {
        patch(rt, { lastError: message })
      }
    },
    onDegraded: (message) => {
      pushLine(rt, 'stderr', `[launcher] ${message}`)
      patch(rt, { status: 'degraded', ready: true, lastError: message })
    }
  })
  if (!attached.ok) {
    const message = attached.error ?? t('桌面应用窗口嵌入失败', 'Failed to embed the desktop app window')
    if (rt.state.status === 'stopping' || rt.state.status === 'stopped') {
      return { ok: false, error: message }
    }
    rt.stopping = true
    // Never taskkill a Chrome launcher that handed off to the user's existing
    // browser process: that would close every unrelated Chrome window.
    if (proc.pid && !guiPolicyRequiresNewWindow(windowPolicy)) {
      spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
    }
    rt.guiStopMode = null
    patch(rt, { status: 'error', pid: null, ready: false, startedAt: null, lastError: message, guiAttached: false })
    pushLine(rt, 'stderr', `[launcher] ${message}`)
    return { ok: false, error: message }
  }

  rt.guiTargetPid = attached.pid ?? proc.pid ?? null
  // A process the launcher spawned is ours to stop. Shared-process policies keep
  // their window/detach semantics so VSCode/Chrome never lose unrelated windows;
  // single-instance apps (ZCode, Zotero, Typora, Qoder, …) are killed as trees.
  rt.guiStopMode = guiPolicyRequiresNewWindow(windowPolicy)
    ? guiPolicyStopMode(windowPolicy)
    : 'tree'
  patch(rt, {
    status: attached.degraded ? 'degraded' : 'running',
    pid: proc.pid ?? attached.pid ?? null,
    ready: true,
    startedAt: Date.now(),
    exitCode: null,
    lastError: attached.degradedReason ?? null,
    guiAttached: true
  })
  pushLine(
    rt,
    'stderr',
    t(
      `[launcher] 桌面应用已嵌入内容区 (HWND=${attached.hwnd ?? '?'})${attached.degraded ? ' [degraded]' : ''}`,
      `[launcher] Desktop app embedded in the content area (HWND=${attached.hwnd ?? '?'})${attached.degraded ? ' [degraded]' : ''}`
    )
  )
  return { ok: true }
}
/** 轮询 HTTP 直到 2xx/3xx;进程退出或停止标记则提前失败。 */
async function waitHttpOk(url: string, timeoutMs: number, rt: Runtime): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (rt.stopping || !rt.child) return false
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) })
      if (res.status >= 200 && res.status < 400) return true
    } catch { /* 尚未就绪 */ }
    await delay(1000)
  }
  return false
}

export async function startInstance(id: string, healingRetry = false): Promise<{ ok: boolean; error?: string }> {
  const inst = getInstance(id)
  if (!inst) return { ok: false, error: t('实例不存在。', 'Instance not found.') }
  const rt = ensureRuntime(id)
  // 同步防并发双启动:两处检查都在任何 await 之前完成;第二个并发调用看到
  // rt.starting 立即被拒,杜绝「rt.child 尚未赋值 → 双 spawn → 首个进程泄漏」。
  if (rt.child || rt.guiTargetPid) return { ok: false, error: t(`实例「${inst.name}」已在运行`, `Instance "${inst.name}" is already running`) }
  if (rt.starting) return { ok: false, error: t(`实例「${inst.name}」正在启动中,请稍候`, `Instance "${inst.name}" is starting, please wait`) }
  let release: (() => void) | undefined
  rt.starting = true
  rt.startCancelled = false
  if (!healingRetry) rt.healRetried = false
  try {
    if (isDshInstance(inst)) release = acquireRuntimeUse(id)
    if (isDshInstance(inst)) patch(rt, { status: 'starting', ready: false, lastError: null })
    if (inst.kind !== 'gui' && inst.kind !== 'ps') {
      validateInstancePort(inst.port, inst.kind === 'web')
      if (inst.port > 0 && getInstances().some(other => other.id !== id && other.port === inst.port)) {
        throw new Error(`端口 ${inst.port} 已分配给其他实例 / Port is assigned to another instance`)
      }
    }
    const result = isDshInstance(inst)
      ? await withProfileOperation(instanceDshHome(inst), inst.profile, () => startInstanceInner(inst, rt))
      : await startInstanceInner(inst, rt)
    if (!result.ok) patch(rt, { status: rt.startCancelled ? 'stopped' : 'error', ready: false, lastError: rt.startCancelled ? null : result.error ?? 'Start failed' })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    patch(rt, { status: rt.startCancelled ? 'stopped' : 'error', ready: false, lastError: rt.startCancelled ? null : message })
    pushLine(rt, 'stderr', `[launcher] ${message}`)
    return { ok: false, error: message }
  } finally {
    release?.()
    rt.starting = false
  }
}

async function startInstanceInner(inst: DshInstance, rt: Runtime): Promise<{ ok: boolean; error?: string }> {
  if (inst.kind === 'web') return await startWebInstance(inst, rt)
  if (inst.kind === 'ps') return await startPowerShellInstance(inst, rt)
  if (inst.kind === 'gui') return await startGuiInstance(inst, rt)
  const cfg = getConfig()
  const home = instanceDshHome(inst)
  // Fail before dependency repair or network access if this runtime is missing.
  resolveInstanceCli(inst, cfg)
  assertIsolatedPluginPaths(cfg, home, inst.profile)
  // 独立 home 缺失 → 快速失败(纯解析、不兜底,防止静默回退到共享 home 的隐蔽错位)。
  if (inst.dshHome != null && !existsSync(home)) {
    return { ok: false, error: t(`实例的独立 DSH_HOME 不存在(可能已被删除): ${home}`, `Instance's isolated DSH_HOME is missing (may have been deleted): ${home}`) }
  }
  // 启动前自愈链接插件的运行时解析层(junction 被清理/重建时重建;幂等、毫秒级,
  // 失败只记日志不阻塞启动——真正的解析错误会由 dsh 启动本身暴露)。
  try {
    await ensureRuntimeLinks(home, inst.profile)
  } catch (e) {
    pushLine(rt, 'stderr', t(`[launcher] 运行时链接层自愈失败: ${String(e)}`, `[launcher] Failed to self-heal the runtime link layer: ${String(e)}`))
  }
  if (rt.startCancelled) return { ok: false, error: t('启动已取消。', 'Startup cancelled.') }
  // 剥离 profile manifest 的 UTF-8 BOM:Windows 记事本等外部工具改写 package.json
  // 时可能写入 BOM,dsh 内核 JSON.parse 不认 BOM 会启动即失败。启动前自愈,幂等。
  if (stripBomIfPresent(join(home, 'profiles', inst.profile, 'package.json'))) {
    pushLine(rt, 'stderr', t(`[launcher] 已修复 profile manifest 的 UTF-8 BOM: ${inst.profile}/package.json`, `[launcher] Stripped UTF-8 BOM from profile manifest: ${inst.profile}/package.json`))
  }
  // 确保 profile 目录物理存在:dsh 内核只对 web/headless 自动初始化,web-2 这类
  // 名字在目录缺失时启动即报 "profile does not exist"(共享模式实例的目录可能因
  // 手动清理/历史遗留而缺失)。启动前按模板补建,自愈。
  const profileDirPath = join(home, 'profiles', inst.profile)
  if (!existsSync(profileDirPath)) {
    ensureProfile(inst.profile, home)
    pushLine(rt, 'stderr', t(`[launcher] 检测到缺失的 profile,已自动补建: ${inst.profile}`, `[launcher] Missing profile detected; auto-created: ${inst.profile}`))
  } else {
    ensureProfile(inst.profile, home)
  }
  // 启动前自愈:清理残留/损坏的插件依赖(下载失败留下的空壳目录、缺入口的 git 源码
  // 残留等),否则 dsh 启动时 include-loader 导入残缺包会让整个 profile 崩掉。
  // 幂等、毫秒级;只动损坏项,失败只记日志不阻塞启动。
  try {
    const healed = healBrokenDeps(home, inst.profile)
    if (healed.length > 0) {
      pushLine(rt, 'stderr', t(`[launcher] 已自动移除损坏的插件残留: ${healed.join(', ')}`, `[launcher] Auto-removed broken plugin residue: ${healed.join(', ')}`))
    }
  } catch (e) {
    pushLine(rt, 'stderr', t(`[launcher] 插件自愈失败(不阻塞启动): ${String(e)}`, `[launcher] Plugin self-heal failed (does not block startup): ${String(e)}`))
  }
  let plan: LaunchPlan
  try {
    plan = launchPlan(cfg, inst)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (cfg.installMode === 'source' && (!plan.cwd || !existsSync(plan.cwd))) {
    return { ok: false, error: t(`harness 仓库不存在: ${plan.cwd}`, `harness repo not found: ${plan.cwd}`) }
  }

  // A listener on a fixed port means either an external dsh the user started, or
  // a leftover dsh orphaned by a previous launcher run that didn't shut down
  // cleanly (taskkill from a killed/crashed launcher can miss it). The latter is
  // the "works the first time, hangs the second" failure: the stale process still
  // holds the port but its server is dead, so the embedded view just spins. When
  // the listener is recognisably a dsh process, reclaim the port instead of
  // erroring; anything else is a genuine conflict we must not touch.
  if (inst.port > 0 && (await portInUse(inst.port))) {
    const pid = await findListeningPid(inst.port)
    return {
        ok: false,
        error: t(
          `端口 ${inst.port} 已被占用 (pid=${pid ?? '?'}) — 可能有另一个 dsh 实例正在运行,请先停止它再启动。`,
          `Port ${inst.port} is already in use (pid=${pid ?? '?'}) — another dsh instance may be running; stop it first.`
        )
    }
  }
  if (rt.startCancelled) return { ok: false, error: t('启动已取消。', 'Startup cancelled.') }

  rt.effectivePort = inst.port
  patch(rt, {
    status: 'starting',
    pid: null,
    profile: inst.profile,
    port: inst.port,
    startedAt: Date.now(),
    ready: false,
    exitCode: null,
    lastError: null
  })
  pushLine(rt, 'stderr', `[launcher] DSH ${inst.runtimeVersion ?? 'shared'} · profile "${inst.profile}"`)
  pushLine(rt, 'stderr', `[launcher] DSH_HOME=${home}`)
  pushLine(rt, 'stderr', `[launcher] ${plan.cmd} ${plan.args.join(' ')}`)

  let proc: ChildProcess
  try {
    rt.releaseProfileBoot = beginProfileBoot(home, inst.profile)
    proc = spawn(plan.cmd, plan.args, {
      cwd: plan.cwd,
      env: { ...process.env, ...(plan.envPatch ?? {}) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    patch(rt, { status: 'error', lastError: message })
    pushLine(rt, 'stderr', t(`[launcher] 启动失败: ${message}`, `[launcher] Failed to start: ${message}`))
    return { ok: false, error: message }
  }

  rt.child = proc
  rt.stopping = false
  rt.stoppedAt = 0 // 新进程存活,external 判定冷却期结束
  rt.lastOutputAt = Date.now()
  patch(rt, { pid: proc.pid ?? null })

  proc.stdout?.on('data', chunkToLines(rt, 'stdout'))
  proc.stderr?.on('data', chunkToLines(rt, 'stderr'))
  proc.on('error', (err) => {
    rt.child = null
    stopPortProbe(rt)
    clearStartTimer(rt)
    pushLine(rt, 'stderr', t(`[launcher] 进程错误: ${err.message}`, `[launcher] Process error: ${err.message}`))
    patch(rt, { status: 'error', pid: null, lastError: err.message })
  })
  proc.on('exit', (code, signal) => {
    // 进程结束时 flush 行缓冲里未换行的尾行。
    for (const s of ['stdout', 'stderr'] as const) {
      if (rt.pending[s]) {
        pushLine(rt, s, rt.pending[s])
        rt.pending[s] = ''
      }
    }
    pushLine(rt, 'stderr', t(`[launcher] 进程退出 code=${code ?? 'null'} signal=${signal ?? 'none'}`, `[launcher] Process exited code=${code ?? 'null'} signal=${signal ?? 'none'}`))
    // 进程退出即清掉认证 token:避免重启后、新 token 到达前用到旧(死进程)token。
    authUrls.delete(rt.instanceId)
    rt.child = null
    stopPortProbe(rt)
    clearStartTimer(rt)
    if (!rt.stopping) {
      // Exited on its own. 清空 startedAt,让「运行时长」随停止归零,不再误导。
      const wasStarting = rt.state.status === 'starting'
      if (rt.state.status === 'running' || wasStarting) {
        patch(rt, { status: 'error', pid: null, ready: false, exitCode: code, startedAt: null, lastError: code === 0 ? null : t('进程意外退出', 'Process exited unexpectedly') })
      } else {
        patch(rt, { status: 'stopped', pid: null, ready: false, exitCode: code, startedAt: null })
      }
      // 启动失败自愈:boot 阶段退出且报「找不到某 profile 插件」→ 移除该插件并自动
      // 重试一次(healRetried 守卫,防止连环损坏时无限重试)。运行中途崩溃不算,避免
      // 误删导致问题变复杂。
      if (code !== 0 && wasStarting && !rt.healRetried) {
        rt.healRetried = true
        const stderr = rt.log.filter((l) => l.stream === 'stderr').map((l) => l.line).join('\n')
        const missing = missingProfilePlugin(home, inst.profile, stderr)
        if (missing) {
          let removed = false
          try {
            removed = removeBrokenPlugin(home, inst.profile, missing)
          } catch { /* 移除失败则保持当前报错状态,交由用户处理 */ }
          // 只有确实移除成功才自动重试,防止无法修复时无限重试。
          if (removed) {
            pushLine(rt, 'stderr', t(`[launcher] 检测到损坏的插件「${missing}」,已自动移除并重新启动…`, `[launcher] Detected broken plugin "${missing}"; auto-removed it and restarting…`))
            setTimeout(() => { if (!rt.startCancelled) void startInstance(inst.id, true) }, 800)
          }
        }
      }
    } else {
      patch(rt, { status: 'stopped', pid: null, ready: false, exitCode: code, startedAt: null })
      rt.stopping = false
    }
  })

  startPortProbe(rt)
  // Lazy startup check: `startupTimeoutMs` is just the first review point, not
  // a death sentence. As long as the child is alive and still emitting output,
  // it is mid-boot (cold source-build boots with many plugins can take minutes);
  // only a silent process gets marked as timed out. If the port becomes ready
  // later anyway, startPortProbe recovers the state to 'running'.
  const checkStart = (): void => {
    if (rt.state.status !== 'starting' || !rt.child) return // exit handler finalizes
    const idle = Date.now() - rt.lastOutputAt
    if (idle < START_IDLE_GRACE) {
      const elapsed = Math.round((Date.now() - (rt.state.startedAt ?? Date.now())) / 1000)
      pushLine(
        rt,
        'stderr',
        t(
          `[launcher] 启动较慢(已 ${elapsed}s),进程仍在输出,继续等待端口就绪…`,
          `[launcher] Startup is slow (${elapsed}s elapsed); the process is still producing output, keeping waiting for the port…`
        )
      )
      rt.startTimer = setTimeout(checkStart, START_CHECK_INTERVAL)
      return
    }
    pushLine(
      rt,
      'stderr',
      t(
        `[launcher] 启动超时 — 进程已 ${Math.round(idle / 1000)}s 无输出,端口 ${rt.effectivePort} 仍未就绪,可能已卡死`,
        `[launcher] Startup timeout — the process has produced no output for ${Math.round(idle / 1000)}s and port ${rt.effectivePort} is still not ready; it may be stuck`
      )
    )
    patch(rt, { status: 'error', lastError: t('启动超时 — 端口未就绪,请检查日志', 'Startup timeout — port not ready, check the logs') })
  }
  rt.startTimer = setTimeout(checkStart, cfg.startupTimeoutMs)
  return { ok: true }
}

function clearStartTimer(rt: Runtime): void {
  if (rt.startTimer) {
    clearTimeout(rt.startTimer)
    rt.startTimer = null
  }
}

function startPortProbe(rt: Runtime): void {
  stopPortProbe(rt)
  rt.portTimer = setInterval(() => {
    if (!rt.child) {
      stopPortProbe(rt)
      return
    }
    if (rt.effectivePort <= 0) return // waiting for dsh to print its actual port
    probePort(rt.effectivePort, (ok) => {
      // 'error' may recover: a slow boot that got flagged by checkStart is still
      // coming up — once the port really opens (child alive), self-heal to
      // 'running' instead of reporting a success as a failure.
      if (ok && rt.child && (rt.state.status === 'starting' || rt.state.status === 'error')) {
        pushLine(rt, 'stdout', t(`[launcher] ✔ 就绪 — Web UI: http://127.0.0.1:${rt.effectivePort}`, `[launcher] ✔ Ready — Web UI: http://127.0.0.1:${rt.effectivePort}`))
        // A manual restart has applied any pending plugin changes — clear the flag.
        patch(rt, { status: 'running', ready: true, port: rt.effectivePort, pendingRestart: false, lastError: null })
        // 就绪后短时高频检测浏览器是否自动弹出了该地址(--no-open 的兜底),窗口 30s 后停止。
        watchPort(rt.effectivePort)
        stopPortProbe(rt)
        clearStartTimer(rt)
      }
    })
  }, 500)
}

function stopPortProbe(rt: Runtime): void {
  if (rt.portTimer) {
    clearInterval(rt.portTimer)
    rt.portTimer = null
  }
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => probePort(port, resolve))
}

function probePort(port: number, cb: (ok: boolean) => void): void {
  const sock = createConnection({ host: '127.0.0.1', port })
  let settled = false
  const done = (ok: boolean): void => {
    if (settled) return
    settled = true
    sock.destroy()
    cb(ok)
  }
  sock.setTimeout(500, () => done(false))
  sock.once('connect', () => done(true))
  sock.once('error', () => done(false))
}

/** Find the PID listening on a TCP port (Windows netstat). */
function findListeningPid(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null)
      return
    }
    let out = ''
    const proc = spawn('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    proc.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    proc.on('error', () => resolve(null))
    proc.on('close', () => {
      const re = new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]|\\[::\\]):${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i')
      const m = out.match(re)
      resolve(m ? Number(m[1]) : null)
    })
  })
}

const GUI_OPERATION_GAP_MS = 250
const GUI_STOP_RESCAN_DEFAULT_MS = 1200
const GUI_STOP_RESCAN_MAX_RETRIES = 2

/** Rescan settings used after a GUI stop to catch watchdog/self-start respawns. */
function guiStopRescanSettings(): { delayMs: number; retries: number } {
  const cfg = getConfig()
  const delayMs = Math.min(5_000, Math.max(300, Math.round(cfg.guiStopRescanMs ?? GUI_STOP_RESCAN_DEFAULT_MS)))
  const retries = Math.min(GUI_STOP_RESCAN_MAX_RETRIES, Math.max(0, Math.round(cfg.guiStopRescanRetries ?? GUI_STOP_RESCAN_MAX_RETRIES)))
  return { delayMs, retries }
}

/** True while a PID exists and is signalable. */
function pidExists(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Wait until every listed PID has exited, or the deadline expires. */
async function waitForPidsGone(pids: readonly number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  let remaining = [...new Set(pids.filter((pid) => pid > 0))]
  while (remaining.length) {
    remaining = remaining.filter(pidExists)
    if (!remaining.length) return true
    if (Date.now() >= deadline) return false
    await delay(100)
  }
  return true
}

/** PIDs currently backed by the same executable image. */
function sameExePids(exePath: string): number[] {
  const exe = exePath.trim()
  return exe ? findProcessIdsByImagePath(exe) : []
}

/** PIDs currently owned by any managed GUI runtime; stop sweeps must never reap these. */
function managedGuiPids(): Set<number> {
  const pids = new Set<number>()
  for (const rt of runtimes.values()) {
    if (rt.child?.pid) pids.add(rt.child.pid)
    if (rt.guiTargetPid) pids.add(rt.guiTargetPid)
  }
  return pids
}

/** Kill each distinct PID tree; taskkill /T covers children spawned by the app. */
async function killGuiProcessTrees(pids: readonly number[]): Promise<void> {
  const unique = [...new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 0))]
  await Promise.all(unique.map((pid) => killPid(pid)))
}

/**
 * Sweep same-exe processes that appear after a stop. Watchdogs such as ZCode and
 * Zotero can respawn within a few hundred ms; only PIDs absent from the
 * pre-stop baseline are killed. A lifecycle generation guard prevents a sweep
 * from killing a process intentionally started by a subsequent restart.
 */
async function sweepGuiRespawns(
  rt: Runtime,
  exePath: string,
  baselinePids: ReadonlySet<number>,
  epoch: number,
  rounds: number,
  block: boolean
): Promise<void> {
  const { delayMs } = guiStopRescanSettings()
  const sweep = async (): Promise<void> => {
    for (let attempt = 0; attempt < rounds; attempt++) {
      await delay(attempt === 0 ? delayMs : Math.max(delayMs, 3_000))
      if (rt.lifecycleEpoch !== epoch || rt.state.status === 'starting' || rt.state.status === 'running' || rt.state.guiAttached) return
      const protectedPids = managedGuiPids()
      const candidates = sameExePids(exePath).filter((pid) => !baselinePids.has(pid) && !protectedPids.has(pid))
      if (!candidates.length) continue
      pushLine(rt, 'stderr', t(
        `[launcher] 停止后发现应用再次自启 (pid=${candidates.join(',')})，执行第 ${attempt + 1}/${rounds} 次清理…`,
        `[launcher] App respawned after stop (pid=${candidates.join(',')}); cleanup attempt ${attempt + 1}/${rounds}…`
      ))
      await killGuiProcessTrees(candidates)
    }
  }
  if (block) await sweep()
  else void sweep()
}

/** Force-kill a process tree by pid. */
function killPid(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const k = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
      const settle = (code: number | null): void => {
        if (code !== 0) {
          try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
        }
        resolve()
      }
      k.on('close', settle)
      k.on('error', () => settle(1))
    } else {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
      resolve()
    }
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Reconcile an instance's state with reality on a timer.
 * - No managed child: a port listener we didn't start ⇒ an external dsh instance
 *   is running. Adopt it as state 'external' (with its PID); flip back to
 *   'stopped' once the port frees.
 * - Managed child in 'running': a dropped port means the server crashed/hung
 *   even though the process is still alive.
 */
async function tickMonitor(rt: Runtime): Promise<void> {
  const port = rt.effectivePort
  if (port <= 0) return
  // 主动停止后的冷却期:taskkill /T 异步释放端口,可能滞后数秒;此期间不把刚停止的
  // 实例误判为「外部 DSH 实例」——否则点过停止,状态却跳成 external,看着像复活。
  if (rt.stoppedAt !== 0 && Date.now() - rt.stoppedAt < 5000) return
  if (!rt.child) {
    const inUse = await portInUse(port)
    if (inUse) {
      if (rt.state.status !== 'external' && rt.state.status !== 'stopping') {
        const pid = await findListeningPid(port)
        pushLine(rt, 'stderr', t(`[launcher] 检测到外部 DSH 实例 (pid=${pid ?? '?'}),端口 ${port} 已被占用`, `[launcher] Detected an external DSH instance (pid=${pid ?? '?'}), port ${port} is in use`))
        patch(rt, { status: 'external', pid, ready: true, startedAt: null, exitCode: null, lastError: null })
      }
    } else if (rt.state.status === 'external' || rt.state.status === 'stopping') {
      // External instance gone, or our external-kill finished.
      patch(rt, { status: 'stopped', pid: null, ready: false })
    }
  } else if (rt.state.status === 'running') {
    const inUse = await portInUse(port)
    if (!inUse) {
      pushLine(rt, 'stderr', t(`[launcher] 端口 ${port} 连接中断,进程可能已异常`, `[launcher] Connection to port ${port} lost — the process may have crashed`))
      patch(rt, { status: 'error', ready: false, lastError: t('端口连接中断,进程可能已异常', 'Connection to the port was lost — the process may have crashed') })
    }
  }
}

// One global monitor walks every configured instance, so instances added later
// are picked up automatically and removed ones are pruned.
let monitorTimer: NodeJS.Timeout | null = null

function startMonitor(): void {
  stopMonitor()
  monitorTimer = setInterval(() => {
    for (const inst of getInstances()) void tickMonitor(ensureRuntime(inst.id))
    // Drop runtimes whose instance was deleted (child already stopped by IPC).
    for (const [id, rt] of runtimes) {
      if (!getInstance(id) && !rt.child) {
        stopPortProbe(rt)
        clearStartTimer(rt)
        runtimes.delete(id)
      }
    }
  }, 2500)
  // Probe once shortly after boot so the initial state is correct.
  setTimeout(() => {
    for (const inst of getInstances()) void tickMonitor(ensureRuntime(inst.id))
  }, 800)
}

function stopMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer)
    monitorTimer = null
  }
}

// Start the external-state monitor as soon as the module loads.
startMonitor()

/** Start every *shown* instance with autoStart enabled (boot-time). */
export function startAllAutoStart(): void {
  for (const inst of getInstances()) {
    if (inst.enabled !== false && inst.autoStart) {
      void startInstance(inst.id).then((r) => {
        if (!r.ok) console.error('[launcher] auto-start failed for', inst.name, ':', r.error)
      })
    }
  }
}

type LifecycleKind = InstanceOperationEvent['kind']
type OperationReporter = (completed: number, total: number, message?: string) => void

let lifecycleTail: Promise<void> = Promise.resolve()
let lifecycleOperationSeq = 0

/**
 * Serialize stop/restart/adopt/detach operations. Each task gets a progress
 * reporter so the renderer can render "3/12" without blocking the main thread.
 */
function enqueueLifecycle<T>(
  kind: LifecycleKind,
  meta: { instanceId?: string; instanceName?: string; total?: number },
  task: (report: OperationReporter) => Promise<T>
): Promise<T> {
  const operationId = `op-${++lifecycleOperationSeq}`
  const total = Math.max(1, meta.total ?? 1)
  const instanceName = meta.instanceName ?? (meta.instanceId ? getInstance(meta.instanceId)?.name : undefined)
  const emit = (
    phase: InstanceOperationEvent['phase'],
    completed: number,
    error?: string,
    message?: string,
    reportedTotal = total
  ): void => {
    broadcast({
      type: 'instance-operation',
      operation: {
        operationId,
        kind,
        phase,
        instanceId: meta.instanceId,
        instanceName,
        completed,
        total: Math.max(1, reportedTotal),
        ...(message ? { message } : {}),
        ...(error ? { error } : {})
      }
    })
  }
  const run = lifecycleTail.then(async () => {
    emit('running', 0)
    const report: OperationReporter = (completed, reportedTotal, message) => {
      emit('running', completed, undefined, message, reportedTotal)
    }
    try {
      const value = await task(report)
      emit('done', Math.max(1, total))
      return value
    } catch (err) {
      emit('error', 0, err instanceof Error ? err.message : String(err))
      throw err
    } finally {
      await delay(GUI_OPERATION_GAP_MS)
    }
  })
  lifecycleTail = run.then(() => undefined, () => undefined)
  return run
}

/** Stop one runtime without re-entering the serial lifecycle queue. */
async function stopRuntime(rt: Runtime): Promise<void> {
  const inst = getInstance(rt.instanceId)
  if (inst && isDshInstance(inst)) rt.startCancelled = true
  if (inst?.kind !== 'gui' && !rt.child) {
    stopPortProbe(rt)
    clearStartTimer(rt)
    // Observing a listener does not make it an owned child process.
    const message = rt.state.status === 'external'
      ? t('外部进程不由启动器创建，已保留；请手动停止或更换端口。', 'External process was left running; stop it manually or use another port.')
      : null
    rt.stoppedAt = Date.now()
    patch(rt, { status: 'stopped', pid: null, ready: false, startedAt: null, lastError: message })
    return
  }
  const exe = (inst?.exe ?? '').trim()
  const baselinePids = new Set(sameExePids(exe))
  const epoch = rt.lifecycleEpoch
  stopPortProbe(rt)
  clearStartTimer(rt)

  // Adopted existing apps are detached, not killed: restore their normal
  // title bar/owner and leave the user's app running.
  if (rt.guiStopMode === 'detach') {
    rt.stopping = true
    rt.guiStopMode = null
    rt.guiPolicy = null
    try { guiView.detachGuiInstance(rt.instanceId) } catch { /* window may already be gone */ }
    rt.guiTargetPid = null
    rt.stopping = false
    rt.stoppedAt = Date.now()
    patch(rt, { status: 'stopped', pid: null, ready: false, startedAt: null, exitCode: null, guiAttached: false })
    return
  }

  // Chrome runs every window in one process. Stopping a Chrome GUI instance
  // must close only its selected HWND; taskkill would destroy unrelated tabs.
  if (rt.guiStopMode === 'window') {
    const proc = rt.child
    rt.stopping = true
    rt.guiStopMode = null
    rt.guiPolicy = null
    patch(rt, { status: 'stopping', pid: null, ready: false, guiAttached: false })
    pushLine(rt, 'stderr', t(
      '[launcher] 仅关闭选中的 Chrome 窗口，不终止浏览器进程树…',
      '[launcher] Closing only the selected Chrome window; the browser process tree is left running…'
    ))
    let closed = false
    try { closed = await guiView.closeGuiWindow(rt.instanceId) } catch { closed = false }
    if (proc) {
      proc.removeAllListeners('exit')
      rt.child = null
    }
    rt.guiTargetPid = null
    rt.guiPolicy = null
    rt.stopping = false
    rt.stoppedAt = Date.now()
    const warning = closed
      ? null
      : t(
        '选中的 Chrome 窗口未响应关闭请求；未终止浏览器进程，以免影响其他窗口。',
        'The selected Chrome window did not honor WM_CLOSE; the browser process was not killed so other windows stay intact.'
      )
    patch(rt, { status: 'stopped', pid: null, ready: false, startedAt: null, exitCode: null, lastError: warning, guiAttached: false })
    if (warning) pushLine(rt, 'stderr', `[launcher] ${warning}`)
    return
  }

  try { guiView.detachGuiInstance(rt.instanceId) } catch { /* window may already be gone */ }
  const proc = rt.child
  const pids = new Set<number>()
  if (proc?.pid) pids.add(proc.pid)
  if (rt.guiTargetPid) pids.add(rt.guiTargetPid)
  if (rt.state.status === 'external' && rt.state.pid) pids.add(rt.state.pid)

  if (pids.size > 0) {
    rt.stopping = true
    patch(rt, { status: 'stopping', pid: null, ready: false, guiAttached: false })
    pushLine(rt, 'stderr', t(
      `[launcher] 停止 GUI 进程树 (pid=${[...pids].join(',')})…`,
      `[launcher] Stopping GUI process tree (pid=${[...pids].join(',')})…`
    ))
    await killGuiProcessTrees([...pids])
    await waitForPidsGone([...pids], 1_500)
    if (proc) {
      proc.removeAllListeners('exit')
      rt.child = null
    }
    rt.guiTargetPid = null
    rt.guiStopMode = null
    rt.guiPolicy = null
    rt.stopping = false
    rt.stoppedAt = Date.now()
    patch(rt, { status: 'stopped', pid: null, ready: false, startedAt: null, exitCode: null, guiAttached: false })
    const { retries } = guiStopRescanSettings()
    if (inst?.kind === 'gui' && exe && retries > 0) {
      void sweepGuiRespawns(rt, exe, baselinePids, epoch, retries, false)
    }
    return
  }

  // No owned PID: leave any unrelated port listener untouched.
  rt.guiTargetPid = null
  rt.guiStopMode = null
  rt.guiPolicy = null
  rt.stopping = false
  rt.stoppedAt = Date.now()
  patch(rt, { status: 'stopped', pid: null, ready: false, guiAttached: false })
}

/**
 * Restart uses a graceful WM_CLOSE first, then a process-tree kill if the app
 * stays in the tray (or ignores the close), then one respawn sweep before start.
 */
async function stopRuntimeForRestart(rt: Runtime): Promise<void> {
  const inst = getInstance(rt.instanceId)
  if (inst?.kind !== 'gui') {
    await stopRuntime(rt)
    return
  }
  if (rt.guiStopMode === 'window') {
    await stopRuntime(rt)
    return
  }
  const exe = (inst?.exe ?? '').trim()
  const baselinePids = new Set(sameExePids(exe))
  const epoch = rt.lifecycleEpoch
  const pids = new Set<number>()
  if (rt.child?.pid) pids.add(rt.child.pid)
  if (rt.guiTargetPid) pids.add(rt.guiTargetPid)
  if (rt.state.pid) pids.add(rt.state.pid)

  stopPortProbe(rt)
  clearStartTimer(rt)
  rt.stopping = true

  if (inst?.kind === 'gui' && guiView.isGuiInstanceWindowAlive(inst.id)) {
    pushLine(rt, 'stderr', t(
      '[launcher] 重启前发送 WM_CLOSE 请求应用优雅退出…',
      '[launcher] Sending WM_CLOSE before restart so the app can exit gracefully…'
    ))
    try { await guiView.closeGuiWindow(inst.id) } catch { /* fall through to kill */ }
    await waitForPidsGone([...pids], 2_500)
  }

  const alive = [...pids].filter(pidExists)
  if (alive.length > 0) {
    pushLine(rt, 'stderr', t(
      `[launcher] 应用未退出，强制终止进程树 (pid=${alive.join(',')})…`,
      `[launcher] App did not exit; force-killing its process tree (pid=${alive.join(',')})…`
    ))
    await killGuiProcessTrees(alive)
    await waitForPidsGone(alive, 3_000)
  }

  const proc = rt.child
  if (proc) {
    proc.removeAllListeners('exit')
    rt.child = null
  }
  rt.guiTargetPid = null
  rt.guiStopMode = null
  rt.guiPolicy = null
  rt.stopping = false
  rt.stoppedAt = Date.now()
  patch(rt, { status: 'stopped', pid: null, ready: false, startedAt: null, exitCode: null, guiAttached: false })

  if (inst?.kind === 'gui' && exe && baselinePids.size > 0) {
    const { retries } = guiStopRescanSettings()
    if (retries > 0) await sweepGuiRespawns(rt, exe, baselinePids, epoch, 1, true)
  }
}

export function stopInstance(id: string): Promise<void> {
  return enqueueLifecycle('stop', { instanceId: id }, async () => {
    await stopRuntime(ensureRuntime(id))
  }).catch((err) => {
    const rt = ensureRuntime(id)
    pushLine(rt, 'stderr', `[launcher] ${err instanceof Error ? err.message : String(err)}`)
  })
}

export function restartInstance(id: string): Promise<{ ok: boolean; error?: string }> {
  return enqueueLifecycle('restart', { instanceId: id }, async () => {
    const inst = getInstance(id)
    if (!inst) return { ok: false, error: t('实例不存在。', 'Instance not found.') }
    const rt = ensureRuntime(id)
    if (rt.starting) return { ok: false, error: t(`实例「${inst.name}」正在启动中`, `Instance "${inst.name}" is starting`) }
    if (inst.kind !== 'gui' && !rt.child && rt.state.status === 'external') {
      return { ok: false, error: t('外部进程不能由启动器重启，请手动停止后再启动。', 'Stop the external process manually before restarting.') }
    }
    try {
      await stopRuntimeForRestart(rt)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    await delay(GUI_OPERATION_GAP_MS)
    return startInstance(id)
  })
}

/** Configured instances that currently have a live process or embedded window. */
function lifecycleStopTargets(): DshInstance[] {
  return getInstances().filter((inst) => {
    const rt = runtimes.get(inst.id)
    if (!rt) return false
    if (rt.child || rt.guiTargetPid || guiView.isGuiInstanceWindowAlive(inst.id)) return true
    return rt.state.status === 'starting' || rt.state.status === 'running' || rt.state.status === 'stopping' ||
      rt.state.status === 'degraded' || rt.state.status === 'external' || rt.state.status === 'error'
  })
}

/** Stop every instance through one serial batch; progress is broadcast per item. */
export function stopAllInstances(): Promise<{ ok: boolean; error?: string }> {
  const targets = lifecycleStopTargets()
  return enqueueLifecycle('stop-all', { instanceName: 'stop-all', total: Math.max(1, targets.length) }, async (report) => {
    report(0, Math.max(1, targets.length), targets.length ? '准备停止全部' : '没有正在运行的实例')
    const failures: string[] = []
    for (let i = 0; i < targets.length; i++) {
      const inst = targets[i]
      try {
        await stopRuntime(ensureRuntime(inst.id))
        report(i + 1, targets.length, inst.name)
      } catch (err) {
        failures.push(`${inst.name}: ${err instanceof Error ? err.message : String(err)}`)
        report(i + 1, targets.length, inst.name)
      }
      if (i < targets.length - 1) await delay(GUI_OPERATION_GAP_MS)
    }
    return failures.length ? { ok: false, error: failures.join('; ') } : { ok: true }
  }).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
}

/** Backward-compatible alias used by internal callers. */
export function stopAll(): Promise<void> {
  return stopAllInstances().then((result) => {
    if (!result.ok && result.error) throw new Error(result.error)
  })
}

/** Restore an embedded GUI window and leave its process running. */
export function detachInstanceKeepAlive(instanceId: string): Promise<{ ok: boolean; error?: string }> {
  return enqueueLifecycle('detach', { instanceId }, async () => {
    const inst = getInstance(instanceId)
    if (!inst || inst.kind !== 'gui') return { ok: false, error: t('不是桌面应用实例。', 'Not a desktop app instance.') }
    const rt = ensureRuntime(instanceId)
    if (!guiView.isGuiInstanceWindowAlive(instanceId)) {
      return { ok: false, error: t('当前没有已嵌入的窗口。', 'No embedded window is active.') }
    }
    try { guiView.detachGuiInstance(instanceId) } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    const pid = rt.guiTargetPid ?? rt.child?.pid ?? rt.state.pid ?? null
    rt.guiTargetPid = pid
    rt.guiStopMode = rt.guiStopMode ?? 'detach'
    patch(rt, pid
      ? { status: 'external', pid, ready: true, startedAt: null, guiAttached: false, lastError: null }
      : { status: 'stopped', pid: null, ready: false, startedAt: null, guiAttached: false })
    pushLine(rt, 'stderr', t(
      `[launcher] 已退出嵌入并保留进程 (pid=${pid ?? '?'})`,
      `[launcher] Exited embedding and kept the process running (pid=${pid ?? '?'})`
    ))
    return { ok: true }
  }).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
}

/** Attach a running GUI app's existing window without spawning a new process. */
export function adoptExistingGuiInstance(instanceId: string): Promise<{ ok: boolean; error?: string }> {
  return enqueueLifecycle('adopt', { instanceId }, async () => {
    const inst = getInstance(instanceId)
    if (!inst || inst.kind !== 'gui') return { ok: false, error: t('不是桌面应用实例。', 'Not a desktop app instance.') }
    const exe = (inst.exe ?? '').trim()
    if (!exe) return { ok: false, error: t('实例缺少桌面程序路径。', 'Instance has no desktop executable path.') }
    const rt = ensureRuntime(instanceId)
    if (rt.starting || rt.stopping) return { ok: false, error: t('实例正在启动或停止中。', 'Instance is starting or stopping.') }
    if (guiView.isGuiInstanceWindowAlive(instanceId)) {
      // The session may be hidden because another instance was active. Re-show
      // it through gui-view instead of only flipping the state flag.
      guiView.setGuiActive(instanceId, true)
      guiView.focusGuiInstance(instanceId)
      patch(rt, { guiAttached: true, status: rt.state.status === 'stopped' ? 'running' : rt.state.status })
      return { ok: true }
    }
    const windowPolicy = resolveGuiWindowPolicy({ exePath: exe, windowPolicy: inst.windowPolicy })
    const windowTitle = inst.windowTitle?.trim() || undefined
    const windowClass = inst.windowClass?.trim() || undefined
    let existing = guiView.findGuiWindowForProcess({ rootPid: 0, exePath: exe, windowTitle, windowClass }, windowPolicy)
    for (let attempt = 0; !existing && attempt < 2; attempt++) {
      await delay(400)
      existing = guiView.findGuiWindowForProcess({ rootPid: 0, exePath: exe, windowTitle, windowClass }, windowPolicy)
    }
    if (!existing) {
      return {
        ok: false,
        error: t(
          '未找到可接管的现有窗口。应用可能只在托盘且没有主窗口；请先打开应用主窗口。',
          'No adoptable window was found. The app may be tray-only; open its main window first.'
        )
      }
    }
    const foregroundBeforeSpawn = guiView.captureGuiForegroundWindow()
    rt.starting = true
    try {
      const result = await adoptExistingGuiWindow(inst, rt, existing, windowPolicy, foregroundBeforeSpawn)
      if (result.ok) guiView.focusGuiInstance(instanceId)
      return result
    } finally {
      rt.starting = false
    }
  }).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
}

/** Synchronous best-effort kill for app quit — the taskkill child is detached so it survives Electron exiting. */
export function stopAllSync(): void {
  stopMonitor()
  for (const rt of runtimes.values()) {
    rt.startCancelled = true
    rt.releaseProfileBoot?.()
    rt.releaseProfileBoot = null
  }
  // Adopted existing apps only detach; do not taskkill their processes on exit.
  for (const rt of runtimes.values()) {
    if (rt.guiStopMode !== 'detach') continue
    rt.guiTargetPid = null
    rt.guiStopMode = null
    rt.guiPolicy = null
    rt.stopping = true
  }
  // Window-only GUI instances (Chrome) must be closed by HWND, never taskkill.
  for (const rt of runtimes.values()) {
    if (rt.guiStopMode !== 'window') continue
    guiView.closeGuiWindowSync(rt.instanceId)
    if (rt.child) {
      rt.child.removeAllListeners('exit')
      rt.child = null
    }
    rt.guiTargetPid = null
    rt.guiStopMode = null
    rt.guiPolicy = null
    rt.stopping = true
  }
  guiView.detachAllGuiInstances()
  for (const rt of runtimes.values()) {
    const proc = rt.child
    if (!proc) {
      if (rt.guiTargetPid && process.platform === 'win32') {
        spawn('taskkill', ['/F', '/T', '/PID', String(rt.guiTargetPid)], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
      }
      rt.guiTargetPid = null
      continue
    }
    stopPortProbe(rt)
    if (process.platform === 'win32' && proc.pid) {
      if (rt.guiTargetPid && rt.guiTargetPid !== proc.pid) {
        spawn('taskkill', ['/F', '/T', '/PID', String(rt.guiTargetPid)], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
      }
      spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
    } else {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
    }
    rt.child = null
    rt.guiTargetPid = null
  }
}
