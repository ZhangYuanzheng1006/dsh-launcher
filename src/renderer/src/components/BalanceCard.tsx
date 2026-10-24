import { useCallback, useEffect, useState, type JSX } from 'react'
import { api, type BalanceData } from '../lib/api'
import { useI18n } from '../i18n'
import { s6s7Text } from '../s6s7Text'
import { RefreshIcon, ChevronIcon } from '../lib/icons'
import { CopyButton } from './CopyButton'

/** Horizontal collapsible balance bar. Collapsed state keeps the dashboard compact. */
export function BalanceCard(): JSX.Element {
  const { lang, t } = useI18n()
  const [data, setData] = useState<BalanceData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const load = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true)
    const result = await api.getBalance()
    if (result.ok && result.data) {
      setData(result.data)
      setError(null)
    } else {
      setError(result.error ?? t('balance.fetchFailed'))
      setData(null)
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    void load(true)
    const timer = setInterval(() => void load(true), 5 * 60 * 1000)
    return () => clearInterval(timer)
  }, [load])

  const available = data?.is_available === true
  const availableColor = data ? (available ? 'var(--ok)' : 'var(--warn)') : 'var(--muted)'
  const summary = data ? `${t('balance.title')} ${data.total_balance} ${data.currency}` : `${t('balance.title')} · ${loading ? t('balance.loading') : '—'}`

  return (
    <section className="panel overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          title={expanded ? s6s7Text(lang, 'collapse') : s6s7Text(lang, 'expand')}
        >
          <ChevronIcon dir={expanded ? 'down' : 'right'} />
          <span className="truncate text-[13px] font-semibold">{summary}</span>
          {data && <span className="badge shrink-0" style={{ color: availableColor, background: `color-mix(in srgb, ${availableColor} 14%, transparent)` }}><span className="badge-dot" style={{ background: availableColor }} />{available ? t('balance.available') : t('balance.unavailable')}</span>}
        </button>
        <button className="btn btn-ghost btn-sm shrink-0" onClick={() => void load()} title={t('balance.refreshTitle')} disabled={loading}>
          <RefreshIcon /> {loading ? t('balance.refreshing') : t('balance.refresh')}
        </button>
      </div>
      {expanded && (
        <div className="border-t px-4 pb-4 pt-3" style={{ borderColor: 'var(--border)' }}>
          {error ? (
            <div className="flex items-start justify-between gap-2 text-[12.5px]" style={{ color: 'var(--warn)' }}>
              <p className="select-text break-all">{error}</p>
              <CopyButton text={error} />
            </div>
          ) : data ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>{t('balance.total')}</div>
                <div className="mono mt-0.5 text-[20px] font-semibold" style={{ color: 'var(--text)' }}>{data.total_balance} <span className="text-[12px] font-normal" style={{ color: 'var(--muted)' }}>{data.currency}</span></div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>{t('balance.granted')}</div>
                <div className="mono mt-0.5 text-[16px] font-semibold" style={{ color: 'var(--text)' }}>{data.granted_balance}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>{t('balance.toppedUp')}</div>
                <div className="mono mt-0.5 text-[16px] font-semibold" style={{ color: 'var(--text)' }}>{data.topped_up_balance}</div>
              </div>
            </div>
          ) : (
            <p className="text-[12.5px]" style={{ color: 'var(--muted)' }}>{loading ? t('balance.loading') : '—'}</p>
          )}
        </div>
      )}
    </section>
  )
}
