/** Localized copy for the S6/S7 surfaces, kept separate to avoid merge
 * conflicts with the concurrently-edited main i18n dictionary. */

export type S6S7TextKey =
  | 'new'
  | 'history'
  | 'downloads'
  | 'deleteLink'
  | 'deletedLink'
  | 'undo'
  | 'collapse'
  | 'expand'
  | 'historyTitle'
  | 'historySubtitle'
  | 'noHistory'
  | 'openLink'
  | 'downloadsTitle'
  | 'downloadsSubtitle'
  | 'openFolder'
  | 'clearDownloads'
  | 'clearDownloadsConfirm'
  | 'downloadsEmpty'
  | 'downloadProgressing'
  | 'downloadCompleted'
  | 'downloadCancelled'
  | 'downloadInterrupted'
  | 'reveal'
  | 'perfTitle'
  | 'perfCpu'
  | 'perfMemory'
  | 'perfNetwork'
  | 'perfLast60'
  | 'perfSystemMemory'
  | 'perfRx'
  | 'perfTx'

const TEXT: Record<'zh' | 'en', Record<S6S7TextKey, string>> = {
  zh: {
    new: '新建',
    history: '历史',
    downloads: '下载',
    deleteLink: '删除链接',
    deletedLink: '已删除链接「{name}」',
    undo: '撤销',
    collapse: '收起',
    expand: '展开',
    historyTitle: '历史记录',
    historySubtitle: '当前分组打开过的链接',
    noHistory: '还没有历史记录。打开一个链接后会出现在这里。',
    openLink: '打开',
    downloadsTitle: '下载记录',
    downloadsSubtitle: '由主进程 will-download 事件记录并持久化',
    openFolder: '打开下载目录',
    clearDownloads: '清空记录',
    clearDownloadsConfirm: '清空下载记录？下载的文件不会被删除。',
    downloadsEmpty: '还没有下载记录。',
    downloadProgressing: '下载中',
    downloadCompleted: '已完成',
    downloadCancelled: '已取消',
    downloadInterrupted: '已中断',
    reveal: '所在文件夹',
    perfTitle: '系统性能',
    perfCpu: 'CPU',
    perfMemory: '内存',
    perfNetwork: '网络',
    perfLast60: '最近 60 秒',
    perfSystemMemory: '系统内存 {percent}%',
    perfRx: '下',
    perfTx: '上'
  },
  en: {
    new: 'New',
    history: 'History',
    downloads: 'Downloads',
    deleteLink: 'Delete link',
    deletedLink: 'Deleted link "{name}"',
    undo: 'Undo',
    collapse: 'Collapse',
    expand: 'Expand',
    historyTitle: 'History',
    historySubtitle: 'Links opened in the current group',
    noHistory: 'No history yet. Opened links will appear here.',
    openLink: 'Open',
    downloadsTitle: 'Downloads',
    downloadsSubtitle: 'Recorded by the main-process will-download event and persisted',
    openFolder: 'Open downloads folder',
    clearDownloads: 'Clear records',
    clearDownloadsConfirm: 'Clear download records? Downloaded files will not be deleted.',
    downloadsEmpty: 'No downloads recorded yet.',
    downloadProgressing: 'Downloading',
    downloadCompleted: 'Completed',
    downloadCancelled: 'Cancelled',
    downloadInterrupted: 'Interrupted',
    reveal: 'Show in folder',
    perfTitle: 'System performance',
    perfCpu: 'CPU',
    perfMemory: 'Memory',
    perfNetwork: 'Network',
    perfLast60: 'Last 60 seconds',
    perfSystemMemory: 'System memory {percent}%',
    perfRx: 'Down',
    perfTx: 'Up'
  }
}

export function s6s7Text(lang: 'zh' | 'en', key: S6S7TextKey, vars?: Record<string, string | number>): string {
  let value: string = TEXT[lang][key]
  if (vars) for (const [name, replacement] of Object.entries(vars)) value = value.replaceAll(`{${name}}`, String(replacement))
  return value
}
