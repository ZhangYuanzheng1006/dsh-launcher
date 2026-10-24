/** Prefix attached to desktop-app stdout/stderr before it reaches the log UI. */
export const GUI_APP_LOG_PREFIX = '[app] '

/** True for lines emitted by an embedded desktop app itself. */
export function isGuiAppLogLine(line: string): boolean {
  return line.startsWith(GUI_APP_LOG_PREFIX)
}

/** Filter for the default "launcher only" console mode. */
export function filterLauncherLogLines<T extends { line: string }>(lines: readonly T[], launcherOnly: boolean): T[] {
  return launcherOnly ? lines.filter((entry) => !isGuiAppLogLine(entry.line)) : [...lines]
}
