import { describe, expect, it } from 'vitest'
import { commandLineBelongsToInstance, executableNameFromCommand } from '../src/main/port-ownership'

describe('port ownership', () => {
  it('matches the configured executable basename regardless of its directory', () => {
    expect(commandLineBelongsToInstance(
      '"D:\\Tools\\Kimi\\kimi.exe" --port 1234',
      '"C:\\Program Files\\Kimi\\kimi.exe" --port 1234'
    )).toBe(true)
  })

  it('rejects a listener owned by another program', () => {
    expect(commandLineBelongsToInstance(
      'python.exe -m http.server 1234',
      '"C:\\Program Files\\Kimi\\kimi.exe" --port 1234'
    )).toBe(false)
  })

  it('handles quoted paths and executable suffixes', () => {
    expect(executableNameFromCommand('"C:\\Program Files\\Node\\node.exe" server.js')).toBe('node')
    expect(executableNameFromCommand('C:\\Tools\\server.cmd --port 1234')).toBe('server')
    expect(executableNameFromCommand('   ')).toBeNull()
  })

  it('is conservative for wrappers and incomplete data', () => {
    expect(commandLineBelongsToInstance('node.exe npm-cli.js run dev', 'npx some-server')).toBe(false)
    expect(commandLineBelongsToInstance('', 'kimi.exe')).toBe(false)
  })
})
