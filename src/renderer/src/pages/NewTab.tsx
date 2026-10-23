import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type { DshInstance, Group, HistoryEntry } from '../../../shared/types'
import {
  historyForGroup,
  setGroupItemVisible,
  visibleInstancesForGroup,
  visibleLinksForGroup
} from '../../../shared/groups'
import { fallbackColor, linkGlyphLetter, linkNameFromUrl, normalizeHttpUrl } from '../../../shared/favicon'
import { DEFAULT_PROFILE_ID } from '../../../shared/profiles'
import { useHarness } from '../hooks/useHarness'
import { useI18n } from '../i18n'
import { api } from '../lib/api'
import { GlyphTile } from '../components/Glyph'

type Mode = 'link' | 'instance'
type InstanceKind = 'dsh' | 'web' | 'ps'

function Section({ title, count, children, defaultOpen = true }: { title: string; count: number; children: ReactNode; defaultOpen?: boolean }): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="card overflow-hidden">
      <button type="button" className="flex w-full items-center gap-2 px-4 py-3 text-left" onClick={() => setOpen((value) => !value)}>
        <span className="text-[12px] transition-transform" style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', color: 'var(--muted)' }}>▾</span>
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="rounded-full px-1.5 py-0.5 text-[10px]" style={{ background: 'var(--bg-soft)', color: 'var(--muted)' }}>{count}</span>
      </button>
      {open && <div className="border-t px-2 py-2" style={{ borderColor: 'var(--border)' }}>{children}</div>}
    </section>
  )
}

function instanceLetter(instance: DshInstance): string {
  return instance.iconChar?.trim() || linkGlyphLetter(instance.name)
}

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

export function NewTab({ group, onOpenWebChat }: { group: Group; onOpenWebChat: (chat: { id: string; url: string }, popout: boolean) => void }): JSX.Element {
  const { t, statusLabel } = useI18n()
  const { config, instances, states, saveConfig, refresh, setActiveInstance } = useHarness()
  const groups = config?.groups ?? []
  const links = config?.webChats ?? []
  const home = groups.find((item) => item.kind === 'home') ?? group
  const isHome = group.kind === 'home'
  const commonInstances = useMemo(() => visibleInstancesForGroup(home, instances), [home, instances])
  const homeLinks = useMemo(() => visibleLinksForGroup(home, links), [home, links])
  const commonLinks = homeLinks.shared.filter((link) => !link.hidden)
  const privateLinks = links.filter((link) => !link.archived && !link.hidden && link.groupId === group.id)
  const history = historyForGroup(group, config ?? {})
  const profiles = config?.profiles ?? []
  const activeProfiles = profiles.filter((item) => !item.archived)

  const [mode, setMode] = useState<Mode>('link')
  const [instanceKind, setInstanceKind] = useState<InstanceKind>('dsh')
  const [url, setUrl] = useState('')
  const [customIcon, setCustomIcon] = useState('')
  const [name, setName] = useState('')
  const [profile, setProfile] = useState('web')
  const [selectedProfileId, setSelectedProfileId] = useState(DEFAULT_PROFILE_ID)

  const [port, setPort] = useState(0)
  const [command, setCommand] = useState('')
  const [healthPath, setHealthPath] = useState('/')
  const [workspace, setWorkspace] = useState('')
  const [iconColor, setIconColor] = useState('#4F7DFF')
  const [iconChar, setIconChar] = useState('P')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [expandedHistory, setExpandedHistory] = useState(false)
  const mainInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    mainInput.current?.focus()
  }, [])
  useEffect(() => {
    setSelectedProfileId(DEFAULT_PROFILE_ID)
  }, [group.id])
