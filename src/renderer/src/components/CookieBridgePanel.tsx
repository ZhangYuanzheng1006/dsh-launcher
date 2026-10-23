import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { api } from '../lib/api'
import { useI18n } from '../i18n'
import { DEFAULT_COOKIE_BRIDGE_PARTITION, isValidBridgePartition, normalizeBridgePartition, type CookieBridgeAuth, type CookieBridgeState } from '../../../shared/bridge'
import { CopyButton } from './CopyButton'
import { Toggle } from './Toggle'

function formatTime(ts: number | null): string {
  if (!ts) return '-'
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return '-'
  }
}

function statusKey(status: CookieBridgeState['status']): string {
  switch (status) {
    case 'connected':
      return 'settings.bridgeStatusConnected'
    case 'listening':
      return 'settings.bridgeStatusListening'
    case 'starting':
      return 'settings.bridgeStatusStarting'
    case 'error':
      return 'settings.bridgeStatusError'
    default:
      return 'settings.bridgeStatusStopped'
  }
}

function statusColor(status: CookieBridgeState['status']): string {
  switch (status) {
    case 'connected':
      return 'var(--accent)'
    case 'listening':
      return 'var(--warn)'
    case 'starting':
      return 'var(--accent-2, var(--accent))'
    case 'error':
      return 'var(--danger, #e55353)'
    default:
      return 'var(--muted)'
  }
}

