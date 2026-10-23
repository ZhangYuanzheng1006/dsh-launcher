# 开发、打包与发行

## 开发环境

Windows 10/11 x64、Node.js 22.19+、pnpm 11.21.0。Electron 首次安装和运行环境部署需要联网。项目锁文件固定依赖解析；不要用临时删除锁文件的方式排错。

```powershell
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm test
pnpm build
```

`src/main` 为 Electron 主进程，`src/preload` 为 IPC 桥，`src/renderer` 为 React UI，`src/shared` 为类型与纯逻辑。`tests` 包含迁移、配置恢复、运行版本选择、真实子进程生命周期及桥协议回归。

## 构建可分发安装包

```powershell
pnpm dist
pnpm verify:package
```

`dist` 显式禁止 electron-builder 自动发布，生成这些产物：

| 文件 | 用途 |
| --- | --- |
| `release/DSH-Launcher-Setup-<版本>-x64.exe` | 面向普通用户的完整 NSIS 安装 EXE。 |
| `release/DSH-Cookie-Bridge-<版本>.zip` | 可选扩展，解压后由 Chrome 加载。 |
| `release/SHA256SUMS.txt` | EXE 和扩展 ZIP 的 SHA-256。 |
| `release/win-unpacked/` | 本地打包检查目录，不作为普通用户下载入口。 |

包内包含程序、原生依赖、图标、扩展、安装指南和许可证；不包含开发文档、测试、个人配置、DSH 完整运行环境或用户数据。`verify:package` 检查实际 asar、资源和版本，并在临时目录加载包内 `ws` 与 `koffi` 原生库。最终仍应以真实安装冒烟为准。

`pnpm pack:asar` 是维护已有本机安装的直接替换工具，会操作目标安装目录；普通用户更新请运行新版 Setup EXE。不要用它代替发行包验收。

## 安装身份与更新约定

后续发行必须保持这些值，才能覆盖升级并找到原用户数据：

| 值 | 固定内容 |
| --- | --- |
| package name / userData | `dsh-launcher` / `%APPDATA%\dsh-launcher` |
| productName | `DSH Launcher` |
| appId | `com.marcog.dsh-launcher` |
| NSIS GUID | `d1c0ec62-e192-517b-904e-0d6cd286549d`（原 appId 派生值） |
| 默认安装范围 | 当前用户；后续升级沿用原位置。 |

`build/installer.nsh` 提供中英文安装/升级欢迎页。保留 `deleteAppDataOnUninstall=false`，不添加清理 userData、DSH_HOME 或运行环境的安装钩子。不要将这些数据写入程序安装目录。

启动器更新检查读取 `package.json` 的 GitHub `repository.url`，仅接受该仓库的稳定 Release；不自动下载或安装。将来创建自己的 fork 时，先修改该字段以及 README、Issue 和下载链接，再构建。DSH 运行环境更新是独立功能。

## 发行步骤

1. 更新 `package.json` 版本号、`CHANGELOG.md`、中英文下载说明及相关指南。
2. 跑类型检查、测试、`pnpm dist`、`pnpm verify:package`；在与日常环境隔离的 Windows 用户中验证首次安装、旧版→新版覆盖升级、设置/资料保留、卸载保留数据。
3. 阅读准备公开的完整文件树，排除内部记录、截图中的个人资料、配置、密钥与构建缓存。旧设计与本机验收记录保留在内部归档中。
4. 按仓库的内部备份与公网发布流程保存源码。维护本工作区时使用 `gittb -githubremote commit` 生成经扫描和剥离的单提交公开快照，并遵守其冷却确认；不要用构建工具绕过该流程。
5. 基于**已发布的公开提交**创建同版本 Release 标签，例如 `v3.2.0`，附变化说明，上传 EXE、扩展 ZIP 和 `SHA256SUMS.txt`。EXE 不放进源码 Git 历史。
6. 核对 Release 下载链接、文件大小、哈希与公开文件树，确认没有内部工作日志或资料，再将下载地址交给用户。

CI 只运行检查、打包并上传 workflow artifacts，不自动发布 Release。代码签名尚未接入；接入后应在签名完成后生成最终校验和，并重新验收。

## 贡献与问题反馈

请提供版本、Windows 版本、复现步骤和已去除敏感内容的日志。涉及运行版本隔离时，同时给出 DSH 与插件的精确版本。新增与修改内容按 Apache-2.0 提交，并保留上游 MIT 与其它第三方许可说明。
