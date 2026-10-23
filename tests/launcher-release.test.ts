import { describe, expect, it } from 'vitest'
import { githubReleaseSource, parseLauncherRelease } from '../src/shared/launcher-release'

describe('launcher release identity', () => {
  const repository = 'https://github.com/ZhangYuanzheng1006/dsh-launcher.git'
  const releases = 'https://github.com/ZhangYuanzheng1006/dsh-launcher/releases'
  it('uses the fork repository for update discovery', () => {
    expect(githubReleaseSource({ url: repository })).toEqual({
      api: 'https://api.github.com/repos/ZhangYuanzheng1006/dsh-launcher/releases/latest', releases
    })
    expect(githubReleaseSource(`git+${repository}`)).toEqual(githubReleaseSource(repository))
  })
  it.each([undefined, '', 'file:///secret', 'http://github.com/a/b', 'https://evil.example/a/b', 'https://github.com/a/b/../../other', 'https://github.com/a/b?token=secret'])('disables updates for an invalid repository %s', value => {
    expect(githubReleaseSource(value)).toBeNull()
  })
  it('accepts stable releases belonging to the configured repository', () => {
    expect(parseLauncherRelease({ tag_name: 'v3.2.1', html_url: `${releases}/tag/v3.2.1` }, releases)).toEqual({ tag: 'v3.2.1', url: `${releases}/tag/v3.2.1` })
  })
  it.each([
    { tag_name: 'v3.2.1', html_url: 'https://github.com/MarcoG-h/DSH-Launcher/releases/tag/v3.2.1' },
    { tag_name: 'v3.2.1', html_url: `${releases}/tag/v3.2.1`, draft: true },
    { tag_name: 'v3.2.1', html_url: `${releases}/tag/v3.2.1`, prerelease: true },
    { tag_name: 'latest', html_url: `${releases}/tag/latest` },
    { message: 'API rate limit exceeded' }
  ])('ignores malformed, nonstable or foreign release responses', data => {
    expect(parseLauncherRelease(data, releases)).toEqual({ tag: null, url: null })
  })
})
