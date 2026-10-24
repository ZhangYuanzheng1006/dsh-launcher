import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeJsonAtomic } from '../src/main/atomic-json'

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('writeJsonAtomic', () => {
  it('backs up the previous file and leaves no temp file', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-launcher-atomic-'))
    const file = join(dir, 'launcher-config.json')
    writeFileSync(file, '{"old":true}', 'utf8')

    writeJsonAtomic(file, { configVersion: 1 })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ configVersion: 1 })
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe('{"old":true}')
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('writes a fresh file without creating a backup', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-launcher-atomic-'))
    const file = join(dir, 'nested', 'launcher-config.json')

    writeJsonAtomic(file, { value: 1 })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ value: 1 })
    expect(existsSync(`${file}.bak`)).toBe(false)
  })
})
