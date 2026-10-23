import { basename } from 'node:path'

const EXECUTABLE_SUFFIX = /\.(?:exe|cmd|bat|com)$/i

/**
 * Extract the executable file name from a Windows command line.
 *
 * The first token is enough for the launcher's ownership check: it is compared
 * with the first token of the command configured on the instance. Quoted paths
 * containing spaces are handled; shell wrappers remain deliberately conservative
 * because a wrapper cannot prove that the listening process is ours.
 *
 * @param command - Full command line, e.g. `"C:\Apps\Kimi\kimi.exe" --port 1234`.
 * @returns Lower-cased executable basename without `.exe`/`.cmd`, or null when absent.
 */
export function executableNameFromCommand(command: string): string | null {
  const text = command.trim()
  if (!text) return null

  let token: string
  const quote = text[0]
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1)
    if (end < 0) return null
    token = text.slice(1, end)
  } else {
    token = text.split(/\s+/, 1)[0] ?? ''
  }

  token = token.replace(/^["']+|["']+$/g, '')
  if (!token) return null
  const name = basename(token.replace(/\\/g, '/')).replace(EXECUTABLE_SUFFIX, '')
  return name ? name.toLowerCase() : null
}

/**
 * Decide whether a listener may be reclaimed as this Web instance's process.
 *
 * Matching only the executable basename is intentionally conservative: when the
 * configured command uses a wrapper such as npx/pnpm, the listener's executable
 * differs and the caller must report a conflict instead of killing it.
 *
 * @param commandLine - Listener process command line from the OS.
 * @param instanceCommand - Command configured on the Web instance.
 * @returns True only when both resolve to the same executable basename.
 */
export function commandLineBelongsToInstance(commandLine: string, instanceCommand: string): boolean {
  const listenerExecutable = executableNameFromCommand(commandLine)
  const instanceExecutable = executableNameFromCommand(instanceCommand)
  return listenerExecutable !== null && listenerExecutable === instanceExecutable
}
