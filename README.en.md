# DSH Launcher

[中文](README.md) · [Download](https://github.com/ZhangYuanzheng1006/dsh-launcher/releases/latest) · [Installation and upgrades](docs/installation.md) · [Runtime isolation](docs/instances.md) · [Changelog](CHANGELOG.md)

**3.2.0 · Windows 10/11 x64 · Apache-2.0 with retained upstream MIT notices**

A Windows desktop hub for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Manage DSH instances, web applications, desktop apps, plugins and browser profiles in one window. Pin an exact DSH version per instance or inherit the shared runtime.

This independent enhanced distribution builds on [MarcoG-h/DSH-Launcher](https://github.com/MarcoG-h/DSH-Launcher) v3.1.4. Thanks to MarcoG-h and baihejiangnan for the original project and plugin ecosystem. Releases and update checks for this fork use **this repository**.

## Download and install

1. Download `DSH-Launcher-Setup-3.2.0-x64.exe` from [Releases](https://github.com/ZhangYuanzheng1006/dsh-launcher/releases/latest). No source checkout or preinstalled Node.js is required.
2. Run Setup. It installs for the current Windows user and creates desktop and Start menu shortcuts.
3. Open Settings and deploy the runtime. **Initial deployment requires internet access** to download portable Node.js, pnpm and official DSH packages. The Setup EXE does not contain a full offline DSH runtime.
4. Start the default DSH instance and configure your own model provider and API key in DSH.

For future updates, quit the launcher, including its tray icon, and **run the new Setup EXE over the existing installation**. Do not uninstall first. Setup reuses the existing installation and preserves data stored outside the program directory. The installer includes these upgrade instructions. See the [installation guide](docs/installation.md) for backup and recovery paths.

The installer is currently unsigned; Windows may display an unknown-publisher prompt. Verify the download source and the Release's `SHA256SUMS.txt`. Windows 10/11 x64 and at least 4 GB RAM are recommended. No ARM64, macOS or Linux installer is provided.

## Features

| Feature | Behavior |
| --- | --- |
| DSH instances | Start and stop instances independently, assign ports and homes, view logs and manage plugins. |
| Per-instance DSH versions | Pin an exact published version with its own installation and exclusive DSH_HOME; launch and plugin commands use the same runtime. Shared-runtime upgrades do not replace pinned installations. |
| Web instances | Configure a command, working directory, port and health-check path, then open the local UI in the launcher. |
| Desktop apps | Discover installed applications, adopt existing windows, detach while keeping the process alive, and manage supported app windows. Compatibility depends on each app version. |
| Groups and links | Control visibility without duplicating instances or restarting them; access history, downloads and new tabs. |
| Browser profiles | Choose the legacy default session or a separate persistent profile for each link. Groups do not own profiles. Chrome profile scanning discovers names only. |
| Chrome Cookie Bridge | Optional one-way Chrome-to-launcher Cookie sync into the default session, through localhost WebSocket with optional fixed-token authentication. |
| Desktop tools | Shortcuts, tray controls, balance display and CPU/memory/network information. |

Google/Gemini sign-in takes place in real Chrome. Cookie Bridge does not transfer localStorage or IndexedDB and cannot guarantee that every website's login state will work in Electron. Read the [extension permissions and limitations](chrome-extension/README.md) before enabling it.

## Documentation

- [Installation, upgrade, backup, uninstall and troubleshooting](docs/installation.md) (Chinese)
- [Instances, runtime version isolation and plugin compatibility](docs/instances.md) (Chinese)
- [Chrome extension setup and security boundary](chrome-extension/README.md) (Chinese)
- [Development, packaging and release process](docs/development.md) (Chinese)
- [Changelog](CHANGELOG.md)

## Build from source

Use Windows x64, Node.js 22.19+ and pnpm 11.21.0:

```powershell
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm test
pnpm dist
pnpm verify:package
```

`pnpm dist` creates the NSIS installer, the extension ZIP and checksums in `release/`. It does not publish. `pnpm build` compiles to `out/`. The maintenance-only `pack:asar` command directly replaces an existing local installation; it is not the user upgrade path.

## Data and privacy

Launcher configuration and browser profiles live under `%APPDATA%\dsh-launcher`; default DSH data is under `%USERPROFILE%\.dsh`, runtime installations under `%USERPROFILE%\.dsh-runtime`, and the plugin library under `%USERPROFILE%\DSH-Plugin`. Configured custom paths take precedence.

No personal API keys or accounts are included. Version checks contact the DSH registry and this repository; deployment, plugins and embedded sites contact their respective services. Cookie Bridge binds only to `127.0.0.1` and validates extension origins. It requests access to all sites' Cookies; use fixed-token mode for stricter local enrollment control. Backups may contain credentials—sanitize Issue reports and screenshots.

## License

New contributions and modifications are distributed under [Apache License 2.0](LICENSE). The upstream v3.1.4 MIT attribution and permission notice are retained in [licenses/MIT-upstream.txt](licenses/MIT-upstream.txt) and [NOTICE](NOTICE). Electron, Chromium and other dependencies retain their own licenses.
