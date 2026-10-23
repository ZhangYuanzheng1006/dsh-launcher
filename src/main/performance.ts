import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { cpus, freemem, totalmem } from 'node:os'
import type { PerfSample, PerfSnapshot } from '../shared/s6s7'
import { appendBounded, cpuUsagePercent, networkRate, type CpuTotals, type NetCounters } from '../shared/s6s7-pure'

const SAMPLE_MS = 1_000
const MAX_SAMPLES = 60
const NET_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $m = Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes,SentBytes -Sum
  if ($m -and $m.Sum -and $m.Sum.Count -ge 2) {
    @{ rx = [double]$m.Sum[0]; tx = [double]$m.Sum[1]; at = [double][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress
  }
  Start-Sleep -Milliseconds 1000
}`

let active = false
let timer: NodeJS.Timeout | null = null
let sampling = false
let cpuPrevious = readCpuTotals()
let samples: PerfSample[] = []
let networkChild: ChildProcess | null = null
let networkBuffer = ''
let latestNetwork: NetCounters | null = null
let previousNetwork: NetCounters | null = null

function readCpuTotals(): CpuTotals {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    const times = cpu.times
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total }
}

function stopNetworkWatcher(): void {
  if (networkChild) {
    networkChild.removeAllListeners()
    try { networkChild.kill() } catch { /* already gone */ }
    networkChild = null
  }
  networkBuffer = ''
  latestNetwork = null
  previousNetwork = null
}

function startNetworkWatcher(): void {
  if (process.platform !== 'win32' || networkChild) return
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', NET_SCRIPT], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    networkChild = child
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      networkBuffer += chunk
      const lines = networkBuffer.split(/\r?\n/)
      networkBuffer = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as { rx?: unknown; tx?: unknown; at?: unknown }
          if (typeof parsed.rx === 'number' && typeof parsed.tx === 'number' && typeof parsed.at === 'number') {
            latestNetwork = { rx: parsed.rx, tx: parsed.tx, at: parsed.at }
          }
        } catch { /* PowerShell startup may emit a non-JSON line */ }
      }
    })
    child.on('error', () => { networkChild = null })
    child.on('exit', () => { networkChild = null })
  } catch {
    networkChild = null
  }
}

async function tick(): Promise<void> {
  if (!active || sampling) return
  sampling = true
  try {
    const now = Date.now()
    const cpuNow = readCpuTotals()
    const cpuPercent = cpuUsagePercent(cpuPrevious, cpuNow)
    cpuPrevious = cpuNow

    const metrics = app.getAppMetrics()
    const appMemoryMB = metrics.reduce((sum, metric) => sum + (metric.memory?.workingSetSize ?? 0), 0) / 1024
    const totalMemoryMB = totalmem() / (1024 * 1024)
    const freeMemoryMB = freemem() / (1024 * 1024)
    const systemMemoryPercent = totalMemoryMB > 0 ? Math.max(0, Math.min(100, (1 - freeMemoryMB / totalMemoryMB) * 100)) : 0

    const rates = networkRate(previousNetwork, latestNetwork)
    if (latestNetwork) previousNetwork = latestNetwork

    samples = appendBounded(samples, {
      at: now,
      cpuPercent,
      appMemoryMB,
      systemMemoryPercent,
      rxBytesPerSec: rates.rxBytesPerSec,
      txBytesPerSec: rates.txBytesPerSec
    }, MAX_SAMPLES)
  } finally {
    sampling = false
  }
}

/** Start or pause the 1 Hz sampler. Paused windows do no background work. */
export function setPerformanceActive(next: boolean): void {
  if (active === next) return
  active = next
  if (next) {
    cpuPrevious = readCpuTotals()
    previousNetwork = latestNetwork
    startNetworkWatcher()
    void tick()
    timer = setInterval(() => void tick(), SAMPLE_MS)
    timer.unref?.()
  } else {
    if (timer) clearInterval(timer)
    timer = null
    stopNetworkWatcher()
  }
}

export function getPerformanceSnapshot(): PerfSnapshot {
  return {
    active,
    samples: samples.map((sample) => ({ ...sample })),
    totalMemoryMB: totalmem() / (1024 * 1024),
    freeMemoryMB: freemem() / (1024 * 1024)
  }
}

/** Stop the sampler and release the PowerShell counter child. */
export function shutdownPerformance(): void {
  setPerformanceActive(false)
}
