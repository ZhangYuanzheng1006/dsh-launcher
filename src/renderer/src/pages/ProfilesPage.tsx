import { useEffect, useState, type JSX } from 'react'
import type { Profile } from '../lib/api'
import { DEFAULT_PROFILE_ID, DEFAULT_SESSION_PARTITION, removeProfileReferences } from '../../../shared/profiles'
import { useHarness } from '../hooks/useHarness'
import { useI18n } from '../i18n'
import { api } from '../lib/api'
import { GlyphTile } from '../components/Glyph'

const COLORS = ['#4F7DFF', '#7C3AED', '#0891B2', '#16A34A', '#D97706', '#DC4C64', '#DB2777', '#64748B']

interface Draft {
  id?: string
  isNew?: boolean
  name: string
  letter: string
  color: string
  source: Profile['source']
  partition: string
  archived?: boolean
}

function draftFrom(profile?: Profile): Draft {
  if (profile) {
    return {
      id: profile.id,
      name: profile.name,
      letter: profile.letter,
      color: profile.color,
      source: profile.source,
      partition: profile.partition,
      archived: profile.archived
    }
  }
  const id = `profile-${crypto.randomUUID()}`
  return { id, isNew: true, name: '', letter: '', color: COLORS[1], source: 'launcher', partition: 'persist:' + id }
}

function ProfileModal({ draft, onClose, onSave }: { draft: Draft; onClose: () => void; onSave: (draft: Draft) => void }): JSX.Element {
  const { t } = useI18n()
  const [next, setNext] = useState(draft)
  const editing = Boolean(draft.id) && !draft.isNew
  return (
    <div className="modal-backdrop fixed inset-0 z-[80] flex items-center justify-center p-6" onClick={onClose}>
      <div className="modal w-full max-w-[460px] rounded-2xl border p-5 space-y-4" style={{ background: 'var(--card)', borderColor: 'var(--border-strong)' }} onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-[16px] font-semibold">{editing ? t('profiles.edit') : t('profiles.create')}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>{t('profiles.cancel')}</button>
        </div>
        <label className="block space-y-1 text-[12.5px]">
          <span>{t('profiles.name')}</span>
          <input className="input" autoFocus value={next.name} onChange={(event) => setNext({ ...next, name: event.target.value })} placeholder={t('profiles.namePlaceholder')} />
        </label>
        <div className="grid grid-cols-[64px_1fr] gap-3">
          <label className="block space-y-1 text-[12.5px]">
            <span>{t('profiles.letter')}</span>
            <input className="input text-center text-[18px]" value={next.letter} maxLength={4} onChange={(event) => setNext({ ...next, letter: Array.from(event.target.value)[0] ?? '' })} />
          </label>
          <div className="space-y-1 text-[12.5px]">
            <span>{t('profiles.color')}</span>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {COLORS.map((color) => (
                <button key={color} className="h-7 w-7 rounded-full" style={{ background: color, outline: next.color === color ? '2px solid var(--text)' : 'none', outlineOffset: 2 }} onClick={() => setNext({ ...next, color })} title={color} />
              ))}
              <input className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent p-0" type="color" value={next.color} onChange={(event) => setNext({ ...next, color: event.target.value })} />
            </div>
          </div>
        </div>
        <div className="rounded-lg px-3 py-2 text-[11px]" style={{ background: 'var(--bg-soft)', color: 'var(--muted)' }}>
          {t('profiles.partition')}: <span className="mono">{next.partition}</span>
        </div>
        <div className="flex justify-end gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>{t('profiles.cancel')}</button>
          <button className="btn btn-primary btn-sm" disabled={!next.name.trim()} onClick={() => onSave({ ...next, letter: Array.from(next.letter.trim() || next.name.trim())[0] ?? '资' })}>{t('profiles.save')}</button>
        </div>
      </div>
    </div>
  )
}

