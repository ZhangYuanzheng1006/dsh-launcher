/** Shared S6/S7 download and system-performance types. */

export type DownloadStatus = 'progressing' | 'completed' | 'cancelled' | 'interrupted'

/** One persisted browser download record. */
export interface DownloadRecord {
  id: string
  filename: string
  url: string
  savePath?: string
  mimeType?: string
  totalBytes: number
  receivedBytes: number
  startedAt: number
  endedAt?: number
  status: DownloadStatus
}

/** One system-performance sample. */
export interface PerfSample {
  at: number
  /** Process-wide OS CPU usage over the last sampling interval. */
  cpuPercent: number
  /** Electron main + renderer + utility working-set sum. */
  appMemoryMB: number
  /** System memory in use. */
  systemMemoryPercent: number
  /** Adapter receive rate in bytes per second. */
  rxBytesPerSec: number
  /** Adapter send rate in bytes per second. */
  txBytesPerSec: number
}

export interface PerfSnapshot {
  active: boolean
  samples: PerfSample[]
  totalMemoryMB: number
  freeMemoryMB: number
}

/** Renderer-facing API additions for S6/S7. Kept separate from the legacy API type. */
export interface S6S7Api {
  listDownloads(): Promise<DownloadRecord[]>
  clearDownloads(): Promise<void>
  revealDownload(id: string): Promise<void>
  openDownloadsFolder(): Promise<void>
  setPerformanceActive(active: boolean): Promise<void>
  getPerformanceSnapshot(): Promise<PerfSnapshot>
}
