/** Only this fork's explicitly configured GitHub repository can supply updates. */
export function githubReleaseSource(repository: unknown): { api: string; releases: string } | null {
  const url = typeof repository === 'string' ? repository
    : repository && typeof repository === 'object' && 'url' in repository ? repository.url : null
  if (typeof url !== 'string') return null
  const match = /^(?:git\+)?https:\/\/github\.com\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url)
  if (!match) return null
  const slug = `${match[1]}/${match[2]}`
  return { api: `https://api.github.com/repos/${slug}/releases/latest`, releases: `https://github.com/${slug}/releases` }
}

export function parseLauncherRelease(data: unknown, releases: string): { tag: string | null; url: string | null } {
  if (!data || typeof data !== 'object') return { tag: null, url: null }
  const release = data as Record<string, unknown>
  if (release.draft || release.prerelease || typeof release.tag_name !== 'string'
    || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name)) return { tag: null, url: null }
  const expected = `${releases}/tag/${release.tag_name}`
  if (release.html_url !== expected) return { tag: null, url: null }
  return { tag: release.tag_name, url: expected }
}