export function ProfilesPage(): JSX.Element {
  const { t } = useI18n()
  const { config, instances, saveConfig } = useHarness()
  const profiles = config?.profiles ?? []
  const links = config?.webChats ?? []
  const [draft, setDraft] = useState<Draft | null>(null)
  const [importNotice, setImportNotice] = useState<'chrome' | 'edge' | null>(null)
  const [scanBusy, setScanBusy] = useState(false)
  const [scanNotice, setScanNotice] = useState<string | null>(null)
  const active = profiles.filter((profile) => !profile.archived)
  const archived = profiles.filter((profile) => profile.archived)


  const scanChrome = async (): Promise<void> => {
    setScanBusy(true)
    setScanNotice(null)
    try {
      const scanned = await api.scanChromeProfiles()
      const defaultProfile = profiles.find((profile) => profile.id === DEFAULT_PROFILE_ID)
      const manual = profiles.filter((profile) => profile.id !== DEFAULT_PROFILE_ID && profile.source !== 'chrome')
      await saveConfig({
        profiles: [
          ...(defaultProfile ? [defaultProfile] : []),
          ...scanned,
          ...manual
        ]
      })
      setScanNotice(t('profiles.scanDone', { count: scanned.length }))
    } catch (error) {
      setScanNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setScanBusy(false)
    }
  }

  useEffect(() => {
    void scanChrome()
  }, [])

  const saveProfile = async (nextDraft: Draft): Promise<void> => {
    const id = nextDraft.id ?? `profile-${crypto.randomUUID()}`
    const next: Profile = {
      id,
      name: nextDraft.name.trim(),
      letter: Array.from(nextDraft.letter.trim() || nextDraft.name.trim())[0] ?? '资',
      color: /^#[0-9a-f]{6}$/i.test(nextDraft.color) ? nextDraft.color : COLORS[0],
      partition: id === DEFAULT_PROFILE_ID ? DEFAULT_SESSION_PARTITION : nextDraft.partition || `persist:${id}`,
      source: nextDraft.source,
      ...(nextDraft.archived ? { archived: true } : {})
    }
    const editing = Boolean(nextDraft.id) && !nextDraft.isNew
    await saveConfig({ profiles: editing ? profiles.map((profile) => profile.id === id ? { ...profile, ...next } : profile) : [...profiles, next] })
    setDraft(null)
  }

  const removeProfile = async (profile: Profile): Promise<void> => {
    if (profile.id === DEFAULT_PROFILE_ID) return
    if (!(await api.confirm(t('profiles.deleteConfirm', { name: profile.name })))) return
    const next = removeProfileReferences(profiles, links, instances, profile.id)
    await saveConfig({
      profiles: next.profiles,
      webChats: next.links,
      instances: next.instances
    })
  }

  const restoreProfile = async (profile: Profile): Promise<void> => {
    await saveConfig({ profiles: profiles.map((item) => item.id === profile.id ? { ...item, archived: false } : item) })
  }

  const row = (profile: Profile): JSX.Element => {
    const usage = profile.id === DEFAULT_PROFILE_ID
      ? links.filter((link) => !link.profileId || link.profileId === DEFAULT_PROFILE_ID).length
      : links.filter((link) => link.profileId === profile.id).length
    return (
    <div key={profile.id} className="flex flex-wrap items-center gap-3 px-4 py-3" style={{ borderTop: '1px solid var(--border)' }}>
      <GlyphTile letter={profile.letter} color={profile.color} size={34} rounded={999} />
      <div className="min-w-[180px] flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{profile.name}</span>
          <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--muted)', background: 'var(--bg-soft)' }}>
            {profile.source === 'chrome' ? 'Chrome' : profile.source === 'edge' ? 'Edge' : t('profiles.sourceLauncher')}
          </span>
          {profile.id === DEFAULT_PROFILE_ID && <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--accent)', background: 'var(--accent-soft)' }}>{t('profiles.defaultBadge')}</span>}
          {profile.archived && <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 12%, transparent)' }}>{t('profiles.archivedBadge')}</span>}
        </div>
        <div className="mt-1 truncate text-[10.5px] mono" style={{ color: 'var(--muted)' }}>{profile.partition}</div>
        <div className="mt-0.5 text-[10.5px]" style={{ color: 'var(--muted)' }}>{t('profiles.linkUsage', { count: usage })}</div>
      </div>
      <div className="flex items-center gap-2">
        {profile.archived && <button className="btn btn-ghost btn-sm" onClick={() => void restoreProfile(profile)}>{t('profiles.restore')}</button>}
        {profile.source !== 'chrome' && <button className="btn btn-ghost btn-sm" onClick={() => setDraft(draftFrom(profile))}>{t('profiles.rename')}</button>}
        {profile.source !== 'chrome' && <button className="btn btn-danger btn-sm" disabled={profile.id === DEFAULT_PROFILE_ID} onClick={() => void removeProfile(profile)}>{t('profiles.delete')}</button>}
      </div>
    </div>
    )
  }

  return (
    <div className="p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-semibold">{t('profiles.title')}</h2>
          <p className="mt-1 max-w-[720px] text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>{t('profiles.subtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ghost btn-sm" disabled={scanBusy} onClick={() => void scanChrome()}>{scanBusy ? t('profiles.scanningChrome') : t('profiles.scanChrome')}</button>
          <button className="btn btn-primary btn-sm" onClick={() => setDraft(draftFrom())}>＋ {t('profiles.create')}</button>
        </div>
      </div>
      {scanNotice && <div className="rounded-lg px-3 py-2 text-[11.5px]" style={{ color: 'var(--muted)', background: 'var(--bg-soft)' }}>{scanNotice}</div>}

      <div className="card overflow-hidden">
        <div className="px-4 py-3 text-[13px] font-semibold">{t('profiles.activeTitle')}</div>
        {active.map(row)}
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <div className="text-[13px] font-semibold">{t('profiles.archivedTitle')}</div>
            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--muted)' }}>{t('profiles.archivedHint')}</div>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-ghost btn-sm" onClick={() => setImportNotice('chrome')}>{t('profiles.importChrome')}</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setImportNotice('edge')}>{t('profiles.importEdge')}</button>
          </div>
        </div>
        {archived.length === 0 ? <div className="px-4 pb-4 text-[11.5px]" style={{ color: 'var(--muted)' }}>{t('profiles.noArchived')}</div> : archived.map(row)}
        <div className="border-t px-4 py-3 text-[11px] leading-relaxed" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>{t('profiles.importHint')}</div>
      </div>

      {draft && <ProfileModal draft={draft} onClose={() => setDraft(null)} onSave={(next) => void saveProfile(next)} />}

      {importNotice && (
        <div className="modal-backdrop fixed inset-0 z-[90] flex items-center justify-center p-6" onClick={() => setImportNotice(null)}>
          <div className="modal w-full max-w-[500px] rounded-2xl border p-5 space-y-3" style={{ background: 'var(--card)', borderColor: 'var(--border-strong)' }} onClick={(event) => event.stopPropagation()}>
            <h3 className="text-[16px] font-semibold">{t('profiles.importTitle', { browser: importNotice === 'chrome' ? 'Chrome' : 'Edge' })}</h3>
            <p className="text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>{t('profiles.importUnavailable')}</p>
            <div className="rounded-lg border px-3 py-2 text-[11.5px] leading-relaxed" style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}>
              {t('profiles.importBridgeHint')}
            </div>
            <div className="flex justify-end"><button className="btn btn-primary btn-sm" onClick={() => setImportNotice(null)}>{t('profiles.gotIt')}</button></div>
          </div>
        </div>
      )}
    </div>
  )
}