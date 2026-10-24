// System tray: keeps the launcher alive in the background when the window is
// closed with closeToTray enabled, and provides Show/Quit actions. The icon is
// a bundled PNG resolved for both dev and packaged builds. The icon always
// carries a coloured corner dot
// (green/yellow/red) mirroring dsh's runtime state — the dot is drawn into the
// bitmap in memory while the base image stays in resources/tray-base.png.
import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { broadcast } from './bus'
import * as dshStatus from './dsh-status'
import { getConfig } from './config'
import * as harness from './harness'
import * as instances from './instances'
import * as runtime from './runtime'
import { t } from './i18n'

// 32×32 RGBA: white disc + the little black whale on top — matches the
// sidebar logo, and the white disc keeps the dark whale visible on both light
// and dark taskbars.


let tray: Tray | null = null
let win: BrowserWindow | null = null
let quitting = false
let notified = false

// Status-dot colour per light (RGBA). The dot sits in the bottom-right corner.
// null = no dot (light 'off').
const DOT_COLORS: Record<Exclude<dshStatus.DshLight, 'off'>, [number, number, number]> = {
  green: [0x34, 0xd3, 0x64],
  yellow: [0xf2, 0xb5, 0x0c],
  red: [0xef, 0x44, 0x44]
}
/** Cached status icons so setImage doesn't redraw every poll. */
const iconCache = new Map<string, Electron.NativeImage>()

/** Base icon + an optional coloured dot, rendered into the bitmap in memory. */
function makeTrayIcon(light: dshStatus.DshLight): Electron.NativeImage {
  const key = `light:${light}`
  const cached = iconCache.get(key)
  if (cached) return cached
  const file = [join(process.resourcesPath, 'tray-base.png'), join(app.getAppPath(), 'resources', 'tray-base.png')].find(existsSync)
  if (!file) throw new Error('Missing tray-base.png application resource')
  const base = nativeImage.createFromPath(file)
  const color = light === 'off' ? null : DOT_COLORS[light]
  if (!color) {
    iconCache.set(key, base)
    return base
  }
  const size = base.getSize()
  const bmp = base.toBitmap()
  const stride = size.width * 4
  // ~10px dot, ~1px inset from the bottom-right corner.
  const cx = size.width - 6
  const cy = size.height - 6
  const r = 5
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= r * r) {
        // toBitmap/createFromBitmap on Windows are BGRA — write B,G,R so the
        // colours aren't swapped (a yellow dot was rendering blue before this).
        const i = y * stride + x * 4
        bmp[i] = color[2]     // B
        bmp[i + 1] = color[1] // G
        bmp[i + 2] = color[0] // R
        bmp[i + 3] = 255      // A
      }
    }
  }
  const icon = nativeImage.createFromBitmap(bmp, { width: size.width, height: size.height })
  iconCache.set(key, icon)
  return icon
}

export function isQuitting(): boolean {
  return quitting
}

/** Set before app.quit() so the window's close handler doesn't hide to tray. */
export function markQuitting(): void {
  quitting = true
}

/**
 * Bring the launcher window to the front — used by the tray menu, tray
 * double-click, and the single-instance handler when the desktop shortcut is
 * re-run while the app is already hidden to the tray.
 */
