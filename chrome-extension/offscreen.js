// storage shim: offscreen/service-worker contexts may not expose chrome.storage
const __mem = {};
const storageLocal = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
  ? chrome.storage.local
  : { get: async (k) => (typeof k === 'string' ? { [k]: __mem[k] } : { ...__mem }),
      set: async (o) => { Object.assign(__mem, o); },
      remove: async (k) => { delete __mem[k]; } };
// DSH Cookie Bridge - offscreen WebSocket owner.
// This document owns the long-lived WebSocket because MV3 service workers are
// suspended. It is also the only place that turns cookie events into ops.

const PROTOCOL = 'dsh-cookie-bridge'
const PROTOCOL_VERSION = 1
const DEFAULT_PORT = 17321
const PING_INTERVAL_MS = 20_000
const DEAD_AFTER_MS = 55_000
const MAX_BACKOFF_MS = 30_000
const MAX_PENDING_OPS = 10_000

let socket = null
let authenticated = false
let reconnectTimer = null
let heartbeatTimer = null
let connectionAttempt = 0
let connectionEpoch = 0
let authBlocked = false
let currentStatus = {
  state: 'idle',
  message: '',
  port: DEFAULT_PORT,
  updatedAt: Date.now(),
  lastSyncAt: null,
  cookieCount: null
}
let activePort = DEFAULT_PORT
let lastPongAt = 0
let pendingOps = []
let syncTask = null
let syncAgain = false
let manualSyncRequested = false
let lastReconnectDelayMs = 0

function now() {
  return Date.now()
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function normalizePort(raw) {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return DEFAULT_PORT
  return parsed
}

async function publishStatus(state, patch = {}) {
  const next = {
    ...currentStatus,
    ...patch,
    state,
    port: activePort,
    updatedAt: now()
  }
  if (next.message === undefined) next.message = ''
  currentStatus = next
  try {
    await storageLocal.set({ bridgeStatus: next })
  } catch (error) {
    console.warn('[DSH Cookie Bridge] could not persist status:', errorText(error))
  }
}

function reportLog(message) {
  void chrome.runtime.sendMessage({ target: 'background', kind: 'log', message }).catch(() => {})
}

async function readConfig() {
  const data = await storageLocal.get(['bridgeToken', 'bridgePort', 'bridgeStatus'])
  if (data.bridgeStatus && typeof data.bridgeStatus === 'object') {
    currentStatus = { ...currentStatus, ...data.bridgeStatus }
  }
  return {
    token: typeof data.bridgeToken === 'string' ? data.bridgeToken.trim() : '',
    port: normalizePort(data.bridgePort)
  }
}

function cookieOrigin(cookie) {
  const host = String(cookie?.domain || '').replace(/^\./, '').trim()
  if (!host) return null
  const scheme = cookie?.secure ? 'https' : 'http'
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `${scheme}://${urlHost}`
}

function copyCookie(cookie, includeValue) {
  const copy = {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    hostOnly: Boolean(cookie.hostOnly),
    sameSite: cookie.sameSite || 'unspecified'
  }
  if (includeValue) copy.value = cookie.value
  if (typeof cookie.expirationDate === 'number') copy.expirationDate = cookie.expirationDate
  if (typeof cookie.storeId === 'string') copy.storeId = cookie.storeId
  if (cookie.partitionKey && typeof cookie.partitionKey === 'object') {
    copy.partitionKey = cookie.partitionKey
  }
  return copy
}

function makeOp(type, cookie, meta = {}) {
  const origin = cookieOrigin(cookie)
  if (!origin || !cookie?.name || typeof cookie.path !== 'string') return null
  return {
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    type,
    opId: crypto.randomUUID(),
    ts: now(),
    source: 'chrome',
    origin,
    name: cookie.name,
    path: cookie.path,
    domain: cookie.domain,
    cookie: copyCookie(cookie, type === 'cookie.set'),
    ...meta
  }
}

function socketIsOpen() {
  return socket !== null && socket.readyState === WebSocket.OPEN
}

function rawSend(payload) {
  if (!socketIsOpen()) return false
  try {
    socket.send(JSON.stringify(payload))
    return true
  } catch (error) {
    reportLog(`WebSocket send failed: ${errorText(error)}`)
    return false
  }
}

function queueOrSend(op) {
  if (!op) return
  if (authenticated && rawSend(op)) return
  pendingOps.push(op)
  if (pendingOps.length > MAX_PENDING_OPS) {
    pendingOps.splice(0, pendingOps.length - MAX_PENDING_OPS)
    reportLog('Pending op queue reached its cap; the next full sync will reconcile state.')
  }
}

async function flushPendingOps() {
  if (!authenticated) return
  while (pendingOps.length > 0) {
    if (!authenticated || !socketIsOpen()) return
    const op = pendingOps.shift()
    if (!rawSend(op)) {
      pendingOps.unshift(op)
      return
    }
  }
}

function handleCookieChange(changeInfo) {
  const cookie = changeInfo?.cookie
  if (!cookie) return
  const meta = {
    reason: 'change',
    cause: changeInfo.cause || 'unknown'
  }
  const op = makeOp(changeInfo.removed ? 'cookie.remove' : 'cookie.set', cookie, meta)
  queueOrSend(op)
}

function stopHeartbeat() {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function startHeartbeat() {
  stopHeartbeat()
  lastPongAt = now()
  heartbeatTimer = setInterval(() => {
    if (!authenticated || !socketIsOpen()) return
    if (now() - lastPongAt > DEAD_AFTER_MS) {
      try {
        socket.close(4000, 'heartbeat timeout')
      } catch {
        // The close event will schedule reconnect.
      }
      return
    }
    rawSend({ protocol: PROTOCOL, protocolVersion: PROTOCOL_VERSION, type: 'ping', ts: now(), source: 'chrome' })
  }, PING_INTERVAL_MS)
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function scheduleReconnect(reason) {
  if (authBlocked || reconnectTimer !== null) return
  const exponent = Math.min(connectionAttempt, 5)
  const baseDelay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** exponent)
  const jitter = Math.floor(Math.random() * 350)
  const delay = Math.min(MAX_BACKOFF_MS, baseDelay + jitter)
  connectionAttempt += 1
  lastReconnectDelayMs = delay
  const retryAt = now() + delay
  void publishStatus(connectionAttempt <= 1 ? 'connecting' : 'reconnecting', {
    message: reason || '连接已断开，等待重连',
    attempt: connectionAttempt,
    retryAt
  })
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connect()
  }, delay)
}

