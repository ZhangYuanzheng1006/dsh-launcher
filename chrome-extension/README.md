# DSH Cookie Bridge（Chrome 扩展）

把当前 Chrome 的 Cookie 通过本机 WebSocket **单向**同步到 DSH Launcher 的默认资料（Electron `defaultSession`）。不会读取页面内容，不会模拟按键，也不会反向写 Chrome。扩展需要读取全部站点的 Cookie；启用前请确认你愿意将这些登录资料复制到启动器。

## 安装（约 1 分钟）

1. 打开 Chrome，地址栏输入 `chrome://extensions`。
2. 打开右上角 **开发者模式**。
3. 点 **加载已解压的扩展程序**。
4. 选择安装目录中的 `resources\chrome-extension`；也可从本仓库 Release 下载 `DSH-Cookie-Bridge-<版本>.zip`，解压到固定位置后选择该目录。使用源码时选择仓库的 `chrome-extension` 目录。
5. 启动 DSH Launcher，进入 **设置 → 系统 → Chrome Cookie 桥**。
6. 选择认证模式：
   - **免 Token（默认）**：localhost 连接不校验 Token，仍校验 Origin 与仅绑定 `127.0.0.1`。
   - **固定 Token**：复制设置页的固定 Token；Token 持久化在 `launcher-config.json`，重启、升级、改设置都不会变，只有手动重置才变。
7. 点击浏览器工具栏里的 **DSH Cookie Bridge** 图标。免 Token 模式把 Token 留空；固定 Token 模式粘贴 Token。
   - 端口保持默认 `17321`；只有启动器设置页显示别的端口时才改。
8. 点 **保存并连接**。状态变为 **已连接** 后会自动做一次全量 Cookie 同步；之后 Cookie 变化会以增量操作发送。
9. 需要手动重放时点 **立即同步**。
> Chrome 116+。首次加载后，扩展会自动在 offscreen document 中维护长连接；service worker 被挂起也不会断。

## 权限说明

| 权限 | 用途 |
|---|---|
| `cookies` | 读取 Cookie 并监听 `onChanged`。只发送 Cookie 操作。 |
| `storage` | 保存 Token、端口和连接状态。 |
| `alarms` | 30 秒保活检查，确保 offscreen 文档和长连接被恢复。 |
| `offscreen` | **必需**：MV3 service worker 会被挂起，WebSocket 必须由 offscreen document 承载。 |
| `host_permissions: <all_urls>` | `chrome.cookies.getAll` 读取各站点 Cookie；后续可收窄为白名单。 |

Token（如果填写）只保存在本机 `chrome.storage.local`，不会发送到公网；WebSocket 仅连接 `ws://127.0.0.1:<port>`。

## 连接与重连

- 握手：`hello { token?, client }`。免 Token 模式省略 `token` 字段；固定 Token 模式发送持久化 Token。
- 启动器返回：`hello.ok { auth, serverName }`。
- 免 Token 模式接受空 Token、旧 Token 或错误 Token；固定 Token 模式必须与启动器配置中的 Token 一致。
- 固定 Token 不因重启、升级或端口调整而改变；只有设置页手动重置 Token 才会更换。目标资料固定为默认资料，不能在扩展中切换到隔离资料。
- 断线重试用指数退避：约 1s、2s、4s、8s、16s、30s（带抖动）。
- 心跳：20 秒 ping；55 秒无 pong 主动断开并重连。
- 固定 Token 被服务端拒绝时停止重试，弹窗会提示检查或重新粘贴 Token。
## 协议（仅 Cookie ops）

连接成功后，扩展先发当前 Cookie 全集的 `cookie.set` 操作（首次同步/重连对账），并监听 `chrome.cookies.onChanged` 发送增量：

```json
{
  "protocol": "dsh-cookie-bridge",
  "protocolVersion": 1,
  "type": "cookie.set",
  "opId": "uuid",
  "ts": 1760000000000,
  "source": "chrome",
  "origin": "https://example.com",
  "name": "sid",
  "path": "/",
  "domain": ".example.com",
  "cookie": {
    "name": "sid",
    "value": "...",
    "domain": ".example.com",
    "path": "/",
    "secure": true,
    "httpOnly": true,
    "hostOnly": false,
    "sameSite": "lax",
    "expirationDate": 1760003600,
    "storeId": "0"
  },
  "reason": "change",
  "cause": "explicit"
}
```

`cookie.remove` 是同一结构，但 `cookie` 不含 `value`。启动器侧必须：

- 仅绑定 `127.0.0.1`；
- 校验 `Origin` 必须是 `chrome-extension://...`；
- `auth=none` 时跳过 Token 校验；`auth=token` 时校验持久化固定 Token；
- 写前快照，逐 op 写入启动器默认资料（`defaultSession`）；
- 不实现反向写（v1 默认单向）。


## 文件

- `manifest.json` — MV3 清单
- `background.js` — service worker：Cookie 事件、offscreen 生命周期、消息路由
- `offscreen.html/.js` — 长连接、Token 握手、重连、ops
- `popup.html/.js/.css` — Token/端口/状态/立即同步

## 故障排查

- 无法连接：确认启动器桥已启动；免 Token 模式把弹窗 Token 留空并保存。
- Token 无效：启动器处于固定 Token 模式时，粘贴设置页当前固定 Token；只有手动重置 Token 后才需要重新粘贴。
- 连接被拒绝：确认启动器桥已启动、端口一致、只监听 127.0.0.1。
- 没有同步：先点立即同步，检查启动器桥日志是否收到 cookie.set。

## 安全边界

- 扩展没有 tabs、scripting、webRequest 权限；不读取页面 DOM，不注入脚本，不模拟按键。
- 只有 Cookie 数据离开 Chrome；没有 localStorage、IndexedDB、sessionStorage 同步。
- 默认 Chrome → Launcher 单向；扩展不接受服务端下发的写入指令。
- 后端必须把固定 Token 当作秘密处理，不写入公开日志；免 Token 模式仍必须保留 Origin 校验。
