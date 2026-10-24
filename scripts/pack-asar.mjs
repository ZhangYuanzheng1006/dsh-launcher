#!/usr/bin/env node
// Repack the installed DSH Launcher app.asar from this checkout, including every
// production dependency declared in package.json and its transitive closure. Native
// .node files are unpacked beside the archive for Electron to load.
//
// Packaged layout required by Electron:
//   resources/app.asar/node_modules/<dependency>/...              (JavaScript + metadata)
//   resources/app.asar.unpacked/node_modules/.../*.node           (native addons)
//
// Dependencies are staged in isolated nested node_modules trees, so different
// package versions cannot overwrite each other. Electron redirects an asar path
// marked "unpacked" to the sibling app.asar.unpacked tree.

import asar from '@electron/asar'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

function usage() {
  console.log(`Usage: node scripts/pack-asar.mjs [options]

Options:
  --app-dir <path>   Installed launcher directory
                     (default: %LOCALAPPDATA%\\Programs\\DSH Launcher)
  --force-close      Force-close running processes whose executable is the
                     exact installed DSH Launcher.exe
  --no-build         Reuse the existing out/ directory instead of running pnpm build
  --keep-temp        Keep the temporary extraction/packing directory
  --help             Show this help`)
}

function parseArgs(argv) {
  const opts = { forceClose: false, keepTemp: false, skipBuild: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    } else if (arg === '--force-close') {
      opts.forceClose = true
    } else if (arg === '--keep-temp') {
      opts.keepTemp = true
    } else if (arg === '--no-build') {
      opts.skipBuild = true
    } else if (arg === '--app-dir') {
      const value = argv[++i]
      if (!value) throw new Error('--app-dir requires a value')
      opts.appDir = value
    } else if (arg.startsWith('--app-dir=')) {
      opts.appDir = arg.slice('--app-dir='.length)
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }
  return opts
}

function log(message) {
  console.log(`[pack-asar] ${message}`)
}

function fail(message) {
  throw new Error(message)
}

function uniquePath(base) {
  if (!existsSync(base)) return base
  const ext = base.endsWith('.asar.unpacked') ? '.asar.unpacked' : ''
  const stem = ext ? base.slice(0, -ext.length) : base
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!existsSync(candidate)) return candidate
  }
}

function timestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function findFiles(root, predicate) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && predicate(full)) out.push(full)
    }
  }
  walk(root)
  return out
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function runningPids(exePath) {
  if (process.platform !== 'win32' || !existsSync(exePath)) return []
  const command = `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -ieq ${psQuote(exePath)} } | ForEach-Object { $_.ProcessId }) -join ','`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status !== 0) {
    fail(`Could not inspect running processes: ${result.stderr || result.stdout || result.status}`)
  }
  return result.stdout.trim().split(',').map((value) => Number(value)).filter((pid) => Number.isInteger(pid) && pid > 0)
}

function ensureAppStopped(exePath, forceClose) {
  let pids = runningPids(exePath)
  if (pids.length === 0) return
  if (!forceClose) {
    fail(`DSH Launcher is running (PIDs: ${pids.join(', ')}). Close it or use --force-close.`)
  }
  log(`Closing running launcher PIDs: ${pids.join(', ')}`)
  for (const pid of pids) {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
  }
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    pids = runningPids(exePath)
    if (pids.length === 0) return
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 200'], {
      windowsHide: true,
      stdio: 'ignore'
    })
  }
  fail(`DSH Launcher is still running after close attempt (PIDs: ${pids.join(', ')}).`)
}

function copyFileEnsured(src, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
}

