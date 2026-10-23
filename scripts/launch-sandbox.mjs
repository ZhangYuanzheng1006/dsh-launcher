// Launch with Electron, e.g. electron scripts/launch-sandbox.mjs --remote-debugging-port=9337.
// Creates a fresh, credential-free userData/home/runtime for every run. It never
// imports or overwrites the installed launcher's config, cookies or app.asar.
import { app } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const reuseAt = process.argv.indexOf('--qa-root')
const reuse = reuseAt >= 0
const root = reuse ? resolve(process.argv[reuseAt + 1] ?? '') : mkdtempSync(join(tmpdir(), 'dsh-launcher-qa-'))
if (reuse && (!root.startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith('dsh-launcher-qa-') || !existsSync(join(root, '.launcher-qa')))) {
  throw new Error('Only a previously created temporary QA sandbox can be reused')
}
const userData = join(root, 'userData')
const home = join(root, 'home')
const source = join(root, 'source')
const runtime = join(root, 'runtime')
for (const dir of [userData, home, source, runtime]) mkdirSync(dir, { recursive: true })
app.setName('DSH Launcher Sandbox')
app.setPath('userData', userData)
app.setPath('sessionData', userData)
process.env.DSH_HOME = home
process.env.DSH_REPO = source
const node = process.env.DSH_QA_NODE || 'node'
if (!reuse) {
writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'qa-source', version: '0.2.0' }))
writeFileSync(join(source, 'bin.js'), "console.log('QA fixture: no DSH service started'); process.exit(0)\n")
writeFileSync(join(userData, 'launcher-config.json'), JSON.stringify({
  configVersion: 6, language: 'zh', installMode: 'source', harnessRepo: source,
  runtimeRoot: runtime, dshHome: home, pluginDir: join(root, 'library'), nodePath: node,
  launchArgs: [join(source, 'bin.js')], pnpm: process.env.DSH_QA_PNPM || 'pnpm',
  autoStartOnLaunch: false, closeToTray: false, splashEnabled: false,
  hotkeys: { enabled: false, leaderKeys: [], captureCopilot: false },
  cookieBridge: { enabled: false }, webChats: [],
  instances: [{ id: 'sandbox', name: '共享运行环境', kind: 'dsh', profile: 'web', port: 0, autoStart: false, enabled: true, description: '隔离验收环境，无生产数据' }],
  activeInstanceId: 'sandbox'
}, null, 2))
writeFileSync(join(root, '.launcher-qa'), new Date().toISOString())
}
console.log(`DSH_QA_ROOT=${root}`)
console.log(`DSH_QA_REPO=${dirname(dirname(fileURLToPath(import.meta.url)))}`)
await import('../out/main/index.js')