export function showLauncher(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// Status text per light (zh, en) — used for the hover tooltip and the status
// line at the top of the right-click menu.
const STATUS_TEXT: Record<dshStatus.DshLight, [string, string]> = {
  off: ['DSH 未运行', 'DSH not running'],
  green: ['DSH 运行中', 'DSH running'],
  yellow: ['DSH 等待处理', 'DSH awaiting input'],
  red: ['DSH 报错', 'DSH error']
}

/** Human-readable status in the current UI language. */
function statusLine(light: dshStatus.DshLight): string {
  const [zh, en] = STATUS_TEXT[light]
  return t(zh, en)
}

/** Tray hover tooltip, e.g. "DSH Launcher — DSH 运行中". */
function tooltip(light: dshStatus.DshLight): string {
  const [zh, en] = STATUS_TEXT[light]
  return t(`DSH Launcher — ${zh}`, `DSH Launcher — ${en}`)
}

/** Small filled dot used as the icon of the menu's status line. */
function dotIcon(light: dshStatus.DshLight): Electron.NativeImage {
  const color = light === 'off' ? [0x9a, 0x9a, 0x9a] : DOT_COLORS[light]
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  const r = 5.5
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - (size / 2 - 0.5)
      const dy = y - (size / 2 - 0.5)
      if (dx * dx + dy * dy <= r * r) {
        // BGRA byte order (see makeTrayIcon).
        const i = (y * size + x) * 4
        buf[i] = color[2]     // B
        buf[i + 1] = color[1] // G
        buf[i + 2] = color[0] // R
        buf[i + 3] = 255
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

/** Right-click menu; the first line is the live dsh status (disabled). */
function buildMenu(light: dshStatus.DshLight): Electron.Menu {
  const cfg = getConfig()
  const shown = cfg.instances.filter((i) => i.enabled !== false)
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: statusLine(light), enabled: false, icon: dotIcon(light) },
    { type: 'separator' },
    { label: t('显示主界面', 'Show Launcher'), click: showLauncher },
    { type: 'separator' },
  ]
  // 实例列表(参照 deepseek-harness-desktop 的托盘面板):点击切换活动实例并打开窗口。
  for (const inst of shown) {
    const st = harness.getState(inst.id)
    const running = st.status === 'running' || st.status === 'external' || st.status === 'degraded'
    items.push({
      label: `${running ? '●' : '○'} ${inst.name}${running ? ` — ${st.port}` : ''}`,
      click: () => {
        instances.setActiveInstance(inst.id)
        // 广播实例列表,让 renderer 的活动实例/视图跟着切换,而不只是打开窗口。
        broadcast({ type: 'instances', instances: instances.getInstances(), activeInstanceId: inst.id })
        showLauncher()
      }
    })
  }
  if (shown.length > 0) items.push({ type: 'separator' })
  items.push(
    // 检查更新:打开窗口(进度显示在设置页任务区)并触发更新内置 dsh。
    {
      label: t('检查更新', 'Check for updates'),
      click: () => { showLauncher(); void runtime.updateRuntime() }
    },
    // 设置:打开窗口并导航到设置页。
    {
      label: t('设置', 'Settings'),
      click: () => {
        showLauncher()
        broadcast({ type: 'launcher-page', page: 'settings' })
      }
    },
    { type: 'separator' },
    {
      label: t('退出', 'Quit'),
      click: () => {
        markQuitting()
        app.quit()
      }
    }
  )
  return Menu.buildFromTemplate(items)
}

export function initTray(window: BrowserWindow): void {
  win = window
  tray = new Tray(makeTrayIcon('off'))
  // Status light: mirror dsh's runtime state in the tray icon (always on).
  // The light also drives the hover tooltip and the menu's status line, so all
  // three are refreshed together whenever the light changes. onDshLight fires
  // immediately with the current state, so this also seeds the initial values.
  let menu = buildMenu('off')
  const off = dshStatus.onDshLight((light) => {
    if (!tray) return
    tray.setImage(makeTrayIcon(light))
    tray.setToolTip(tooltip(light))
    menu = buildMenu(light)
  })
  win.on('closed', () => {
    off()
    win = null
  })
  // Left-click (and double-click) brings the window back. On Windows a context
  // menu attached via setContextMenu swallows the left click, so the menu is
  // popped up manually on right-click only.
  tray.on('click', showLauncher)
  tray.on('double-click', showLauncher)
  tray.on('right-click', () => tray?.popUpContextMenu(menu))
}

/**
 * Called from the window `close` handler. Returns true when the close was
 * swallowed and the window hidden to the tray instead.
 */
export function hideToTray(): boolean {
  if (quitting || !getConfig().closeToTray) return false
  win?.hide()
  if (!notified) {
    notified = true
    tray?.displayBalloon({
      title: 'DSH Launcher',
      content: t('已最小化到系统托盘,仍在后台运行。', 'Minimized to system tray; still running in the background.')
    })
  }
  return true
}
