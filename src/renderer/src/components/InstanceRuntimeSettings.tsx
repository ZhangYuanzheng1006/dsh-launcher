import { useEffect, useState, type JSX } from 'react'
import { api } from '../lib/api'
import { useHarness } from '../hooks/useHarness'
import { useI18n } from '../i18n'
import { normalizeRuntimeVersion } from '../../../shared/runtime-version'
import type { DshRuntimeCatalog, InstanceRuntimeInfo } from '../../../shared/types'
import { TaskConsole } from './TaskConsole'

export function runtimeVersionError(value: string | undefined): string | null {
  if (value === undefined) return null
  try {
    return normalizeRuntimeVersion(value) ? null : '请输入固定版本号 / Enter a fixed version'
  } catch (error) { return error instanceof Error ? error.message : String(error) }
}

export function FormError({ message }: { message: string | null }): JSX.Element | null {
  return message ? <div role="alert" className="rounded-lg border p-3 text-[12px] select-text break-words" style={{ color: 'var(--err)', borderColor: 'var(--err)' }}>{message}</div> : null
}

/** Undefined means inherit; an empty string keeps the fixed-version input open. */
export function InstanceRuntimeSettings({ value, onChange, instanceId, allowFixed = true, disabled = false }: {
  value: string | undefined
  onChange: (value: string | undefined) => void
  instanceId?: string
  allowFixed?: boolean
  disabled?: boolean
}): JSX.Element {
  const { lang } = useI18n()
  const { refresh, tasks, dshUpdate, instances } = useHarness()
  const en = lang === 'en'
  const [info, setInfo] = useState<InstanceRuntimeInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<DshRuntimeCatalog | null>(null)
  const [catalogError, setCatalogError] = useState(false)
  const currentVersion = instances.find(inst => inst.id === instanceId)?.runtimeVersion
  const task = instanceId ? tasks[`runtime:instance:${instanceId}`] : undefined
  const validation = runtimeVersionError(value)

  useEffect(() => {
    if (value === undefined) return
    let alive = true
    void api.listDshRuntimeVersions().then(result => { if (alive) { setCatalog(result); setCatalogError(false) } }).catch(() => { if (alive) setCatalogError(true) })
    return () => { alive = false }
  }, [value === undefined])

  useEffect(() => {
    if (!instanceId) return
    let alive = true
    void api.getInstanceRuntime(instanceId).then(next => { if (alive) { setInfo(next); setError(null) } }).catch(error => { if (alive) setError(String(error)) })
    return () => { alive = false }
  }, [instanceId, currentVersion])

  const install = async (): Promise<void> => {
    if (!instanceId || validation || value === undefined) return
    setBusy(true)
    setError(null)
    try {
      await api.updateInstance(instanceId, { runtimeVersion: normalizeRuntimeVersion(value) })
      await refresh()
      const result = await api.installInstanceRuntime(instanceId)
      if (!result.ok) throw new Error(result.error ?? (en ? 'Installation failed' : '安装失败，请查看下方日志'))
      setInfo(await api.getInstanceRuntime(instanceId))
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  return <section className="space-y-2 rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
    <label className="block space-y-1 text-[12px]">
      <span className="font-medium">{en ? 'DSH runtime version' : 'DSH 运行版本'}</span>
      <select className="input" aria-label={en ? 'DSH runtime mode' : 'DSH 运行版本模式'} value={value === undefined ? 'inherit' : 'fixed'} disabled={disabled || busy} onChange={event => {
        setError(null)
        onChange(event.target.value === 'inherit' ? undefined : (dshUpdate?.current ?? ''))
      }}>
        <option value="inherit">{en ? 'Use shared runtime' : '跟随全局运行环境'}</option>
        <option value="fixed" disabled={!allowFixed}>{en ? 'Pin an isolated version' : '固定版本（独立安装）'}</option>
      </select>
    </label>
    {value !== undefined && <label className="block space-y-1 text-[12px]">
      <span>{en ? 'Exact version' : '精确版本号'}</span>
      <input className="input mono" aria-label={en ? 'Exact DSH version' : 'DSH 精确版本号'} value={value} placeholder="0.2.1-rc.2" disabled={disabled || busy} onChange={event => onChange(event.target.value)} aria-invalid={!!validation} />
      {catalog && <select className="input mono" aria-label={en ? 'Published DSH versions' : 'DSH 已发布版本'} value={catalog.versions.includes(value) ? value : ''} disabled={disabled || busy} onChange={event => onChange(event.target.value)}>
        <option value="" disabled>{en ? 'Choose a published version…' : '从官方已发布版本中选择…'}</option>
        {catalog.versions.map(version => <option key={version} value={version}>{version}{Object.entries(catalog.tags).filter(([, tagged]) => tagged === version).map(([tag]) => ` · ${tag}`).join('')}</option>)}
      </select>}
      {catalogError && <span className="block text-[11px]" style={{ color: 'var(--muted)' }}>{en ? 'Version list unavailable. You can still enter an exact version manually.' : '暂时无法获取版本列表，仍可手动输入精确版本号。'}</span>}
    </label>}
    <p className="text-[11px] leading-relaxed" style={{ color: 'var(--muted)' }}>
      {!allowFixed
        ? (en ? 'This home is shared. Create an instance with an isolated data home to pin its version.' : '此实例共享数据目录。请新建独立数据实例后固定版本，避免依赖混用。')
        : value !== undefined
          ? (en ? 'Separate DSH installation and data home. Shared updates cannot replace this version. Node.js is shared.' : '独立安装 DSH 并使用独立数据目录；全局升级不会替换此版本。Node.js 运行环境仍共用。')
          : (en ? 'Keeps the current shared/source runtime behavior.' : '沿用设置页的运行环境，保持现有实例行为。')}
    </p>
    {disabled && <p className="text-[11px]" style={{ color: 'var(--warn)' }}>{en ? 'Stop this instance before changing versions.' : '请先停止此实例，再切换或安装运行版本。'}</p>}
    {info && <div className="space-y-1 text-[11px]" style={{ color: 'var(--muted)' }}>
      <div>{en ? 'Saved version: ' : '已保存版本：'}{info.mode === 'fixed' ? info.requestedVersion : (en ? 'shared' : '跟随全局')} · {info.installed ? (en ? 'Installed' : '已安装') : (en ? 'Not installed' : '未安装')} {info.installedVersion && `(${info.installedVersion})`}</div>
      <div className="mono break-all select-text">{info.installDir}</div>
    </div>}
    <FormError message={validation ?? error} />
    {instanceId && value !== undefined && <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || busy || !!validation} onClick={() => void install()}>
      {busy ? (en ? 'Installing…' : '安装中…') : (en ? 'Save version and install' : '保存版本并安装')}
    </button>}
    {task && <TaskConsole task={task} />}
    {!instanceId && value !== undefined && <p className="text-[11px]" style={{ color: 'var(--muted)' }}>{en ? 'After creating the instance, open its settings to install this version.' : '创建后打开实例设置，点击“保存版本并安装”完成部署。'}</p>}
  </section>
}
