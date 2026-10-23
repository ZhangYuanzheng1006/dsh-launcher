import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Write a JSON file atomically and keep the previous file as `<file>.bak`.
 *
 * The temp file lives beside the target so the final rename is on the same
 * volume. Fsync precedes rename, so a crash cannot expose partial JSON at the
 * target path.
 *
 * @param filePath - Absolute path of the JSON file to replace.
 * @param value - Value serialized with two-space indentation.
 */
export function writeJsonAtomic(filePath: string, value: unknown, options: { backup?: boolean } = {}): void {
  const serialized = JSON.stringify(value, null, 2)
  if (serialized === undefined) throw new TypeError(`Cannot serialize ${filePath} as JSON`)

  mkdirSync(dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp`
  let fd: number | undefined
  try {
    if (options.backup !== false && existsSync(filePath)) copyFileSync(filePath, `${filePath}.bak`)
    fd = openSync(tempPath, 'w')
    writeFileSync(fd, serialized, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tempPath, filePath)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* the write already failed; closing is best effort */
      }
    }
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath)
      } catch {
        /* the target rename already succeeded or cleanup is best effort */
      }
    }
  }
}
