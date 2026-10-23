// Assemble the downloadable extension and checksums without publishing anything.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const release = join(root, 'release')
const installer = `DSH-Launcher-Setup-${version}-x64.exe`
const extension = `DSH-Cookie-Bridge-${version}.zip`
const files = readdirSync(join(root, 'chrome-extension')).filter(name => /\.(?:json|js|html|css|md)$/.test(name))
const psQuote = value => `'${value.replaceAll("'", "''")}'`
const compress = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath @(${files.map(name => psQuote(join(root, 'chrome-extension', name))).join(',')}) -DestinationPath ${psQuote(join(release, extension))} -Force`
], { encoding: 'utf8', windowsHide: true })
if (compress.status !== 0) throw new Error(compress.stderr || compress.stdout || 'Extension archive failed')
const artifacts = [installer, extension]
writeFileSync(join(release, 'SHA256SUMS.txt'), artifacts.map(file => `${createHash('sha256').update(readFileSync(join(release, file))).digest('hex')}  ${file}`).join('\n') + '\n')
console.log(`Release ${version}: ${artifacts.join(', ')}, SHA256SUMS.txt`)