async function connect() {
  clearReconnectTimer()
  if (authBlocked) return
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return

  const epoch = ++connectionEpoch
  const config = await readConfig()
  if (epoch !== connectionEpoch) return
  activePort = config.port

  await publishStatus(connectionAttempt === 0 ? 'connecting' : 'reconnecting', {
    message: connectionAttempt === 0 ? '正在连接本地桥…' : '正在重连本地桥…',
    attempt: connectionAttempt,
    retryAt: null
  })

  let ws
  try {
    ws = new WebSocket(`ws://127.0.0.1:${activePort}`)
  } catch (error) {
    scheduleReconnect(`无法创建 WebSocket：${errorText(error)}`)
    return
  }

  socket = ws
  authenticated = false

  ws.addEventListener('open', () => {
    if (epoch !== connectionEpoch || socket !== ws) return
    const hello = {
      protocol: PROTOCOL,
      protocolVersion: PROTOCOL_VERSION,
      type: 'hello',
      client: {
        name: 'DSH Cookie Bridge',
        version: chrome.runtime.getManifest().version,
        browser: navigator.userAgent
      },
      ts: now()
    }
    // Empty means the launcher is in localhost none-auth mode. Omit the field
    // entirely instead of sending a blank credential.
    if (config.token) hello.token = config.token
    rawSend(hello)
  })
  ws.addEventListener('message', (event) => {
    if (epoch !== connectionEpoch || socket !== ws) return
    handleServerMessage(event.data)
  })

  ws.addEventListener('close', (event) => {
    if (socket !== ws) return
    socket = null
    authenticated = false
    stopHeartbeat()
    if (authBlocked) return
    const detail = event.code === 1000 ? '连接已关闭' : `连接已断开（${event.code || '网络错误'}）`
    scheduleReconnect(detail)
  })

  ws.addEventListener('error', () => {
    // The close event performs the retry; logging the URL would be harmless
    // but adding it would bury the actual status in noise.
  })
}

function handleHelloError(message) {
  const code = String(message.code || 'handshake_failed')
  const detail = String(message.message || '本地桥拒绝了连接')
  const fatalAuth = code === 'invalid_token' || code === 'token_used' || code === 'unauthorized'
  authBlocked = fatalAuth
  authenticated = false
  stopHeartbeat()
  void publishStatus('error', {
    message: fatalAuth ? `${detail}。若启动器使用免 Token 模式请留空;Token 模式请粘贴当前固定 Token。` : detail,
    code,
    attempt: 0,
    retryAt: null
  })
  if (socket) {
    const ws = socket
    socket = null
    try {
      ws.close(1008, 'handshake rejected')
    } catch {
      // Nothing else to clean up.
    }
  }
  if (!fatalAuth) scheduleReconnect(detail)
}

