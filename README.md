# DSH Launcher

[English](README.en.md) · [下载安装](https://github.com/ZhangYuanzheng1006/dsh-launcher/releases/latest) · [安装与升级指南](docs/installation.md) · [版本隔离](docs/instances.md) · [更新日志](CHANGELOG.md)

**3.2.0 · Windows 10/11 x64 · Apache-2.0（保留上游 MIT）**

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Windows Electron 桌面启动器。它把 DSH 实例、网页链接、GUI 应用、插件与运行状态集中到一个桌面窗口中管理，支持实例独立选择 DSH 运行版本，以及为网页选择独立的登录资料。

## 下载与开始使用

1. 打开本仓库的 [Releases](https://github.com/ZhangYuanzheng1006/dsh-launcher/releases/latest)，下载 `DSH-Launcher-Setup-3.2.0-x64.exe`。EXE 是安装包，无需下载源码或预装 Node.js。
2. 双击安装，选择位置；默认安装到当前 Windows 用户下，并创建桌面和开始菜单快捷方式。
3. 启动后进入「设置」，执行运行环境部署。**首次部署需要联网**，会下载 Node.js、pnpm 和官方 DSH；安装 EXE 本身不含完整 DSH 运行环境。
4. 返回实例页启动默认 DSH 实例，在 DSH 界面中配置自己的模型与 API Key。

后续升级：**退出启动器（包括托盘），直接运行新版安装 EXE，按原位置覆盖安装**。不必先卸载，启动器设置、登录资料、会话和独立运行版本存放在程序目录外。安装向导也保留这份升级说明。完整的数据路径、备份与回退步骤见 [安装与升级指南](docs/installation.md)。

安装包暂未代码签名。Windows 可能显示“未知发布者”；请核对下载来源和同一 Release 的 `SHA256SUMS.txt`。使用条件为 Windows 10/11 x64，建议至少 4 GB 内存及足够的运行环境存储空间。ARM64、macOS 和 Linux 未提供安装包。

## 上游来源

- 上游项目：[MarcoG-h/DSH-Launcher](https://github.com/MarcoG-h/DSH-Launcher)
- 基线版本：`v3.1.4`
- 本仓库是在上游 `v3.1.4` 基础上独立维护的增强分支，从 `3.2.0` 起使用本分支的版本号、更新日志与下载地址。启动器自身检查更新时仅查询本仓库 Releases。
- 感谢 MarcoG-h 发起本项目，以及 baihejiangnan 对整合包与生态的贡献。本分支不代表上游官方发行。

## 本分支新增能力

| 能力 | 说明 |
| --- | --- |
| **DSH 运行版本隔离** | 每个 DSH 实例可继承共享运行环境，也可固定一个已发布的精确版本。固定版本使用独立安装目录和独占 DSH_HOME，启动与插件命令使用同一运行版本。 |
| **Web 实例** | 支持配置启动命令、端口、健康检查路径和工作目录，启动后将 WebUI 嵌入启动器窗口。 |
| **GUI 实例** | 支持发现并接入 Typora、VSCode、Zotero、Qoder、ZCode、微信、Chrome 等桌面应用，管理启动、接管现有窗口、退出嵌入和窗口恢复。应用需由用户另行安装；兼容性随应用版本变化。 |
| **顶栏分组** | 首页和自定义分组只控制实例、链接的可见性；切换分组不复制实例，也不清理任何资料。 |
| **资料隔离** | 默认使用 Electron 旧 `defaultSession`，保留历史登录态；每个网页链接在新建或编辑时可选择「不隔离」或独立资料。组不拥有、不继承资料。 |
| **Chrome Cookie 桥** | 配套 MV3 Chrome 扩展通过 `127.0.0.1` WebSocket 与启动器通信，仅使用 `cookie.set` / `cookie.remove`，支持 `none` 和固定 Token 两种认证方式。 |
| **数字快捷键** | 支持引导键 + 数字、窗口内 `Alt` + 数字快速切换实例/链接，并在侧栏显示编号。 |
| **效率与状态** | 链接删除、favicon 自动抓取、侧栏新建/历史/下载入口、余额折叠条与 CPU/内存/网络性能面板。 |

Google/Gemini 登录请在真实 Chrome 中完成，再使用可选的 Cookie Bridge 扩展同步 Cookie。扩展写入启动器的默认资料，不同步 localStorage 或 IndexedDB，也不保证所有站点的登录状态都能迁移。Chrome 资料扫描仅发现资料名称，不会自动导入登录态。

## 文档

| 内容 | 入口 |
| --- | --- |
| 安装、覆盖升级、数据备份、卸载与常见问题 | [installation.md](docs/installation.md) |
| 实例类型、运行版本隔离与插件兼容 | [instances.md](docs/instances.md) |
| Chrome 扩展安装、权限与安全边界 | [Cookie Bridge](chrome-extension/README.md) |
| 源码开发、打包、依赖校验与发行流程 | [development.md](docs/development.md) |
| 版本变化 | [CHANGELOG.md](CHANGELOG.md) |

## 目录结构

```text
src/main/          Electron 主进程：实例、GUI、视图、桥、配置迁移
src/preload/       安全 IPC 预加载脚本
src/renderer/      React 渲染层：侧栏、顶栏、分组、资料、设置
chrome-extension/  Chrome MV3 Cookie 桥扩展
scripts/           打包与辅助脚本
tests/             Vitest 单元测试
docs/              面向用户和维护者的指南
licenses/          上游与第三方许可说明
```

## 开发命令

要求：Windows 10/11 x64，Node.js 22.19+，pnpm。普通用户只需安装 EXE；以下命令用于源码开发。

```bash
pnpm install --frozen-lockfile  # 按锁文件安装依赖
pnpm build        # 编译 main / preload / renderer
pnpm dev          # 开发调试
```

辅助命令：

```bash
pnpm test         # Vitest
pnpm typecheck    # TypeScript 类型检查
pnpm dist         # electron-builder Windows 安装包
pnpm verify:package # 校验打包资源、依赖和原生模块
```

## 数据与隐私

- 默认资料直接使用 Electron 的旧 `defaultSession`，不会自动搬迁或清空历史 Cookie。
- 独立资料使用 Electron persistent partition；资料隔离按网页链接/实例选择，不按组继承。
- Cookie 桥只监听 `127.0.0.1`，并校验 Chrome 扩展 Origin。默认免 Token；需要更严格的本机接入控制时，在设置中选择固定 Token 模式。扩展申请全部站点的 Cookie 权限，启用前请阅读权限说明。
- 本分支不附带个人 API Key 或登录资料。备份中可能含凭据，提交 Issue 前请移除配置、日志和截图中的敏感内容。
- 启动器会联网检查 DSH 版本和本仓库更新；部署运行环境、安装插件和访问网页也会联系对应服务。模型请求与费用由你选择的 DSH 配置和供应商决定。

## License

本分支的新增与修改部分采用 [Apache License 2.0](LICENSE)；上游 DSH-Launcher v3.1.4 的 MIT 许可与来源保留在 [licenses/MIT-upstream.txt](licenses/MIT-upstream.txt) 和 [NOTICE](NOTICE)。Electron、Chromium 与其它依赖各自保留其原有许可证。

上游：https://github.com/MarcoG-h/DSH-Launcher
