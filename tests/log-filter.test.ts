import { describe, expect, it } from 'vitest'
import { filterLauncherLogLines, GUI_APP_LOG_PREFIX, isGuiAppLogLine } from '../src/shared/log'

describe('desktop app log folding', () => {
  it('recognizes only explicitly prefixed app lines', () => {
    expect(isGuiAppLogLine(`${GUI_APP_LOG_PREFIX}401 plugin catalog`)).toBe(true)
    expect(isGuiAppLogLine('[launcher] started')).toBe(false)
    expect(isGuiAppLogLine('[gui] attached')).toBe(false)
  })

  it('filters app noise in the default launcher-only mode', () => {
    const lines = [
      { line: '[launcher] starting' },
      { line: `${GUI_APP_LOG_PREFIX}Sign in to ChatGPT` },
      { line: '[gui] attached' }
    ]
    expect(filterLauncherLogLines(lines, true).map((x) => x.line)).toEqual(['[launcher] starting', '[gui] attached'])
    expect(filterLauncherLogLines(lines, false)).toEqual(lines)
  })
})
