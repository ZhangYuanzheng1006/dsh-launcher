import { AsyncLocalStorage } from 'node:async_hooks'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

const context = new AsyncLocalStorage<Map<string, symbol>>()
const transactions = new Map<string, symbol>()
const boots = new Map<string, symbol>()

function profileKey(home: string, profile: string): string {
  let path = resolve(home)
  try { path = realpathSync(path) } catch { /* New home. */ }
  if (process.platform === 'win32') path = path.toLowerCase()
  return `${path}\0${profile}`
}

/** Covers the complete install/rollback/enable transaction, not just pnpm. */
export async function withProfileOperation<T>(home: string, profile: string, operation: () => Promise<T>): Promise<T> {
  const key = profileKey(home, profile)
  const current = transactions.get(key)
  if (current && context.getStore()?.get(key) === current) return operation()
  if (current || boots.has(key)) throw new Error('该实例正在启动或修改插件，请完成后重试 / This profile is starting or changing plugins')
  const token = Symbol(key)
  transactions.set(key, token)
  const next = new Map(context.getStore())
  next.set(key, token)
  try { return await context.run(next, operation) }
  finally { if (transactions.get(key) === token) transactions.delete(key) }
}

/** Keep the profile protected after spawn until the child's web server is ready. */
export function beginProfileBoot(home: string, profile: string): () => void {
  const key = profileKey(home, profile)
  if (boots.has(key)) throw new Error('该 profile 正在启动 / This profile is already starting')
  const token = Symbol(key)
  boots.set(key, token)
  return () => { if (boots.get(key) === token) boots.delete(key) }
}
