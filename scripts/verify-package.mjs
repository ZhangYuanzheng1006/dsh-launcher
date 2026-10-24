// Inspect and load dependencies from the actual distributable, not source modules.
import * as asar from '@electron/asar'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const resources = join(root, 'release', 'win-unpacked', 'resources')
const archive = join(resources, 'app.asar')
const entries = asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, ''))
const forbidden = /^(?:reports|memory|screenshots|scripts|tests|\.git|\.github)\/|^(?:README-ai\.md|WORKLOG\.md|secret\.json|\.env(?:\..*)?)$/i
const leaked = entries.filter(file => forbidden.test(file))
if (leaked.length) throw new Error(`Private or development files packaged: ${leaked.join(', ')}`)
for (const name of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html', 'licenses/MIT-upstream.txt']) {
  if (!entries.includes(name)) throw new Error(`Missing app file: ${name}`)
}
for (const name of ['icon.ico', 'icon.png', 'tray.png', 'tray-base.png', 'INSTALLATION.md', 'LICENSE', 'NOTICE', 'licenses/MIT-upstream.txt', 'chrome-extension/manifest.json', 'final/chrome.png']) {
  if (!existsSync(join(resources, name))) throw new Error(`Missing resource: ${name}`)
}
const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString())
const expected = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (pkg.version !== expected.version || pkg.name !== expected.name) throw new Error('Packaged identity does not match source')
const nativeEntries = entries.filter(file => file.endsWith('.node'))
if (!nativeEntries.length) throw new Error('No native modules in the archive header')
for (const file of nativeEntries) {
  if (!asar.statFile(archive, file.replaceAll('/', sep)).unpacked || !existsSync(join(`${archive}.unpacked`, file))) {
    throw new Error(`Native module not unpacked beside asar: ${file}`)
  }
}
const temp = mkdtempSync(join(tmpdir(), 'dsh-release-verify-'))
try {
  // asar.extractAll reads unpacked entries from the adjacent .unpacked tree too.
  asar.extractAll(archive, temp)
  for (const name of Object.keys(expected.dependencies)) {
    if (!existsSync(join(temp, 'node_modules', name, 'package.json'))) throw new Error(`Missing dependency: ${name}`)
  }
  // Keep the DLL handle in a child so Windows releases it before temp cleanup.
  const probe = spawnSync(process.execPath, ['-e', `
    const { createRequire } = require('node:module');
    const load = createRequire(require('node:path').join(process.cwd(), 'package.json'));
    if (typeof load('ws').WebSocketServer !== 'function') throw new Error('ws failed to load');
    const koffi = load('koffi');
    if (!koffi.version || !koffi.load('kernel32.dll')) throw new Error('koffi native module failed to load');
    process.stdout.write(JSON.stringify({ws: 'loaded', koffi: koffi.version}));
  `], { cwd: temp, encoding: 'utf8', windowsHide: true })
  if (probe.status !== 0) throw new Error(probe.stderr || probe.stdout || 'Dependency probe failed')
  const loaded = JSON.parse(probe.stdout)
  if (!readdirSync(join(resources, 'app.asar.unpacked', 'node_modules')).length) throw new Error('No unpacked native dependencies')
  console.log(JSON.stringify({ version: pkg.version, entries: entries.length, ...loaded, privateFiles: 0, resources: 'present' }))
} finally {
  // Only the freshly created temp directory is removed.
  rmSync(temp, { recursive: true, force: true })
}
