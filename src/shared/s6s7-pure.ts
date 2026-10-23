/** Pure helpers shared by the S7 sampler, charts, and downloads UI. */

export interface CpuTotals {
  idle: number
  total: number
}

export interface NetCounters {
  rx: number
  tx: number
  at: number
}

/** CPU utilization from two cumulative os.cpus() totals. */
export function cpuUsagePercent(previous: CpuTotals, current: CpuTotals): number {
  const totalDelta = Math.max(0, current.total - previous.total)
  const idleDelta = Math.max(0, current.idle - previous.idle)
  if (totalDelta <= 0) return 0
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100))
}

/** Convert cumulative adapter byte counters into a per-second rate. */
export function networkRate(previous: NetCounters | null, current: NetCounters | null): { rxBytesPerSec: number; txBytesPerSec: number } {
  if (!previous || !current || current.at <= previous.at) return { rxBytesPerSec: 0, txBytesPerSec: 0 }
  const seconds = (current.at - previous.at) / 1000
  if (seconds <= 0) return { rxBytesPerSec: 0, txBytesPerSec: 0 }
  return {
    rxBytesPerSec: Math.max(0, Math.round((current.rx - previous.rx) / seconds)),
    txBytesPerSec: Math.max(0, Math.round((current.tx - previous.tx) / seconds))
  }
}

/** Append one value while keeping the newest `max` entries. */
export function appendBounded<T>(items: readonly T[], item: T, max: number): T[] {
  const limit = Math.max(1, Math.floor(max))
  return [...items, item].slice(-limit)
}

/** Compact binary byte size for download rows. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** Compact per-second network rate for the performance cards. */
export function formatByteRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return '0 B/s'
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`
}
