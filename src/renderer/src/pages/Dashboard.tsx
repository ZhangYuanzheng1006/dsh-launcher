import type { JSX } from 'react'
import { useI18n } from '../i18n'
import { PowerIcon } from '../lib/icons'
import { LogConsole } from '../components/LogConsole'
import { BalanceCard } from '../components/BalanceCard'
import { PerformancePanel } from '../components/PerformancePanel'
import { InstanceList } from '../components/InstanceList'

export function Dashboard(): JSX.Element {
  const { t } = useI18n()
  return (
    <div className="p-5 space-y-5">
      {/* Status list — every instance's state + controls on one page */}
      <InstanceList />

      {/* Balance bar + system performance: side-by-side on wide windows, stacked below xl. */}
      <div className="grid grid-cols-1 items-stretch gap-5 xl:grid-cols-[minmax(320px,0.9fr)_minmax(0,1.6fr)]">
        <BalanceCard />
        <PerformancePanel />
      </div>

      {/* Log console — one merged console for every instance */}
      <LogConsole />

      <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--muted)' }}>
        <PowerIcon />
        {t('dashboard.footer')}
      </div>
    </div>
  )
}