const LOAD_CHECK_PACKAGES = ['ws', 'koffi']

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function resolveInstalledPackage(name, fromDir) {
  let current = fromDir
  try {
    current = realpathSync(fromDir)
  } catch {
    // The caller passes real package directories; keep the fallback for root.
  }
  for (;;) {
    const candidate = join(current, 'node_modules', ...name.split('/'))
    const manifestPath = join(candidate, 'package.json')
    if (existsSync(manifestPath)) {
      return {
        name,
        dir: realpathSync(candidate),
        manifest: readJsonFile(manifestPath)
      }
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function installRuntimePackage(name, fromDir, destinationModules, stack, optional, collected) {
  const resolved = resolveInstalledPackage(name, fromDir)
  if (!resolved) {
    if (optional) return null
    fail(`Missing production dependency ${name} while resolving ${fromDir}`)
  }
  if (stack.has(resolved.dir)) return resolved

  const destination = join(destinationModules, ...name.split('/'))
  if (existsSync(join(destination, 'package.json'))) {
    const existing = readJsonFile(join(destination, 'package.json'))
    if (existing.version !== resolved.manifest.version) {
      fail(
        `Conflicting versions for ${name}: ${existing.version} already staged, ` +
        `${resolved.manifest.version} required by ${fromDir}`
      )
    }
    return resolved
  }

  mkdirSync(dirname(destination), { recursive: true })
  cpSync(resolved.dir, destination, { recursive: true, force: true, dereference: true })
  collected.push({
    name,
    version: String(resolved.manifest.version ?? '0.0.0'),
    source: resolved.dir,
    destination
  })

  const nestedModules = join(destination, 'node_modules')
  const requiredNames = new Set(Object.keys(resolved.manifest.dependencies ?? {}))
  const optionalNames = Object.keys(resolved.manifest.optionalDependencies ?? {})
    .filter((child) => !requiredNames.has(child))

  const nextStack = new Set(stack)
  nextStack.add(resolved.dir)
  for (const child of requiredNames) {
    installRuntimePackage(child, resolved.dir, nestedModules, nextStack, false, collected)
  }
  for (const child of optionalNames) {
    installRuntimePackage(child, resolved.dir, nestedModules, nextStack, true, collected)
  }
  return resolved
}

function copyRuntimeDependencies(stageDir) {
  const rootManifest = readJsonFile(join(repoRoot, 'package.json'))
  const directNames = Object.keys(rootManifest.dependencies ?? {})
  if (directNames.length === 0) fail('package.json has no production dependencies to pack')

  const modules = join(stageDir, 'node_modules')
  rmSync(modules, { recursive: true, force: true })
  mkdirSync(modules, { recursive: true })

  const collected = []
  const roots = []
  for (const name of directNames) {
    const resolved = installRuntimePackage(name, repoRoot, modules, new Set(), false, collected)
    if (!resolved) fail(`Required direct dependency ${name} was not found`)
    roots.push({ name, version: String(resolved.manifest.version ?? '0.0.0') })
  }

  for (const required of LOAD_CHECK_PACKAGES) {
    if (!existsSync(join(modules, ...required.split('/'), 'package.json'))) {
      fail(`Required runtime dependency ${required} is missing from the packed node_modules`)
    }
  }

  return { directNames, roots, collected }
}

function requireDependencies(fromDir, names = LOAD_CHECK_PACKAGES) {
  const code = `
    const names = JSON.parse(process.env.PACK_REQUIRE_NAMES);
    const loaded = {};
    for (const name of names) {
      const mod = require(name);
      if (name === 'ws') {
        if (typeof mod.WebSocketServer !== 'function') throw new Error('ws WebSocketServer export is missing');
        loaded[name] = 'loaded';
      } else if (name === 'koffi') {
        if (typeof mod.version !== 'string' || !mod.version) throw new Error('koffi version export is missing');
        loaded[name] = mod.version;
      } else {
        loaded[name] = 'loaded';
      }
    }
    process.stdout.write(JSON.stringify(loaded));
  `
  const result = spawnSync(process.execPath, ['-e', code], {
    cwd: fromDir,
    env: { ...process.env, PACK_REQUIRE_NAMES: JSON.stringify(names) },
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status !== 0) {
    fail(`post-pack require(${names.join(', ')}) failed from ${fromDir}: ${result.stderr || result.stdout || result.status}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    fail(`Could not parse dependency load check output: ${result.stdout}`)
  }
}

function findAsarEntry(header, relativePath) {
  let node = header
  for (const part of relativePath.replaceAll('\\', '/').split('/').filter(Boolean)) {
    if (!node || !node.files || !node.files[part]) return null
    node = node.files[part]
  }
  return node
}

function verifyArchive(archivePath, stageDir, directNames) {
  const raw = asar.getRawHeader(archivePath)
  for (const name of directNames) {
    const packageEntry = join('node_modules', ...name.split('/'), 'package.json')
    if (!findAsarEntry(raw.header, packageEntry)) {
      fail(`Production dependency ${name} is missing from the asar header`)
    }
  }
  if (!findAsarEntry(raw.header, 'out/main/index.js')) fail('out/main/index.js is missing from the asar')

  const nativeFiles = findFiles(join(stageDir, 'node_modules'), (file) => file.endsWith('.node'))
  if (nativeFiles.length === 0) fail('No native .node module was staged')
  const unpacked = []
  for (const file of nativeFiles) {
    const rel = relative(stageDir, file)
    const entry = findAsarEntry(raw.header, rel)
    if (!entry) fail(`Native module entry is missing from the asar header: ${rel}`)
    if (entry.unpacked !== true) fail(`Native module entry is not marked unpacked: ${rel}`)
    const unpackedFile = join(`${archivePath}.unpacked`, rel)
    if (!existsSync(unpackedFile)) fail(`Unpacked native module is missing: ${unpackedFile}`)
    unpacked.push(rel)
  }
  return unpacked
}

function verifyPackedDependencies(archivePath, verifyDir, names = LOAD_CHECK_PACKAGES) {
  rmSync(verifyDir, { recursive: true, force: true })
  asar.extractAll(archivePath, verifyDir)
  const unpacked = `${archivePath}.unpacked`
  if (existsSync(unpacked)) {
    cpSync(unpacked, verifyDir, { recursive: true, force: true, dereference: true })
  }
  return requireDependencies(verifyDir, names)
}
function replaceFileAtomically(nextPath, finalPath) {
  const oldPath = `${finalPath}.old-tmp`
  rmSync(oldPath, { force: true })
  renameSync(finalPath, oldPath)
  try {
    renameSync(nextPath, finalPath)
  } catch (error) {
    renameSync(oldPath, finalPath)
    throw error
  }
  rmSync(oldPath, { force: true })
}

function replaceDirectory(nextPath, finalPath) {
  const oldPath = `${finalPath}.old-tmp`
  rmSync(oldPath, { recursive: true, force: true })
  if (existsSync(finalPath)) renameSync(finalPath, oldPath)
  try {
    renameSync(nextPath, finalPath)
  } catch (error) {
    if (existsSync(oldPath)) renameSync(oldPath, finalPath)
    throw error
  }
  rmSync(oldPath, { recursive: true, force: true })
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const appDir = resolve(opts.appDir ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DSH Launcher'))
  const exePath = join(appDir, 'DSH Launcher.exe')
  const resourcesDir = join(appDir, 'resources')
  const oldAsar = join(resourcesDir, 'app.asar')
  const oldUnpacked = `${oldAsar}.unpacked`
  const outDir = join(repoRoot, 'out')

  if (!existsSync(oldAsar)) fail(`Installed app.asar is missing: ${oldAsar}`)
  if (!opts.skipBuild) {
    log('running pnpm build')
    const isWin = process.platform === 'win32'
    const build = spawnSync(
      isWin ? (process.env.ComSpec || 'cmd.exe') : 'pnpm',
      isWin ? ['/d', '/s', '/c', 'pnpm build'] : ['build'],
      { cwd: repoRoot, stdio: 'inherit', windowsHide: true }
    )
    if (build.error) fail(`pnpm build failed: ${build.error.message}`)
    if (build.status !== 0) fail(`pnpm build failed with exit code ${build.status}`)
  }
  if (!existsSync(outDir)) fail(`Built out/ directory is missing: ${outDir}`)
  ensureAppStopped(exePath, opts.forceClose)


  const stamp = timestamp()
  const asarBackup = uniquePath(join(resourcesDir, `app.asar.bak-${stamp}`))
  const unpackedBackup = uniquePath(join(resourcesDir, `app.asar.unpacked.bak-${stamp}`))
  copyFileSync(oldAsar, asarBackup)
  if (existsSync(oldUnpacked)) {
    cpSync(oldUnpacked, unpackedBackup, { recursive: true, force: true, dereference: true })
  }
  log(`backup: ${asarBackup}`)
  if (existsSync(oldUnpacked)) log(`backup: ${unpackedBackup}`)

  const finalSource = join(repoRoot, 'final')
  if (!existsSync(finalSource)) fail(`Bundled final/ icon directory is missing: ${finalSource}`)
  const finalDest = join(resourcesDir, 'final')
  const finalBackup = uniquePath(join(resourcesDir, `final.bak-${stamp}`))
  if (existsSync(finalDest)) {
    cpSync(finalDest, finalBackup, { recursive: true, force: true, dereference: true })
    log(`backup: ${finalBackup}`)
  }

  const workDir = mkdtempSync(join(tmpdir(), 'dsh-launcher-pack-'))
  const stageDir = join(workDir, 'app')
  const builtAsar = join(workDir, 'app.asar')
  try {
    log(`extracting ${oldAsar}`)
    asar.extractAll(oldAsar, stageDir)

    log('replacing out/ and package.json')
    rmSync(join(stageDir, 'out'), { recursive: true, force: true })
    cpSync(outDir, join(stageDir, 'out'), { recursive: true, force: true, dereference: true })
    copyFileEnsured(join(repoRoot, 'package.json'), join(stageDir, 'package.json'))

    log('copying production dependency closure from package.json')
    const dependencies = copyRuntimeDependencies(stageDir)
    log(`direct dependencies: ${dependencies.roots.map((entry) => `${entry.name}@${entry.version}`).join(', ')}`)
    log(`copied ${dependencies.collected.length} packages including transitive dependencies`)
    const stagedLoads = requireDependencies(stageDir)
    log(`staged require('ws') + require('koffi') OK (${JSON.stringify(stagedLoads)})`)

    log('packing app.asar (unpack: *.node)')
    rmSync(builtAsar, { force: true })
    rmSync(`${builtAsar}.unpacked`, { recursive: true, force: true })
    await asar.createPackageWithOptions(stageDir, builtAsar, { dot: true, unpack: '*.node' })

    const unpackedNative = verifyArchive(builtAsar, stageDir, dependencies.directNames)
    log(`archive verification OK; unpacked native files: ${unpackedNative.join(', ')}`)
    const packedLoads = verifyPackedDependencies(builtAsar, join(workDir, 'verify-app'))
    log(`post-pack require('ws') + require('koffi') OK (${JSON.stringify(packedLoads)})`)

    ensureAppStopped(exePath, opts.forceClose)

    const nextAsar = join(resourcesDir, 'app.asar.next')
    const nextUnpacked = join(resourcesDir, 'app.asar.unpacked.next')
    const nextFinal = join(resourcesDir, 'final.next')
    rmSync(nextAsar, { force: true })
    rmSync(nextUnpacked, { recursive: true, force: true })
    rmSync(nextFinal, { recursive: true, force: true })
    copyFileSync(builtAsar, nextAsar)
    if (existsSync(`${builtAsar}.unpacked`)) {
      cpSync(`${builtAsar}.unpacked`, nextUnpacked, { recursive: true, force: true, dereference: true })
      replaceDirectory(nextUnpacked, oldUnpacked)
    } else {
      fail('Packed archive did not produce an app.asar.unpacked directory')
    }
    cpSync(finalSource, nextFinal, { recursive: true, force: true, dereference: true })
    replaceDirectory(nextFinal, finalDest)
    replaceFileAtomically(nextAsar, oldAsar)

    const installedNatives = verifyArchive(oldAsar, stageDir, dependencies.directNames)
    log(`installed: ${oldAsar} (${statSync(oldAsar).size} bytes)`)
    log(`installed production dependencies verified; native files: ${installedNatives.join(', ')}`)
    log('installed archive OK: ws and koffi are present in the dependency closure')
    log('done. Launch with: Start-Process explorer.exe -ArgumentList \'"<installed>\\DSH Launcher.exe"\'')
  } finally {
    if (opts.keepTemp) {
      log(`kept temp dir: ${workDir}`)
    } else {
      rmSync(workDir, { recursive: true, force: true })
    }
  }
}

main().catch((error) => {
  console.error(`[pack-asar] ERROR: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
