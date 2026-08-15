# dsh-app

DeepSeek Harness 桌面壳：深度内嵌 dsh 运行时（PC），渲染内容与 dsh web 完全一致。

## 架构

```
dsh-app (Electron 43)
├─ resources/node.exe         官方 Node 24（打包时放入；dev 用系统 PATH 里的 node）
├─ .dsh-runtime/              npm 包 @deepseek-ai/dsh（内嵌 dsh 运行时，可重装）
├─ main.js                    壳主进程：随机端口 / spawn dsh / health / 杀进程树 / 窗口 / ipc
├─ preload.js                 launcher 桥（仅 file:// 页面暴露，远程页面无 API）
├─ shell.html                 壳 UI：自定义标题栏（拖拽 + 窗口按钮）+ launcher 面板
└─ embedded-overlay.yml       内嵌 overlay：disable remote-gateway（避免抢占系统网关 8443）
```

窗口结构：无边框 BrowserWindow（`frame: false`）运行壳 UI——自绘标题栏（`-webkit-app-region: drag`
拖拽区 + 最小化/最大化/关闭按钮，最大化状态经 IPC 同步双态图标）与 launcher 面板；连接的 dsh web
渲染在 **WebContentsView**（位于标题栏下方，完整视口不被遮挡，内容与 dsh web 完全一致）。

内嵌运行：`node.exe lib/bin.js --patch embedded-overlay.yml --profile web --port <随机空闲端口>`，
与 `npx dsh` 完全等价（原汁原味）。WebContentsView 加载 `http://127.0.0.1:<port>/`。

## 为什么内嵌 dsh 必须用官方 Node，而不是 Electron 内置 Node

实测结论（本仓库验证过程）：dsh 解析 profile 安装的插件（`dsh-remote-gateway`、`@dsh-external/*`）
走 `ModuleLoader.fromInternal()`（cordis-plugin-loader）：通过 `node-addon-require-builtin` 加载 Node
内部模块 `internal/modules/esm/loader` 的 `getOrInitializeCascadedLoader()`，把内部 ESM loader 当作
`loader.internal` 从 profile 的 baseUrl 解析裸包。**Electron 的 Node 内核没有这个 internal API**
（ESM loader 集成被修补过），导致 internal 缺失、profile 插件全部 `ERR_MODULE_NOT_FOUND`。
这是结构性不兼容，不是配置问题。诊断脚本证明两个执行器的常规 `createRequire` 解析能力完全一致，
差异只在该 internal API。

因此：Electron 只当壳（窗口 / 进程管理 / 注册表 / keyring），dsh 运行时始终跑在官方 Node 上。

## 运行

```powershell
npm install                        # 已含 electron；如 .dsh-runtime 缺失：
npm install --prefix .dsh-runtime @deepseek-ai/dsh@0.1.0-rc.6 --no-audit --no-fund

npm start                          # 启动壳 → launcher → 点"启动内嵌 dsh"
npm run start:autostart            # 启动壳并自动拉起内嵌 dsh（开发用）
```

## 已验证

- 壳 spawn 官方 node + npm 版 dsh：HTTP 200、`__DSH_BOOT__` 注入、`/api/events.mux` WS 握手通过
- 关窗/退出：`taskkill /T /F` 杀进程树，无端口/进程泄漏
- 系统 `~/.dsh/profiles/web`（含 remote-gateway 等用户插件）在官方 Node 下正常加载
- 自定义标题栏：无边框窗口 + 拖拽区 + 窗口按钮（最小化/最大化/关闭），dsh web 在
  WebContentsView 完整视口渲染，不受标题栏遮挡

## 已知限制与下一版

- **远程节点（已完成）**：直连网关 origin，主进程预登录（`POST /_gateway/login` 取
  `Set-Cookie`）→ 写入 view session（HttpOnly + SameSite=Strict + 7 天）→ 直接加载网关
  URL。fetch 与 WebSocket 都自动携带 cookie；origin 稳定，Chromium 磁盘缓存自然生效。
  同 host 多端口网关的 cookie 会互相覆盖——每次连接都重新预登录刷新（一次 ~ms POST）。
- **设置注入**：`dsh-app-shell` 插件把"桌面客户端"设置 section 注入连接的 dsh 设置页
- **打包**：electron-builder + `resources/node.exe`（官方 Node 24 二进制）+ `.dsh-runtime` 进包
- **内嵌 dsh 更新**：随壳发版（简单）或独立更新通道（后续）
- 内嵌实例默认 disable remote-gateway（overlay）：本机使用不需要再包一层网关；
  远程访问走独立网关实例（8443）
