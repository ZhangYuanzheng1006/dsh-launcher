import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: { dipToScreenRect: () => ({ x: 0, y: 0, width: 1, height: 1 }) }
}))

import {
  isGuiViewWorkPaused,
  pauseGuiViewWork,
  resumeGuiViewWork,
  withGuiViewPaused
} from '../src/main/gui-view'

describe('GUI dialog pause gate', () => {
  it('supports nested modal pause/resume without resuming too early', () => {
    expect(isGuiViewWorkPaused()).toBe(false)
    pauseGuiViewWork('outer')
    pauseGuiViewWork('inner')
    expect(isGuiViewWorkPaused()).toBe(true)
    resumeGuiViewWork()
    expect(isGuiViewWorkPaused()).toBe(true)
    resumeGuiViewWork()
    expect(isGuiViewWorkPaused()).toBe(false)
  })

  it('always resumes after the wrapped dialog promise settles', async () => {
    await guiViewPauseProbe()
    expect(isGuiViewWorkPaused()).toBe(false)
  })
})

async function guiViewPauseProbe(): Promise<void> {
  await withGuiViewPaused(async () => {
    expect(isGuiViewWorkPaused()).toBe(true)
    await Promise.resolve()
    expect(isGuiViewWorkPaused()).toBe(true)
  })
}
