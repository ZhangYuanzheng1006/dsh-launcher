import { app, session as electronSession, shell, type Session } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DownloadRecord, DownloadStatus } from '../shared/s6s7'

const MAX_RECORDS = 200
const trackedSessions = new WeakSet<Session>()
let records: DownloadRecord[] | null = null
let persistTimer: NodeJS.Timeout | null = null
let initialized = false

function downloadsFile(): string {
  return join(app.getPath('userData'), 'downloads.json')
}

function loadRecords(): DownloadRecord[] {
  if (records) return records
  try {
    const raw = readFileSync(downloadsFile(), 'utf8')
    const parsed = JSON.parse(raw)
    records = Array.isArray(parsed) ? parsed.filter(isDownloadRecord) : []
  } catch {
    records = []
  }
  return records
}

function isDownloadRecord(value: unknown): value is DownloadRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<DownloadRecord>
  return typeof item.id === 'string' && typeof item.filename === 'string' && typeof item.url === 'string' && typeof item.startedAt === 'number'
}

function persist(immediate = false): void {
  const write = (): void => {
    persistTimer = null
    try {
      writeFileSync(downloadsFile(), JSON.stringify(loadRecords(), null, 2), 'utf8')
    } catch { /* userData must remain writable; a transient failure must not break downloads */ }
  }
  if (immediate) {
    if (persistTimer) clearTimeout(persistTimer)
    write()
    return
  }
  if (persistTimer) return
  persistTimer = setTimeout(write, 500)
  persistTimer.unref?.()
}

function finalStatus(state: 'completed' | 'cancelled' | 'interrupted'): DownloadStatus {
  return state
}

/** Pick a collision-free path in the user's Downloads folder. */
function uniqueDownloadPath(filename: string): string {
  const dir = app.getPath('downloads')
  let candidate = join(dir, filename || 'download')
  if (!existsSync(candidate)) return candidate
  const dot = candidate.lastIndexOf('.')
  const stem = dot > candidate.lastIndexOf('\\') ? candidate.slice(0, dot) : candidate
  const ext = dot > candidate.lastIndexOf('\\') ? candidate.slice(dot) : ''
  for (let index = 1; index < 10_000; index++) {
    candidate = `${stem} (${index})${ext}`
    if (!existsSync(candidate)) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

/** Record one Electron DownloadItem from will-download through done. */
function trackDownload(item: Electron.DownloadItem): void {
  let savePath = item.getSavePath()
  if (!savePath) {
    savePath = uniqueDownloadPath(item.getFilename())
    item.setSavePath(savePath)
  }
  const record: DownloadRecord = {
    id: randomUUID(),
    filename: item.getFilename(),
    url: item.getURL(),
    savePath,
    mimeType: item.getMimeType() || undefined,
    totalBytes: Math.max(0, item.getTotalBytes()),
    receivedBytes: Math.max(0, item.getReceivedBytes()),
    startedAt: Date.now(),
    status: 'progressing'
  }
  const all = loadRecords()
  all.unshift(record)
  if (all.length > MAX_RECORDS) all.length = MAX_RECORDS
  persist(true)
  item.on('updated', (_event, state) => {
    record.receivedBytes = Math.max(0, item.getReceivedBytes())
    record.totalBytes = Math.max(record.totalBytes, item.getTotalBytes())
    if (state === 'interrupted') record.status = 'interrupted'
    persist()
  })
  item.once('done', (_event, state) => {
    record.receivedBytes = Math.max(0, item.getReceivedBytes())
    record.totalBytes = Math.max(record.totalBytes, item.getTotalBytes())
    record.savePath = item.getSavePath() || record.savePath
    record.status = finalStatus(state)
    record.endedAt = Date.now()
    persist(true)
  })
}

/** Attach will-download tracking once per Electron session. */
export function attachDownloadTracking(ses: Session): void {
  if (trackedSessions.has(ses)) return
  trackedSessions.add(ses)
  ses.on('will-download', (_event, item) => trackDownload(item))
}

/** Install tracking for the default session and every webview session created later. */
export function initDownloads(): void {
  if (initialized) return
  initialized = true
  loadRecords()
  attachDownloadTracking(electronSession.defaultSession)
  app.on('web-contents-created', (_event, contents) => attachDownloadTracking(contents.session))
}

export function listDownloads(): DownloadRecord[] {
  return loadRecords().map((record) => ({ ...record }))
}

export function clearDownloads(): void {
  records = []
  persist(true)
}

/** Reveal the saved file, falling back to the user's Downloads folder. */
export async function revealDownload(id: string): Promise<void> {
  const record = loadRecords().find((item) => item.id === id)
  if (record?.savePath && existsSync(record.savePath)) {
    shell.showItemInFolder(record.savePath)
    return
  }
  await shell.openPath(app.getPath('downloads'))
}

export async function openDownloadsFolder(): Promise<void> {
  await shell.openPath(app.getPath('downloads'))
}
