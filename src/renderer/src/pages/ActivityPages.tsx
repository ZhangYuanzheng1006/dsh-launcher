import { useCallback, useEffect, useState, type JSX } from 'react'
import type { Group, HistoryEntry } from '../../../shared/types'
import type { DownloadRecord } from '../../../shared/s6s7'
import { historyForGroup } from '../../../shared/groups'
import { fallbackColor } from '../../../shared/favicon'
import { formatBytes } from '../../../shared/s6s7-pure'
import { useHarness } from '../hooks/useHarness'
import { useI18n } from '../i18n'
import { api } from '../lib/api'
import { s6s7Text } from '../s6s7Text'
import { GlyphTile } from '../components/Glyph'
import { DownloadIcon, RefreshIcon } from '../lib/icons'

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

function timeLabel(value: number): string {
  return new Date(value).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function HistoryPage({ group, onOpenWebChat }: { group: Group; onOpenWebChat: (chat: { id: string; url: string }, popout: boolean) => void }): JSX.Element {
  const { lang } = useI18n()
  const { config } = useHarness()
  const text = (key: Parameters<typeof s6s7Text>[1]): string => s6s7Text(lang, key)
  const history = historyForGroup(group, config ?? {})
  const links = config?.webChats ?? []

  const open = (entry: HistoryEntry): void => {
    const link = links.find((item) => item.id === entry.webChatId && !item.archived)
    if (link) onOpenWebChat({ id: link.id, url: link.url }, false)
  }

  return (
    <div className="p-5 space-y-5">
      <div>
        <h2 className="text-[22px] font-semibold tracking-tight">{text('historyTitle')}</h2>
        <p className="mt-1 text-[12px]" style={{ color: 'var(--muted)' }}>{text('historySubtitle')}</p>
      </div>
      <div className="card overflow-hidden">
        {history.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px]" style={{ color: 'var(--muted)' }}>{text('noHistory')}</div>
        ) : history.map((entry, index) => {
          const link = links.find((item) => item.id === entry.webChatId && !item.archived)
          return (
            <div key={`${entry.id}-${entry.openedAt}`} className="flex items-center gap-3 px-3 py-2.5" style={{ borderTop: index ? '1px solid var(--border)' : undefined }}>
              <GlyphTile letter={entry.name} color={fallbackColor(entry.name)} size={28} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium">{entry.name}</div>
                <div className="truncate text-[10.5px]" style={{ color: 'var(--muted)' }}>{hostOf(entry.url)}</div>
              </div>
              <span className="shrink-0 text-[10px]" style={{ color: 'var(--muted)' }}>{timeLabel(entry.openedAt)}</span>
              <button className="btn btn-ghost btn-sm shrink-0" disabled={!link} onClick={() => open(entry)}>{text('openLink')}</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function DownloadsPage(): JSX.Element {
  const { lang } = useI18n()
  const text = (key: Parameters<typeof s6s7Text>[1]): string => s6s7Text(lang, key)
  const [records, setRecords] = useState<DownloadRecord[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try { setRecords(await api.listDownloads()) } catch { /* keep previous list */ } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 2000)
    return () => clearInterval(timer)
  }, [load])

  const clear = async (): Promise<void> => {
    if (!(await api.confirm(text('clearDownloadsConfirm')))) return
    await api.clearDownloads()
    setRecords([])
  }

  const statusText = (record: DownloadRecord): string => {
    switch (record.status) {
      case 'completed': return text('downloadCompleted')
      case 'cancelled': return text('downloadCancelled')
      case 'interrupted': return text('downloadInterrupted')
      default: return text('downloadProgressing')
    }
  }
  const statusColor = (record: DownloadRecord): string => {
    if (record.status === 'completed') return 'var(--ok)'
    if (record.status === 'progressing') return 'var(--accent)'
    return 'var(--warn)'
  }

  return (
    <div className="p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[22px] font-semibold tracking-tight">{text('downloadsTitle')}</h2>
          <p className="mt-1 text-[12px]" style={{ color: 'var(--muted)' }}>{text('downloadsSubtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-ghost btn-sm" onClick={() => void api.openDownloadsFolder()}><DownloadIcon /> {text('openFolder')}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => void clear()} disabled={records.length === 0}>{text('clearDownloads')}</button>
        </div>
      </div>
      <div className="card overflow-hidden">
        {records.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px]" style={{ color: 'var(--muted)' }}>{text('downloadsEmpty')}</div>
        ) : records.map((record, index) => (
          <div key={record.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5" style={{ borderTop: index ? '1px solid var(--border)' : undefined }}>
            <DownloadIcon />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-medium" title={record.filename}>{record.filename}</div>
              <div className="truncate text-[10.5px]" style={{ color: 'var(--muted)' }}>{record.url}</div>
            </div>
            <span className="mono shrink-0 text-[11px]" style={{ color: 'var(--muted)' }}>{formatBytes(record.totalBytes || record.receivedBytes)}</span>
            <span className="badge shrink-0" style={{ color: statusColor(record), background: `color-mix(in srgb, ${statusColor(record)} 14%, transparent)` }}>{statusText(record)}</span>
            <span className="shrink-0 text-[10px]" style={{ color: 'var(--muted)' }}>{timeLabel(record.endedAt ?? record.startedAt)}</span>
            <button className="btn btn-ghost btn-sm shrink-0" disabled={record.status === 'progressing'} onClick={() => void api.revealDownload(record.id)}>{text('reveal')}</button>
          </div>
        ))}
      </div>
      {loading && records.length === 0 && <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{lang === 'zh' ? '加载中…' : 'Loading…'}</div>}
    </div>
  )
}