/** Settings panel for the loopback cookie bridge and extension onboarding. */
export function CookieBridgePanel(): JSX.Element {
  const { t } = useI18n()
  const [state, setState] = useState<CookieBridgeState | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [port, setPort] = useState('17321')
  const [partition, setPartition] = useState(DEFAULT_COOKIE_BRIDGE_PARTITION)
  const [auth, setAuth] = useState<CookieBridgeAuth>('none')
  const [busy, setBusy] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const dirty = useRef(false)

  const applyStateToDraft = (next: CookieBridgeState): void => {
    setEnabled(next.config.enabled)
    setPort(String(next.config.port))
    setPartition(next.config.partition)
    setAuth(next.config.auth)
    dirty.current = false
  }

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const next = await api.bridgeGetState()
        if (!alive) return
        setState(next)
        if (!dirty.current) applyStateToDraft(next)
      } catch {
        // The IPC handler is registered before the window loads; a transient
        // failure should not replace the panel with an error screen.
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 1500)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const apply = async (): Promise<void> => {
    const parsedPort = Number.parseInt(port, 10)
    if (!Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
      setDraftError(t('settings.bridgeInvalidPort'))
      return
    }
    const normalizedPartition = normalizeBridgePartition(partition)
    if (!isValidBridgePartition(normalizedPartition)) {
      setDraftError(t('settings.bridgeInvalidPartition'))
      return
    }

    setBusy(true)
    setDraftError(null)
    setNotice(null)
    try {
      const next = await api.bridgeSetConfig({
        enabled,
        port: parsedPort,
        partition: normalizedPartition,
        auth
      })
      setState(next)
      applyStateToDraft(next)
      setNotice(t('settings.bridgeApplied'))
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const regenerate = async (): Promise<void> => {
    if (!(await api.confirm(t('settings.bridgeResetConfirm')))) return
    setBusy(true)
    setDraftError(null)
    setNotice(null)
    try {
      const next = await api.bridgeRegenerateToken()
      setState(next)
      applyStateToDraft(next)
      setNotice(t('settings.bridgeTokenResetDone'))
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const current = state?.config
  const status = state?.status ?? 'stopped'
  const counters = state
    ? t('settings.bridgeCounters', {
        received: state.received,
        applied: state.applied,
        skipped: state.skipped,
        failed: state.failed
      })
    : ''

  return (
    <div className="panel p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="section-title">{t('settings.bridgeTitle')}</h3>
          <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            {t('settings.bridgeHint')}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 text-[12px]">
          <span
            className="inline-block rounded-full"
            style={{ width: 8, height: 8, background: statusColor(status) }}
          />
          <span>{t(statusKey(status))}</span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="label">{t('settings.bridgeEnabled')}</div>
          <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
            {t('settings.bridgeEnabledHint')}
          </div>
        </div>
        <Toggle
          checked={enabled}
          onChange={(value) => {
            dirty.current = true
            setEnabled(value)
          }}
        />
      </div>

      <div>
        <label className="label">{t('settings.bridgeAuthMode')}</label>
        <select
          className="input"
          value={auth}
          onChange={(event) => {
            dirty.current = true
            setAuth(event.target.value as CookieBridgeAuth)
          }}
        >
          <option value="none">{t('settings.bridgeAuthNone')}</option>
          <option value="token">{t('settings.bridgeAuthToken')}</option>
        </select>
        <p className="mt-1 text-[11px] leading-relaxed" style={{ color: 'var(--muted)' }}>
          {auth === 'none' ? t('settings.bridgeAuthNoneHint') : t('settings.bridgeAuthTokenHint')}
        </p>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label className="label">{t('settings.bridgePort')}</label>
          <input
            className="input mono"
            type="number"
            min={1024}
            max={65535}
            step={1}
            value={port}
            onChange={(event) => {
              dirty.current = true
              setPort(event.target.value)
            }}
          />
        </div>
        <div>
          <label className="label">{t('settings.bridgePartition')}</label>
          <input
            className="input mono"
            value={partition}
            readOnly
          />
          <p className="mt-1 text-[11px]" style={{ color: 'var(--muted)' }}>
            {t('settings.bridgePartitionHint')}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void apply()}>
          {t('settings.bridgeApply')}
        </button>
        <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
          {t('settings.bridgeRestartHint')}
        </span>
      </div>

      <div className="space-y-2 rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center justify-between gap-2">
          <label className="label !mb-0">{t('settings.bridgeTokenFixed')}</label>
          <span
            className="rounded px-1.5 py-0.5 text-[10.5px]"
            style={{ color: 'var(--muted)', background: 'var(--bg-soft)' }}
          >
            {auth === 'none' ? t('settings.bridgeAuthNone') : t('settings.bridgeAuthToken')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            className="input mono flex-1"
            type="password"
            readOnly
            value={state?.token ?? ''}
            aria-label={t('settings.bridgeTokenFixed')}
          />
          <CopyButton text={state?.token ?? ''} title={t('settings.bridgeCopyToken')} />
          <button type="button" className="btn btn-ghost btn-sm shrink-0" disabled={busy} onClick={() => void regenerate()}>
            {t('settings.bridgeResetToken')}
          </button>
        </div>
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--muted)' }}>
          {t('settings.bridgeTokenFixedHint')}
        </p>
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--muted)' }}>
          {t('settings.bridgeInstallSteps')}
        </p>
      </div>

      <div className="grid sm:grid-cols-2 gap-3 text-[11.5px]">
        <div style={{ color: 'var(--muted)' }}>
          <span className="label !mb-0 inline">{t('settings.bridgeEndpoint')}:</span>{' '}
          <span className="mono">ws://127.0.0.1:{current?.port ?? port}</span>
        </div>
        <div style={{ color: 'var(--muted)' }}>
          <span className="label !mb-0 inline">{t('settings.bridgeClient')}:</span>{' '}
          <span className="mono">
            {state?.origin
              ? `${state.clientName || 'Chrome extension'}${state.clientVersion ? ` v${state.clientVersion}` : ''}`
              : t('settings.bridgeNoClient')}
          </span>
        </div>
        <div style={{ color: 'var(--muted)' }}>
          <span className="label !mb-0 inline">{t('settings.bridgeLastOp')}:</span>{' '}
          <span className="mono">{formatTime(state?.lastOpAt ?? null)}</span>
        </div>
        <div style={{ color: 'var(--muted)' }}>
          <span className="label !mb-0 inline">{t('settings.bridgeSnapshot')}:</span>{' '}
          <span className="mono break-all" title={state?.snapshotDir ?? ''}>
            {state?.snapshotDir ?? '-'}
          </span>
        </div>
      </div>

      <p className="text-[11px]" style={{ color: 'var(--muted)' }}>{counters}</p>
      {state?.lastError && (
        <p className="text-[11px] break-all" style={{ color: 'var(--danger, #e55353)' }}>
          {state.lastError}
        </p>
      )}
      {draftError && <p className="text-[11px]" style={{ color: 'var(--danger, #e55353)' }}>{draftError}</p>}
      {notice && <p className="text-[11px]" style={{ color: 'var(--accent)' }}>{notice}</p>}
    </div>
  )
}