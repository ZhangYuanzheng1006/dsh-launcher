// storage shim: offscreen/service-worker contexts may not expose chrome.storage
const __mem = {};
const storageLocal = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
  ? chrome.storage.local
  : { get: async (k) => (typeof k === 'string' ? { [k]: __mem[k] } : { ...__mem }),
      set: async (o) => { Object.assign(__mem, o); },
      remove: async (k) => { delete __mem[k]; } };
// DSH Cookie Bridge - MV3 coordinator.
// The service worker can be suspended, so all WebSocket work lives in an
// offscreen document. This worker only routes cookie events and lifecycle.

const OFFSCREEN_PATH = 'offscreen.html'
const ALARM_NAME = 'dsh-cookie-bridge-keepalive'
const KEEPALIVE_MINUTES = 0.5

let offscreenKnown = false
let ensureTask = null
let lastCreateError = ''

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME)
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: KEEPALIVE_MINUTES })
  }
}

async function ensureOffscreen() {
  if (offscreenKnown) return
  if (ensureTask) return ensureTask

  ensureTask = (async () => {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH)
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    })
    if (contexts.length > 0) {
      offscreenKnown = true
      return
    }

    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Keep a token-authenticated local WebSocket alive while syncing Chrome cookies to DSH Launcher.'
      })
      offscreenKnown = true
      lastCreateError = ''
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      // A concurrent create can win the race; treat that as success.
      if (/single offscreen|already exists|only one/i.test(text)) {
        offscreenKnown = true
        return
      }
      lastCreateError = text
      throw error
    }
  })()

  try {
    await ensureTask
  } finally {
    ensureTask = null
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function sendToOffscreen(message) {
  await ensureOffscreen()
  const envelope = { target: 'offscreen', ...message }
  try {
    return await chrome.runtime.sendMessage(envelope)
  } catch (error) {
    // The cached context can be stale after Chrome reclaims the document.
    offscreenKnown = false
    await ensureOffscreen()
    await sleep(120)
    return chrome.runtime.sendMessage(envelope)
  }
}

async function initialize() {
  try {
    await ensureAlarm()
    await ensureOffscreen()
  } catch (error) {
    console.warn('[DSH Cookie Bridge] initialization failed:', error)
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void initialize()
})

chrome.runtime.onStartup.addListener(() => {
  void initialize()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return
  offscreenKnown = false
  void initialize()
    .then(() => sendToOffscreen({ kind: 'check' }))
    .catch((error) => console.warn('[DSH Cookie Bridge] keepalive failed:', error))
})

chrome.cookies.onChanged.addListener((changeInfo) => {
  void sendToOffscreen({ kind: 'cookie-changed', changeInfo }).catch((error) => {
    console.warn('[DSH Cookie Bridge] cookie event could not reach offscreen document:', error)
  })
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'background') return false

  if (message.kind === 'status') {
    offscreenKnown = true
    storageLocal.set({ bridgeStatus: message.status }).catch((error) => {
      console.warn('[DSH Cookie Bridge] status write failed:', error)
    })
    return false
  }

  if (message.kind === 'log') {
    console.warn('[DSH Cookie Bridge]', message.message)
    return false
  }

  if (message.type === 'bridge:reconnect') {
    void sendToOffscreen({ kind: 'reconnect' })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }))
    return true
  }

  if (message.type === 'bridge:sync-now') {
    void sendToOffscreen({ kind: 'sync-now' })
      .then((result) => sendResponse(result || { ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }))
    return true
  }

  if (message.type === 'bridge:diagnostics') {
    sendResponse({
      ok: true,
      offscreenKnown,
      lastCreateError
    })
    return false
  }

  return false
})

// MV3 starts the worker on browser startup for install/startup events. Also
// run once when this module is evaluated so a manually reloaded extension heals.
void initialize()