function handleServerMessage(raw) {
  let message
  try {
    message = JSON.parse(raw)
  } catch {
    reportLog('Ignored a non-JSON WebSocket message from the local bridge.')
    return
  }
  if (!message || typeof message !== 'object') return

  if (message.type === 'hello.ok' || message.type === 'welcome') {
    authenticated = true
    authBlocked = false
    connectionAttempt = 0
    manualSyncRequested = false
    startHeartbeat()
    void publishStatus('connected', {
      message: '',
      attempt: 0,
      retryAt: null,
      serverName: typeof message.serverName === 'string' ? message.serverName : 'DSH Launcher'
    })
    void (async () => {
      await flushPendingOps()
      if (authenticated) await startFullSync('initial')
    })()
    return
  }

  if (message.type === 'hello.error' || message.type === 'error') {
    if (!authenticated) handleHelloError(message)
    return
  }

  if (message.type === 'pong') {
    lastPongAt = now()
    return
  }

  if (message.type === 'ping') {
    rawSend({ protocol: PROTOCOL, protocolVersion: PROTOCOL_VERSION, type: 'pong', ts: now(), source: 'chrome' })
    return
  }

  // Acks are not required for v1, but accepting them keeps the protocol
  // forward-compatible if the launcher adds per-op acknowledgement later.
  if (message.type === 'ack') {
    lastPongAt = now()
  }
}

async function startFullSync(reason) {
  if (!authenticated) {
    manualSyncRequested = true
    await connect()
    return { ok: false, error: 'not_connected' }
  }
  if (syncTask) {
    syncAgain = true
    await syncTask
    return { ok: true, coalesced: true }
  }

  syncTask = (async () => {
    do {
      syncAgain = false
      const snapshotId = crypto.randomUUID()
      const cookies = await chrome.cookies.getAll({})
      let sent = 0
      for (const cookie of cookies) {
        if (!authenticated || !socketIsOpen()) break
        const op = makeOp('cookie.set', cookie, {
          reason,
          snapshotId,
          snapshotIndex: sent,
          snapshotTotal: cookies.length
        })
        if (op && rawSend(op)) sent += 1
        if (sent > 0 && sent % 200 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }
      await publishStatus(authenticated ? 'connected' : 'disconnected', {
        lastSyncAt: now(),
        cookieCount: cookies.length,
        message: authenticated ? '' : '同步中断，等待重连'
      })
    } while (syncAgain && authenticated)
  })()

  try {
    await syncTask
    return { ok: true }
  } catch (error) {
    const detail = errorText(error)
    await publishStatus('error', { message: `读取 Cookie 失败：${detail}` })
    return { ok: false, error: detail }
  } finally {
    syncTask = null
  }
}

async function reconnectFromConfig() {
  connectionEpoch += 1
  connectionAttempt = 0
  authBlocked = false
  manualSyncRequested = false
  clearReconnectTimer()
  stopHeartbeat()
  const old = socket
  socket = null
  authenticated = false
  if (old) {
    try {
      old.close(1000, 'configuration changed')
    } catch {
      // A socket already transitioning to CLOSED needs no further work.
    }
  }
  await connect()
}

async function boot() {
  const config = await readConfig()
  activePort = config.port
  await connect()
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false

  if (message.kind === 'cookie-changed') {
    handleCookieChange(message.changeInfo)
    return false
  }

  if (message.kind === 'sync-now') {
    manualSyncRequested = true
    void startFullSync('manual')
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: errorText(error) }))
    return true
  }

  if (message.kind === 'reconnect') {
    void reconnectFromConfig()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: errorText(error) }))
    return true
  }

  if (message.kind === 'check') {
    if (!socket && !authBlocked && reconnectTimer === null) void connect()
    sendResponse({ ok: true, authenticated })
    return false
  }

  return false
})

if (chrome?.storage?.onChanged) chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return
  if (!changes.bridgeToken && !changes.bridgePort) return
  // The popup writes token and port together. Rebuild from storage rather than
  // trusting the event payload so a partial update can never use a stale token.
  void reconnectFromConfig()
})

void boot().catch((error) => {
  reportLog(`boot failed: ${errorText(error)}`)
  void publishStatus('error', { message: `扩展启动失败：${errorText(error)}` })
})
