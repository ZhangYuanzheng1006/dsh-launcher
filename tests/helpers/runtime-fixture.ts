import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DshInstance, LauncherConfig } from '../../src/shared/types'
import { createDefaultProfile } from '../../src/shared/profiles'

export function instance(id: string, root: string, version?: string): DshInstance {
  return { id, name: id, profile: 'web', port: 0, autoStart: false, description: '', enabled: true,
    dshHome: join(root, 'homes', id), workspace: join(root, 'workspaces', id), ...(version ? { runtimeVersion: version } : {}) }
}

export function config(root: string, instances: DshInstance[] = []): LauncherConfig {
  return {
    configVersion: 6, groups: [], profiles: [createDefaultProfile()], instances, activeInstanceId: instances[0]?.id ?? '',
    installMode: 'source', runtimeRoot: join(root, 'runtime'), nodeVersion: '22.20.0', dshVersion: '0.2.1-rc.2',
    harnessRepo: join(root, 'source'), harnessRepoUrl: 'https://github.com/deepseek-ai/deepseek-harness.git',
    dshHome: join(root, 'shared-home'), pluginDir: join(root, 'library'), profile: 'web', port: 0,
    nodePath: process.execPath, launchArgs: ['bin.js'], buildCmd: 'pnpm build', stopOnQuit: true, pnpm: 'pnpm',
    startupTimeoutMs: 90000, language: 'zh', closeToTray: false, splashEnabled: false,
    autoStartOnLaunch: false, floatingWhale: false, marketPageSize: 30, webChats: []
  }
}

export function runtime(dir: string, version: string, body = "console.log(JSON.stringify({ version: require('../package.json').version, home: process.env.DSH_HOME, args: process.argv.slice(2) }))"): void {
  const pkg = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  writeFileSync(join(pkg, 'lib', 'bin.js'), body)
  writeFileSync(join(dir, 'launcher-runtime.json'), JSON.stringify({ version }))
}
