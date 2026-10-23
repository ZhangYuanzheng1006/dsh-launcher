import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { Group, WebChatConfig } from '../../../shared/types'
import {
  deleteGroupAndArchive,
  HOME_GROUP_COLOR,
  MAX_TOP_BAR_GROUPS,
  reorderGroups,
  restoreArchivedLink
} from '../../../shared/groups'
import { fallbackColor } from '../../../shared/favicon'
import { useHarness } from '../hooks/useHarness'
import { useI18n } from '../i18n'
import { api } from '../lib/api'
import { GroupBadge, GlyphTile } from '../components/Glyph'
import { Toggle } from '../components/Toggle'

const COLORS = [HOME_GROUP_COLOR, '#7C3AED', '#0891B2', '#16A34A', '#D97706', '#DC4C64', '#DB2777', '#64748B']

interface Draft {
  id?: string
  kind: 'home' | 'group'
  name: string
  char: string
  color: string
  showInTopBar: boolean
  visibleInstances: string[]
  visibleLinks: string[]
}

function draftFor(group?: Group): Draft {
  if (group) {
    return {
      id: group.id,
      kind: group.kind,
      name: group.name,
      char: Array.from(group.char)[0] ?? '组',
      color: group.color,
      showInTopBar: group.showInTopBar,
      visibleInstances: [...group.visibleInstances],
      visibleLinks: [...group.visibleLinks]
    }
  }
  return {
    kind: 'group',
    name: '',
    char: '',
    color: COLORS[1],
    showInTopBar: true,
    visibleInstances: [],
    visibleLinks: []
  }
}

