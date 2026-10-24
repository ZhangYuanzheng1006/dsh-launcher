import { useEffect, useState, type JSX } from 'react'
import type { Group, Profile } from '../../../shared/types'
import { DEFAULT_PROFILE_ID } from '../../../shared/profiles'
import { projectTopBarGroups, resolveCurrentGroup } from '../../../shared/groups'
import { chipWidth } from '../../../shared/chip'
import { useI18n } from '../i18n'
import { GroupBadge, GlyphTile } from './Glyph'

interface TopBarProps {
  groups: Group[]
  activeGroupId?: string
  profiles: Profile[]
  currentProfile: Profile
  profileSelectionEnabled: boolean
  onSelectGroup: (groupId: string) => void
  onSelectProfile: (profileId: string) => void
  onOpenGroups: (create?: boolean) => void
  onOpenProfiles: () => void
}

/** Persistent workspace strip. At most eight groups are pinned; the rest live in the + menu. */
export function TopBar({
  groups,
  activeGroupId,
  profiles,
  currentProfile,
  profileSelectionEnabled,
  onSelectGroup,
  onSelectProfile,
  onOpenGroups,
  onOpenProfiles
}: TopBarProps): JSX.Element {
  const { t } = useI18n()
  const [menuOpen, setMenuOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const { pinned, overflow } = projectTopBarGroups(groups)
  const current = resolveCurrentGroup(groups, activeGroupId)
  const visibleProfiles = profiles.filter((profile) => !profile.archived)
  const displayName = (profile: Profile): string => profile.id === DEFAULT_PROFILE_ID ? t('topbar.noIsolation') : profile.name

  useEffect(() => {
    if (!menuOpen && !profileOpen) return
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        setProfileOpen(false)
      }
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [menuOpen, profileOpen])

  const chooseGroup = (id: string): void => {
    setMenuOpen(false)
    onSelectGroup(id)
  }

  return (
    <header className="topbar h-[58px] flex items-center gap-2 px-4 border-b shrink-0 relative z-30" style={{ borderColor: 'var(--border)' }}>
      <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto whitespace-nowrap">
        {pinned.map((group) => {
          const active = group.id === current.id
          const chip = chipWidth(Array.from(group.name || '组').length, 34) + 8
          return (
            <button
              key={group.id}
              type="button"
              className="relative flex h-[42px] shrink-0 items-center justify-center rounded-[11px] transition-colors cursor-pointer"
              style={{ width: chip, background: active ? 'var(--accent-soft)' : 'transparent' }}
              title={group.name}
              aria-label={group.name}
              aria-pressed={active}
              onClick={() => onSelectGroup(group.id)}
            >
              <GroupBadge group={group} active={active} adaptive />
            </button>
          )
        })}
      </div>

      <div className="h-6 w-px shrink-0" style={{ background: 'var(--border)' }} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold">{current.name}</div>
        <div className="truncate text-[10.5px]" style={{ color: 'var(--muted)' }}>
          {current.kind === 'home' ? t('topbar.homeHint') : t('topbar.groupHint')}
        </div>
      </div>

      <div className="relative shrink-0">
        <button
          type="button"
          className="relative flex h-9 w-9 items-center justify-center rounded-full"
          title={t('topbar.currentProfile', { name: displayName(currentProfile) })}
          aria-label={t('topbar.profileMenu')}
          aria-expanded={profileOpen}
          onClick={() => { setProfileOpen((open) => !open); setMenuOpen(false) }}
        >
          <GlyphTile letter={currentProfile.letter} color={currentProfile.color} size={30} rounded={999} title={displayName(currentProfile)} />
        </button>
        {profileOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setProfileOpen(false)} />
            <div
              className="absolute right-0 top-[44px] z-50 w-[286px] overflow-hidden rounded-xl border p-1.5 shadow-2xl"
              style={{ background: 'var(--card)', borderColor: 'var(--border-strong)' }}
            >
              <div className="px-2 pb-1 pt-1 text-[10.5px] font-medium uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
                {t('topbar.profileMenu')}
              </div>
              {visibleProfiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--card-hover)] disabled:cursor-default disabled:opacity-55"
                  disabled={!profileSelectionEnabled}
                  onClick={() => { setProfileOpen(false); onSelectProfile(profile.id) }}
                >
                  <GlyphTile letter={profile.letter} color={profile.color} size={24} rounded={999} />
                  <span className="min-w-0 flex-1 truncate">{displayName(profile)}</span>
                  <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
                    {profile.source === 'chrome' ? 'Chrome' : profile.source === 'edge' ? 'Edge' : t('profiles.sourceLauncher')}
                  </span>
                  {profile.id === currentProfile.id && <span style={{ color: 'var(--accent)' }}>✓</span>}
                </button>
              ))}
              <div className="my-1 border-t" style={{ borderColor: 'var(--border)' }} />
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[12.5px] hover:bg-[var(--card-hover)]"
                onClick={() => { setProfileOpen(false); onOpenProfiles() }}
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-md text-[13px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>◎</span>
                {t('topbar.manageProfiles')}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="relative shrink-0">
        <button
          type="button"
          className="btn btn-ghost btn-sm !h-9 !w-9 !p-0 text-[20px] leading-none"
          title={t('topbar.menu')}
          aria-label={t('topbar.menu')}
          aria-expanded={menuOpen}
          onClick={() => { setMenuOpen((open) => !open); setProfileOpen(false) }}
        >
          +
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div
              className="absolute right-0 top-[44px] z-50 w-[260px] overflow-hidden rounded-xl border p-1.5 shadow-2xl"
              style={{ background: 'var(--card)', borderColor: 'var(--border-strong)' }}
            >
              {overflow.length > 0 && (
                <div className="mb-1 border-b pb-1" style={{ borderColor: 'var(--border)' }}>
                  <div className="px-2 pb-1 pt-1 text-[10.5px] font-medium uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
                    {t('topbar.moreGroups')}
                  </div>
                  {overflow.map((group) => (
                    <button
                      key={group.id}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--card-hover)]"
                      onClick={() => chooseGroup(group.id)}
                    >
                      <GroupBadge group={group} active={group.id === current.id} size={24} />
                      <span className="min-w-0 flex-1 truncate">{group.name}</span>
                      <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
                        {t('topbar.group')}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[12.5px] hover:bg-[var(--card-hover)]"
                onClick={() => { setMenuOpen(false); onOpenGroups(true) }}
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-md text-[16px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>+</span>
                {t('topbar.newGroup')}
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[12.5px] hover:bg-[var(--card-hover)]"
                onClick={() => { setMenuOpen(false); onOpenGroups(false) }}
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-md text-[13px]" style={{ background: 'var(--bg-soft)' }}>≡</span>
                {t('topbar.manageGroups')}
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  )
}