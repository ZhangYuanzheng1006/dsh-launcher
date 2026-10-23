/** Parse a PowerShell launch command without invoking a shell during validation. */

export interface ParsedPowerShellCommand {
  /** PowerShell executable to spawn. */
  executable: 'powershell.exe' | 'pwsh.exe'
  /** Script body written to a temporary .ps1 file. */
  script: string
}

export type PowerShellCommandParseResult =
  | { ok: true; command: ParsedPowerShellCommand }
  | { ok: false; error: string }

/** Split a Windows command line while preserving quoted argument values. */
export function splitWindowsCommandLine(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quoted = false
  let escaped = false
  for (const char of input) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quoted) {
      current += char
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) args.push(current)
  return args
}

/**
 * Accept either a bare script body or a wrapped `powershell/pwsh -Command ...`
 * command. The wrapper is removed so the runner can always use a UTF-8 .ps1 file.
 */
export function parsePowerShellCommand(raw: string): PowerShellCommandParseResult {
  const input = raw.replace(/^\uFEFF/, '').replace(/\0/g, '').trim()
  if (!input) return { ok: false, error: 'PowerShell 启动命令不能为空。' }
  const tokens = splitWindowsCommandLine(input)
  const first = (tokens[0] ?? '').toLowerCase()
  const wrapped = first === 'powershell' || first === 'powershell.exe' || first === 'pwsh' || first === 'pwsh.exe'
  if (!wrapped) return { ok: true, command: { executable: 'powershell.exe', script: input } }

  const executable = first.startsWith('pwsh') ? 'pwsh.exe' : 'powershell.exe'
  const commandIndex = tokens.findIndex((token, index) => index > 0 && /^-(?:command|c)$/i.test(token))
  if (commandIndex < 0) {
    return { ok: false, error: '检测到 PowerShell 包装命令，但缺少 -Command；请直接填写脚本正文。' }
  }
  const script = tokens.slice(commandIndex + 1).join(' ').trim()
  if (!script) return { ok: false, error: 'PowerShell -Command 后没有脚本正文。' }
  return { ok: true, command: { executable, script } }
}