export function GroupsPage({ createSignal, createRequested }: { createSignal: number; createRequested: boolean }): JSX.Element {
  const { t } = useI18n()
  const { config, instances, saveConfig } = useHarness()
  const groups = config?.groups ?? []
  const links = config?.webChats ?? []
  const home = groups.find((group) => group.kind === 'home')
  const enabledInstances = useMemo(() => instances.filter((instance) => instance.enabled !== false), [instances])
  const sharedLinks = useMemo(() => links.filter((link) => !link.archived && !link.groupId), [links])
  const archivedLinks = useMemo(() => links.filter((link) => link.archived), [links])
  const [draft, setDraft] = useState<Draft | null>(null)
  const lastSignal = useRef(0)

  const beginCreate = (): void => {
    const base = draftFor()
    setDraft({
      ...base,
      visibleInstances: home?.visibleInstances ?? enabledInstances.map((instance) => instance.id),
      visibleLinks: home?.visibleLinks ?? sharedLinks.map((link) => link.id)
    })
  }

  useEffect(() => {
    if (createRequested && createSignal > lastSignal.current) beginCreate()
    lastSignal.current = createSignal
  }, [createSignal, createRequested])

  const saveDraft = async (): Promise<void> => {
    if (!draft || !draft.name.trim()) return
    const id = draft.id ?? `group-${crypto.randomUUID()}`
    const next: Group = {
      id,
      name: draft.name.trim(),
      char: Array.from(draft.char.trim() || draft.name.trim())[0] ?? '组',
      color: /^#[0-9a-f]{6}$/i.test(draft.color) ? draft.color : COLORS[1],
      kind: draft.kind,
      showInTopBar: draft.showInTopBar,
      visibleInstances: [...new Set(draft.visibleInstances)],
      visibleLinks: [...new Set(draft.visibleLinks)]
    }
    const nextGroups = draft.id ? groups.map((group) => group.id === draft.id ? next : group) : [...groups, next]
    await saveConfig({ groups: nextGroups })
    setDraft(null)
  }

  const toggleTopBar = async (group: Group, value: boolean): Promise<void> => {
    await saveConfig({ groups: groups.map((item) => item.id === group.id ? { ...item, showInTopBar: value } : item) })
  }

  const moveGroup = async (group: Group, direction: -1 | 1): Promise<void> => {
    const siblings = groups.filter((item) => item.kind !== 'home')
    const index = siblings.findIndex((item) => item.id === group.id)
    const target = siblings[index + direction]
    if (!target) return
    await saveConfig({ groups: reorderGroups(groups, group.id, target.id) })
  }

  const removeGroup = async (group: Group): Promise<void> => {
    if (!(await api.confirm(t('groups.deleteConfirm', { name: group.name })))) return
    const result = deleteGroupAndArchive(groups, links, group.id)
    await saveConfig({
      groups: result.groups,
      webChats: result.links,
      activeGroupId: config?.activeGroupId === group.id ? result.fallbackGroupId : config?.activeGroupId
    })
    for (const id of result.archivedLinkIds) api.releaseWebChat(id)
  }

  const restore = async (link: WebChatConfig): Promise<void> => {
    const result = restoreArchivedLink(groups, links, link.id)
    await saveConfig({ groups: result.groups, webChats: result.links })
  }

  const toggleDraftInstance = (id: string, checked: boolean): void => {
    setDraft((current) => current && ({
      ...current,
      visibleInstances: checked
        ? [...new Set([...current.visibleInstances, id])]
        : current.visibleInstances.filter((item) => item !== id)
    }))
  }
  const toggleDraftLink = (id: string, checked: boolean): void => {
    setDraft((current) => current && ({
      ...current,
      visibleLinks: checked
        ? [...new Set([...current.visibleLinks, id])]
        : current.visibleLinks.filter((item) => item !== id)
    }))
  }

  return (
    <div className="p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-semibold">{t('groups.title')}</h2>
          <p className="mt-1 text-[12px]" style={{ color: 'var(--muted)' }}>{t('groups.subtitle', { max: MAX_TOP_BAR_GROUPS })}</p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={beginCreate}>＋ {t('groups.new')}</button>
      </div>

      <div className="card overflow-hidden">
        {groups.map((group, index) => {
          const siblings = groups.filter((item) => item.kind !== 'home')
          const siblingIndex = siblings.findIndex((item) => item.id === group.id)
          const privateCount = links.filter((link) => !link.archived && link.groupId === group.id).length
          return (
            <div key={group.id} className="flex flex-wrap items-center gap-3 px-4 py-3" style={{ borderTop: index ? '1px solid var(--border)' : undefined }}>
              <GroupBadge group={group} active={config?.activeGroupId === group.id} size={38} />
              <div className="min-w-[150px] flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{group.name}</span>
                  <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--muted)', background: 'var(--bg-soft)' }}>
                    {group.kind === 'home' ? t('groups.typeHome') : t('groups.typeGroup')}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                  {t('groups.counts', { instances: group.visibleInstances.length, links: group.visibleLinks.length, private: privateCount })}
                </div>
              </div>

              <label className={`flex items-center gap-2 text-[12px] ${group.kind === 'home' ? 'opacity-60' : 'cursor-pointer'}`}>
                <Toggle checked={group.showInTopBar} onChange={(value) => { if (group.kind !== 'home') void toggleTopBar(group, value) }} />
                {t('groups.showInTopBar')}
              </label>

              <div className="flex items-center gap-1">
                <button className="btn btn-ghost btn-sm !px-2" disabled={group.kind === 'home' || siblingIndex <= 0} title={t('groups.moveUp')} onClick={() => void moveGroup(group, -1)}>↑</button>
                <button className="btn btn-ghost btn-sm !px-2" disabled={group.kind === 'home' || siblingIndex < 0 || siblingIndex >= siblings.length - 1} title={t('groups.moveDown')} onClick={() => void moveGroup(group, 1)}>↓</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setDraft(draftFor(group))}>{t('groups.editVisibility')}</button>
                <button className="btn btn-danger btn-sm" disabled={group.kind === 'home'} onClick={() => void removeGroup(group)}>{t('groups.delete')}</button>
              </div>
            </div>
          )
        })}
      </div>

      <div>
        <h3 className="mb-2 text-[14px] font-semibold">{t('groups.archivedTitle')}</h3>
        <p className="mb-2 text-[11.5px]" style={{ color: 'var(--muted)' }}>{t('groups.archivedHint')}</p>
        {archivedLinks.length === 0 ? (
          <div className="card px-4 py-5 text-[12px]" style={{ color: 'var(--muted)' }}>{t('groups.noArchived')}</div>
        ) : (
          <div className="card overflow-hidden">
            {archivedLinks.map((link, index) => (
              <div key={link.id} className="flex items-center gap-3 px-4 py-2.5" style={{ borderTop: index ? '1px solid var(--border)' : undefined }}>
                <GlyphTile icon={link.icon} letter={link.name} color={link.iconColor ?? fallbackColor(link.name)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px]">{link.name}</div>
                  <div className="truncate text-[11px]" style={{ color: 'var(--muted)' }}>{link.url} · {t('groups.archivedFrom', { group: link.archivedFromGroupName ?? '—' })}</div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => void restore(link)}>{t('groups.restore')}</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {draft && (
        <div className="modal-backdrop fixed inset-0 z-[80] flex items-center justify-center p-6" onClick={() => setDraft(null)}>
          <div className="modal w-full max-w-[720px] max-h-[86vh] overflow-y-auto rounded-2xl border p-5 space-y-4" style={{ background: 'var(--card)', borderColor: 'var(--border-strong)' }} onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-[16px] font-semibold">{draft.id ? t('groups.editGroup') : t('groups.newGroup')}</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setDraft(null)}>{t('groups.cancel')}</button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="label">{t('groups.name')}</label>
                <input className="input" autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t('groups.namePlaceholder')} />
                <div className="mt-1 text-[10.5px]" style={{ color: Array.from(draft.name).length > 4 ? 'var(--warn)' : 'var(--muted)' }}>{t('groups.nameLengthHint')}</div>
              </div>
              <div>
                <label className="label">{t('groups.char')}</label>
                <input
                  className="input w-24 text-center text-[18px]"
                  value={draft.char}
                  maxLength={8}
                  onChange={(event) => setDraft({ ...draft, char: Array.from(event.target.value)[0] ?? '' })}
                  placeholder={Array.from(draft.name)[0] ?? '组'}
                />
              </div>
              <div>
                <label className="label">{t('groups.color')}</label>
                <div className="flex items-center gap-2">
                  <input className="h-9 w-12 cursor-pointer rounded border-0 bg-transparent p-0" type="color" value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} />
                  {COLORS.map((color) => (
                    <button key={color} className="h-6 w-6 rounded-md ring-offset-2" style={{ background: color, outline: draft.color.toLowerCase() === color.toLowerCase() ? `2px solid ${color}` : 'none', outlineOffset: 2 }} onClick={() => setDraft({ ...draft, color })} title={color} />
                  ))}
                </div>
              </div>
            </div>

            <label className="flex items-center gap-2 text-[12.5px] cursor-pointer">
              <Toggle checked={draft.showInTopBar} onChange={(value) => { if (draft.kind !== 'home') setDraft({ ...draft, showInTopBar: value }) }} />
              {t('groups.showInTopBar')}
            </label>


            <div className="border-t pt-3" style={{ borderColor: 'var(--border)' }}>
              <div className="mb-1 flex items-center justify-between">
                <label className="label !mb-0">{t('groups.visibilityTitle')}</label>
                <span className="text-[11px]" style={{ color: 'var(--muted)' }}>{t('groups.visibilityHint')}</span>
              </div>
              {draft.kind === 'home' ? (
                <p className="text-[11.5px]" style={{ color: 'var(--muted)' }}>{t('groups.homeAlwaysVisible')}</p>
              ) : null}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="rounded-xl border p-2" style={{ borderColor: 'var(--border)' }}>
                  <div className="mb-1 px-1 text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>{t('groups.instances')}</div>
                  <div className="max-h-[180px] overflow-y-auto">
                    {enabledInstances.length === 0 ? <div className="px-1 py-2 text-[11px]" style={{ color: 'var(--muted)' }}>{t('groups.noInstances')}</div> : enabledInstances.map((instance) => {
                      const fixed = draft.kind === 'home'
                      const checked = fixed || draft.visibleInstances.includes(instance.id)
                      return (
                        <label key={instance.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-[12px] hover:bg-[var(--card-hover)]">
                          <input type="checkbox" checked={checked} disabled={Boolean(fixed)} onChange={(event) => toggleDraftInstance(instance.id, event.target.checked)} />
                          <span className="truncate">{instance.name}</span>
                          {groups.find((group) => group.kind === 'home')?.visibleInstances.includes(instance.id) && <span className="ml-auto text-[10px]" style={{ color: 'var(--muted)' }}>首页</span>}
                        </label>
                      )
                    })}
                  </div>
                </div>
                <div className="rounded-xl border p-2" style={{ borderColor: 'var(--border)' }}>
                  <div className="mb-1 px-1 text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>{t('groups.commonLinks')}</div>
                  <div className="max-h-[180px] overflow-y-auto">
                    {sharedLinks.length === 0 ? <div className="px-1 py-2 text-[11px]" style={{ color: 'var(--muted)' }}>{t('groups.noLinks')}</div> : sharedLinks.map((link) => {
                      const fixed = draft.kind === 'home'
                      const checked = fixed || draft.visibleLinks.includes(link.id)
                      return (
                        <label key={link.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-[12px] hover:bg-[var(--card-hover)]">
                          <input type="checkbox" checked={checked} disabled={Boolean(fixed)} onChange={(event) => toggleDraftLink(link.id, event.target.checked)} />
                          <GlyphTile icon={link.icon} letter={link.name} color={link.iconColor ?? fallbackColor(link.name)} size={18} />
                          <span className="truncate">{link.name}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setDraft(null)}>{t('groups.cancel')}</button>
              <button className="btn btn-primary btn-sm" disabled={!draft.name.trim()} onClick={() => void saveDraft()}>{t('groups.save')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}