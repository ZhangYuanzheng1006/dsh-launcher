// storage shim: offscreen/service-worker contexts may not expose chrome.storage
const __mem = {};
const storageLocal = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
  ? chrome.storage.local
  : { get: async (k) => (typeof k === 'string' ? { [k]: __mem[k] } : { ...__mem }),
      set: async (o) => { Object.assign(__mem, o); },
      remove: async (k) => { delete __mem[k]; } };
const DEFAULT_PORT = 17321

const els = {
  token: document.getElementById('token'),
  port: document.getElementById('port'),
  serverHint: document.getElementById('serverHint'),
  save: document.getElementById('save'),
  sync: document.getElementById('sync'),
  dot: document.getElementById('statusDot'),
  statusLabel: document.getElementById('statusLabel'),
  portLabel: document.getElementById('portLabel'),
  message: document.getElementById('message'),
  lastSync: document.getElementById('lastSync'),
  cookieCount: document.getElementById('cookieCount')
}

let hasSavedToken = false
let currentStatus = { state: 'idle' }

const STATE_LABELS = {
  idle: '初始化中…',
  needs_token: '未配置 Token',
  connecting: '正在连接…',
  reconnecting: '连接断开，正在重连…',
  connected: '已连接',
  error: '连接失败',
  disconnected: '未连接'
}

function tokenPlaceholder(hasToken) {
  return hasToken ? '已保存 Token（留空保存将清除）' : '可留空（启动器免 Token 模式）'
}

function formatTime(timestamp) {
  if (!Number.isFinite(timestamp)) return '—'
  try {
    return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return '—'
  }
}

function renderStatus(status) {
  currentStatus = status && typeof status === 'object' ? status : { state: 'idle' }
  const state = STATE_LABELS[currentStatus.state] ? currentStatus.state : 'disconnected'
  els.statusLabel.textContent = STATE_LABELS[state]
  els.dot.className = `dot ${state}`
  els.portLabel.textContent = `:${currentStatus.port || els.port.value || DEFAULT_PORT}`
  els.lastSync.textContent = `最近同步：${formatTime(currentStatus.lastSyncAt)}`
  els.cookieCount.textContent = Number.isInteger(currentStatus.cookieCount)
    ? `Cookie：${currentStatus.cookieCount}`
    : 'Cookie：—'

  const message = typeof currentStatus.message === 'string' ? currentStatus.message : ''
  els.message.textContent = message
  els.message.className = `message${state === 'error' ? ' error' : ''}`
}

function readFormPort() {
  const port = Number.parseInt(els.port.value, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

function setBusy(button, busy, label) {
  button.disabled = busy
  if (label) button.textContent = label
}

async function init() {
  const data = await storageLocal.get(['bridgeToken', 'bridgePort', 'bridgeStatus'])
  hasSavedToken = typeof data.bridgeToken === 'string' && data.bridgeToken.trim().length > 0
  els.token.placeholder = tokenPlaceholder(hasSavedToken)
  els.port.value = String(Number.isInteger(data.bridgePort) ? data.bridgePort : DEFAULT_PORT)
  els.serverHint.value = `ws://127.0.0.1:${els.port.value}`
  els.sync.disabled = false
  renderStatus(data.bridgeStatus)

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return
    if (changes.bridgeStatus) renderStatus(changes.bridgeStatus.newValue)
    if (changes.bridgeToken) {
      hasSavedToken = typeof changes.bridgeToken.newValue === 'string' && changes.bridgeToken.newValue.trim().length > 0
      els.token.placeholder = tokenPlaceholder(hasSavedToken)
      els.sync.disabled = false
    }
    if (changes.bridgePort) {
      const port = Number.isInteger(changes.bridgePort.newValue) ? changes.bridgePort.newValue : DEFAULT_PORT
      els.port.value = String(port)
      els.serverHint.value = `ws://127.0.0.1:${port}`
    }
  })
}

els.save.addEventListener('click', async () => {
  const port = readFormPort()
  if (!port) {
    els.message.textContent = '端口必须是 1–65535 的整数。'
    els.message.className = 'message error'
    return
  }

  const typedToken = els.token.value.trim()

  setBusy(els.save, true, '保存中…')
  try {
    // An empty value is valid: none-auth mode performs no credential check.
    // Saving empty also clears any previous token, matching the field contents.
    await storageLocal.set({ bridgePort: port, bridgeToken: typedToken })
    els.token.value = ''
    hasSavedToken = typedToken.length > 0
    els.token.placeholder = tokenPlaceholder(hasSavedToken)
    els.sync.disabled = false
    els.serverHint.value = `ws://127.0.0.1:${port}`
    els.statusLabel.textContent = '正在连接…'
    els.dot.className = 'dot connecting'
    els.message.textContent = hasSavedToken
      ? 'Token 已保存。若启动器桥已启动，数秒内会显示已连接。'
      : '已保存为无 Token 连接。启动器需处于免 Token 模式。'
    els.message.className = 'message'
    await chrome.runtime.sendMessage({ target: 'background', type: 'bridge:reconnect' })
  } catch (error) {
    els.message.textContent = `保存失败：${error instanceof Error ? error.message : String(error)}`
    els.message.className = 'message error'
  } finally {
    setBusy(els.save, false, '保存并连接')
  }
})

els.sync.addEventListener('click', async () => {
  setBusy(els.sync, true, '同步中…')
  try {
    const result = await chrome.runtime.sendMessage({ target: 'background', type: 'bridge:sync-now' })
    if (result && result.ok) {
      els.message.textContent = '已向本地桥发送同步请求。'
      els.message.className = 'message'
    } else {
      els.message.textContent = '桥尚未连接；已请求在连接成功后自动同步。'
      els.message.className = 'message'
    }
  } catch (error) {
    els.message.textContent = `同步请求失败：${error instanceof Error ? error.message : String(error)}`
    els.message.className = 'message error'
  } finally {
    setBusy(els.sync, false, '立即同步')
  }
})

els.port.addEventListener('input', () => {
  const port = readFormPort()
  els.serverHint.value = port ? `ws://127.0.0.1:${port}` : '端口无效'
})

init().catch((error) => {
  renderStatus({ state: 'error', message: `读取扩展状态失败：${error.message}` })
})
