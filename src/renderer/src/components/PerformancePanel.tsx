import { useCallback, useEffect, useState, type JSX } from 'react'
import type { PerfSample, PerfSnapshot } from '../../../shared/s6s7'
import { useI18n } from '../i18n'
import { api } from '../lib/api'
import { s6s7Text } from '../s6s7Text'
import { formatByteRate } from '../../../shared/s6s7-pure'

function Sparkline({ values, color }: { values: number[]; color: string }): JSX.Element {
  const width = 180
  const height = 46
  const points = values.length > 0 ? values : [0]
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = Math.max(1, max - min)
  const step = points.length > 1 ? width / (points.length - 1) : width
  const path = points.map((value, index) => {
    const x = index * step
    const y = height - 3 - ((value - min) / span) * (height - 8)
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mt-2 block h-12 w-full" role="img" aria-label="60 second sparkline">
      <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
      <path d={`${path} L${width},${height} L0,${height} Z`} fill={color} opacity="0.08" />
    </svg>
  )
}

function MetricCard({ label, value, detail, values, color }: { label: string; value: string; detail?: string; values: number[]; color: string }): JSX.Element {
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border)', background: 'color-mix(in srgb, var(--panel) 82%, var(--bg-soft))' }}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--muted)' }}>{label}</span>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      </div>
      <div className="mono mt-1 truncate text-[20px] font-semibold" title={value}>{value}</div>
      {detail && <div className="truncate text-[10.5px]" style={{ color: 'var(--muted)' }}>{detail}</div>}
      <Sparkline values={values} color={color} />
    </div>
  )
}

/** Live CPU / memory / network panel, fed by the paused-aware main sampler. */
export function PerformancePanel(): JSX.Element {
  const { lang } = useI18n()
  const [snapshot, setSnapshot] = useState<PerfSnapshot | null>(null)
  const text = (key: Parameters<typeof s6s7Text>[1]): string => s6s7Text(lang, key)

  const load = useCallback(async (): Promise<void> => {
    try { setSnapshot(await api.getPerformanceSnapshot()) } catch { /* keep the last sample */ }
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    let active = false
    const start = (): void => {
      if (active) return
      active = true
      void api.setPerformanceActive(true)
      void load()
      timer = setInterval(() => void load(), 1000)
    }
    const stop = (): void => {
      if (!active) return
      active = false
      if (timer) clearInterval(timer)
      timer = null
      void api.setPerformanceActive(false)
    }
    const visibility = (): void => { if (document.visibilityState === 'visible') start(); else stop() }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', visibility)
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      stop()
    }
  }, [load])

  const samples: PerfSample[] = snapshot?.samples ?? []
  const latest = samples[samples.length - 1]
  const cpu = latest?.cpuPercent ?? 0
  const memory = latest?.appMemoryMB ?? 0
  const rx = latest?.rxBytesPerSec ?? 0
  const tx = latest?.txBytesPerSec ?? 0
  const systemMemory = latest?.systemMemoryPercent ?? 0
  const totalNetwork = samples.map((sample) => sample.rxBytesPerSec + sample.txBytesPerSec)

  return (
    <section className="panel p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="section-title">{text('perfTitle')}</h3>
        <span className="text-[10.5px]" style={{ color: 'var(--muted)' }}>{text('perfLast60')}</span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricCard label={text('perfCpu')} value={`${cpu.toFixed(0)}%`} values={samples.map((sample) => sample.cpuPercent)} color="var(--accent)" />
        <MetricCard label={text('perfMemory')} value={`${memory.toFixed(0)} MB`} detail={s6s7Text(lang, 'perfSystemMemory', { percent: systemMemory.toFixed(0) })} values={samples.map((sample) => sample.appMemoryMB)} color="var(--ok)" />
        <MetricCard label={text('perfNetwork')} value={formatByteRate(rx + tx)} detail={`${text('perfRx')} ${formatByteRate(rx)} · ${text('perfTx')} ${formatByteRate(tx)}`} values={totalNetwork} color="var(--warn)" />
      </div>
      {!latest && <p className="mt-3 text-[11px]" style={{ color: 'var(--muted)' }}>{lang === 'zh' ? '正在采样…' : 'Sampling…'}</p>}
    </section>
  )
}
