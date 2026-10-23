// Synchronous leases close the check/await/start race between runtime writers
// and process/plugin startup. Long-lived child state is checked by the IPC gate.
let globalWrite = false
const writes = new Set<string>()
const readers = new Map<string, number>()

export function acquireRuntimeUse(id: string): () => void {
  if (globalWrite || writes.has(id)) throw new Error('运行环境正在安装，请稍后重试 / Runtime installation in progress')
  readers.set(id, (readers.get(id) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = (readers.get(id) ?? 1) - 1
    if (count > 0) readers.set(id, count)
    else readers.delete(id)
  }
}

export function acquireRuntimeWrite(id?: string): () => void {
  if (globalWrite || (id ? writes.has(id) || readers.has(id) : writes.size > 0 || readers.size > 0)) {
    throw new Error('运行环境正在使用或安装，请稍后重试 / Runtime is busy')
  }
  if (id) writes.add(id)
  else globalWrite = true
  let released = false
  return () => {
    if (released) return
    released = true
    if (id) writes.delete(id)
    else globalWrite = false
  }
}

export function runtimeWriteInProgress(id: string): boolean {
  return globalWrite || writes.has(id)
}