useEffect(() => {
    setError(null)
    setNotice(null)
    mainInput.current?.focus()
  }, [mode, instanceKind])

  const visibleInstanceIds = new Set(isHome ? commonInstances.map((instance) => instance.id) : group.visibleInstances)
  const visibleLinkIds = new Set(isHome ? commonLinks.map((link) => link.id) : group.visibleLinks)

  const toggleInstance = async (instanceId: string, checked: boolean): Promise<void> => {
    await saveConfig({ groups: setGroupItemVisible(groups, group.id, 'instance', instanceId, checked) })
  }
  const toggleLink = async (linkId: string, checked: boolean): Promise<void> => {
    await saveConfig({ groups: setGroupItemVisible(groups, group.id, 'link', linkId, checked) })
  }

  const createLink = async (): Promise<void> => {
    const normalized = normalizeHttpUrl(url)
    if (!normalized) {
      setError(t('newTab.invalidUrl'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const resolvedIcon = customIcon.trim() || await api.resolveLinkFavicon(normalized)
      const id = `web-${crypto.randomUUID()}`
      const link = {
        id,
        name: linkNameFromUrl(normalized),
        description: '',
        url: normalized,
        hidden: false,
        groupId: isHome ? undefined : group.id,
        profileId: selectedProfileId === DEFAULT_PROFILE_ID ? undefined : selectedProfileId,
        iconColor: fallbackColor(linkNameFromUrl(normalized)),
        iconLocked: Boolean(customIcon.trim()),
        ...(resolvedIcon ? { icon: resolvedIcon } : {})
      }
      const nextGroups = isHome ? groups : groups.map((item) => item.id === group.id
        ? { ...item, visibleLinks: [...new Set([...item.visibleLinks, id])] }
        : item)
      await saveConfig({ webChats: [...links, link], groups: nextGroups })
      setUrl('')
      setCustomIcon('')
      onOpenWebChat({ id, url: normalized }, false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const addInstance = async (): Promise<void> => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError(t('newTab.nameRequired'))
      return
    }
    if ((instanceKind === 'web' || instanceKind === 'ps') && !command.trim()) {
      setError(t('newTab.commandRequired'))
      return
    }
    if (instanceKind === 'web' && port <= 0) {
      setError(t('newTab.portRequired'))
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const input = instanceKind === 'dsh'
        ? { kind: 'dsh' as const, name: trimmedName, profile: profile.trim() || 'web', port, autoStart: false }
        : instanceKind === 'web'
          ? { kind: 'web' as const, name: trimmedName, command: command.trim(), port, healthPath: healthPath.trim() || '/', workspace: workspace.trim() || undefined, autoStart: false, iconColor, iconChar }
          : { kind: 'ps' as const, name: trimmedName, command: command.trim(), autoStart: false, iconColor, iconChar }
      const added = await api.addInstance(input)
      const createdId = added.activeInstanceId
      let nextGroups = added.groups
      if (!isHome) {
        nextGroups = nextGroups.map((item) => item.id === group.id
          ? { ...item, visibleInstances: [...new Set([...item.visibleInstances, createdId])] }
          : item)
        await saveConfig({ groups: nextGroups })
      }
      await refresh()
      setName('')
      setCommand('')
      setNotice(t('newTab.instanceCreated', { name: trimmedName }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    if (mode === 'link') await createLink()
    else await addInstance()
  }

  const openHistory = (entry: HistoryEntry): void => {
    const link = links.find((item) => item.id === entry.webChatId && !item.archived)
    if (link) onOpenWebChat({ id: link.id, url: link.url }, false)
  }

  const historyRows = expandedHistory ? history : history.slice(0, 5)
  const currentInputValue = mode === 'link' ? url : name
  const setCurrentInput = (value: string): void => {
    if (mode === 'link') setUrl(value)
    else setName(value)
  }

  return (
    <div className="p-5 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-[22px] font-semibold tracking-tight">{t('newTab.title')}</h2>
          <p className="mt-1 text-[12px]" style={{ color: 'var(--muted)' }}>{t('newTab.subtitle', { group: group.name })}</p>
        </div>
        <div className="rounded-full px-3 py-1 text-[11px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
          {group.kind === 'home' ? t('topbar.homeHint') : t('groups.homogeneousHint')}
        </div>
      </div>

      <div className="card p-3.5 space-y-2.5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex shrink-0 rounded-lg p-0.5" style={{ background: 'var(--bg-soft)' }}>
            <button className={`btn btn-sm ${mode === 'link' ? 'btn-primary' : 'btn-plain'}`} onClick={() => setMode('link')}>{t('newTab.modeLink')}</button>
            <button className={`btn btn-sm ${mode === 'instance' ? 'btn-primary' : 'btn-plain'}`} onClick={() => setMode('instance')}>{t('newTab.modeInstance')}</button>
          </div>
          <input
            ref={mainInput}
            className="input min-w-0 flex-1 !py-2.5 !text-[14px]"
            value={currentInputValue}
            placeholder={mode === 'link' ? t('newTab.urlPlaceholder') : t('newTab.instanceNamePlaceholder')}
            spellCheck={false}
            onChange={(event) => setCurrentInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void submit()
              }
            }}
          />
          <button className="btn btn-primary shrink-0 !px-5 !py-2.5" disabled={busy} onClick={() => void submit()}>
            {busy ? t('newTab.working') : mode === 'link' ? t('newTab.open') : t('newTab.createInstance')}
          </button>
        </div>
        {mode === 'link' && (<div className="flex flex-wrap items-center gap-2">
          <span className="text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>{t('newTab.profile')}</span>
          {activeProfiles.map((item) => {
            const selected = item.id === selectedProfileId
            const label = item.id === DEFAULT_PROFILE_ID ? t('newTab.profileNoIsolation') : item.name
            return (
              <button
                key={item.id}
                className="flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px]"
                style={{ borderColor: selected ? 'var(--accent-border)' : 'var(--border)', background: selected ? 'var(--accent-soft)' : 'transparent', color: selected ? 'var(--accent)' : 'var(--muted)' }}
                onClick={() => setSelectedProfileId(item.id)}
                title={item.id === DEFAULT_PROFILE_ID ? t('newTab.profileNoIsolationHint') : item.partition}
              >
                <GlyphTile letter={item.letter} color={item.color} size={16} rounded={999} />
                {label}
              </button>
            )
          })}
          <span className="text-[10.5px]" style={{ color: 'var(--muted)' }}>
            {t('newTab.profileIsolationHint')}
          </span>
        </div>)}
        {mode === 'link' && (
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[11px]" style={{ color: 'var(--muted)' }}>{t('newTab.customIcon')}</span>
            <input className="input !py-1.5 !text-[11.5px]" value={customIcon} onChange={(event) => setCustomIcon(event.target.value)} placeholder={t('newTab.customIconPlaceholder')} />
          </div>
        )}
        {error && <div className="rounded-lg px-3 py-2 text-[11.5px]" style={{ color: 'var(--err)', background: 'color-mix(in srgb, var(--err) 12%, transparent)' }}>{error}</div>}
        {notice && <div className="rounded-lg px-3 py-2 text-[11.5px]" style={{ color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 12%, transparent)' }}>{notice}</div>}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.6fr)]">
        <div className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-[14px] font-semibold">{t('newTab.history')}</h3>
            {history.length > 5 && (
              <button className="text-[11px]" style={{ color: 'var(--accent)' }} onClick={() => setExpandedHistory((value) => !value)}>
                {expandedHistory ? t('newTab.collapseHistory') : t('newTab.expandHistory', { count: history.length })}
              </button>
            )}
          </div>
          <div className="card overflow-hidden">
            {historyRows.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12px]" style={{ color: 'var(--muted)' }}>{t('newTab.noHistory')}</div>
            ) : historyRows.map((entry, index) => (
              <button
                key={`${entry.id}-${entry.openedAt}`}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-[var(--card-hover)]"
                style={{ borderTop: index ? '1px solid var(--border)' : undefined }}
                onClick={() => openHistory(entry)}
                title={entry.url}
              >
                <GlyphTile letter={entry.name} color={fallbackColor(entry.name)} size={26} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px]">{entry.name}</span>
                  <span className="block truncate text-[10.5px]" style={{ color: 'var(--muted)' }}>{hostOf(entry.url)}</span>
                </span>
                <span className="shrink-0 text-[10px]" style={{ color: 'var(--muted)' }}>{new Date(entry.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          {mode === 'instance' && (
            <div className="card p-4 space-y-3">
              <div className="flex flex-wrap gap-2">
                {(['dsh', 'web', 'ps'] as const).map((kind) => (
                  <button key={kind} className={`btn btn-sm ${instanceKind === kind ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setInstanceKind(kind)}>
                    {kind === 'dsh' ? t('newTab.kindDsh') : kind === 'web' ? t('newTab.kindWeb') : t('newTab.kindPs')}
                  </button>
                ))}
              </div>
              {instanceKind === 'dsh' ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div><label className="label">{t('newTab.profileBase')}</label><input className="input mono" value={profile} onChange={(event) => setProfile(event.target.value)} /></div>
                  <div><label className="label">{t('newTab.port')}</label><input className="input mono" type="number" min={0} value={port} onChange={(event) => setPort(Number(event.target.value) || 0)} /></div>
                </div>
              ) : instanceKind === 'web' ? (
                <>
                  <div><label className="label">{t('newTab.command')}</label><input className="input mono" value={command} onChange={(event) => setCommand(event.target.value)} placeholder={t('newTab.webCommandPlaceholder')} /></div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div><label className="label">{t('newTab.port')}</label><input className="input mono" type="number" min={1} value={port} onChange={(event) => setPort(Number(event.target.value) || 0)} /></div>
                    <div><label className="label">{t('newTab.healthPath')}</label><input className="input mono" value={healthPath} onChange={(event) => setHealthPath(event.target.value)} /></div>
                    <div><label className="label">{t('newTab.workspace')}</label><input className="input mono" value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder={t('newTab.workspacePlaceholder')} /></div>
                  </div>
                </>
              ) : (
                <>
                  <div><label className="label">{t('newTab.command')}</label><textarea className="input mono resize-y" rows={4} value={command} onChange={(event) => setCommand(event.target.value)} placeholder={t('newTab.psCommandPlaceholder')} /></div>
                  <div className="flex items-center gap-3">
                    <div><label className="label">{t('newTab.iconColor')}</label><input className="h-9 w-14 cursor-pointer rounded border-0 bg-transparent p-0" type="color" value={iconColor} onChange={(event) => setIconColor(event.target.value)} /></div>
                    <div><label className="label">{t('newTab.iconChar')}</label><input className="input w-16 text-center text-[16px]" value={iconChar} maxLength={4} onChange={(event) => setIconChar(Array.from(event.target.value)[0] ?? 'P')} /></div>
                    <div className="pt-5"><GlyphTile letter={name || 'P'} color={iconColor} icon={iconChar} size={34} /></div>
                  </div>
                  <p className="text-[10.5px]" style={{ color: 'var(--muted)' }}>{t('newTab.psHint')}</p>
                </>
              )}
            </div>
          )}

          <Section title={t('newTab.homeInstances')} count={commonInstances.length}>
            {commonInstances.length === 0 ? <div className="px-2 py-4 text-[11.5px]" style={{ color: 'var(--muted)' }}>{t('newTab.noInstances')}</div> : commonInstances.map((instance) => {
              const checked = visibleInstanceIds.has(instance.id)
              const status = states[instance.id]?.status ?? 'stopped'
              return (
                <div key={instance.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--card-hover)]">
                  <input type="checkbox" checked={checked} disabled={isHome} onChange={(event) => void toggleInstance(instance.id, event.target.checked)} />
                  <GlyphTile icon={instance.icon} letter={instanceLetter(instance)} color={instance.iconColor ?? fallbackColor(instance.name)} size={26} />
                  <button className="min-w-0 flex-1 truncate text-left text-[12.5px]" onClick={() => void setActiveInstance(instance.id)}>{instance.name}</button>
                  <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ color: status === 'running' ? 'var(--ok)' : 'var(--muted)', background: 'var(--bg-soft)' }}>{statusLabel(status)}</span>
                </div>
              )
            })}
          </Section>

          <Section title={t('newTab.homeLinks')} count={commonLinks.length}>
            {commonLinks.length === 0 ? <div className="px-2 py-4 text-[11.5px]" style={{ color: 'var(--muted)' }}>{t('newTab.noLinks')}</div> : commonLinks.map((link) => (
              <div key={link.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--card-hover)]">
                <input type="checkbox" checked={visibleLinkIds.has(link.id)} disabled={isHome} onChange={(event) => void toggleLink(link.id, event.target.checked)} />
                <GlyphTile icon={link.icon} letter={link.name} color={link.iconColor ?? fallbackColor(link.name)} size={26} />
                <button className="min-w-0 flex-1 truncate text-left text-[12.5px]" onClick={() => onOpenWebChat({ id: link.id, url: link.url }, false)}>{link.name}</button>
                <span className="shrink-0 text-[10.5px]" style={{ color: 'var(--muted)' }}>{hostOf(link.url)}</span>
              </div>
            ))}
          </Section>

          <Section title={t('newTab.privateLinks')} count={privateLinks.length}>
            {privateLinks.length === 0 ? <div className="px-2 py-4 text-[11.5px]" style={{ color: 'var(--muted)' }}>{isHome ? t('newTab.homePrivateHint') : t('newTab.noPrivate')}</div> : privateLinks.map((link) => (
              <button key={link.id} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--card-hover)]" onClick={() => onOpenWebChat({ id: link.id, url: link.url }, false)}>
                <GlyphTile icon={link.icon} letter={link.name} color={link.iconColor ?? fallbackColor(link.name)} size={26} />
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{link.name}</span>
                <span className="shrink-0 text-[10.5px]" style={{ color: 'var(--muted)' }}>{hostOf(link.url)}</span>
              </button>
            ))}
          </Section>
        </div>
      </div>
    </div>
  )
}