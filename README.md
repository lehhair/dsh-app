# dsh-app

DeepSeek Harness 桌面壳：深度内嵌 dsh 运行时（PC），渲染内容与 dsh web 完全一致。

> 当前实现为 **Tauri 2**（桌面 + Android），下方"架构"一节为历史 Electron 记录。
> 构建与发布见「构建与发布」。

## 构建与发布（Tauri）

两种发布形态由 `resources/` 里的内容决定，先 `npm run build:web`（前端已内嵌，
改前端必须重新 `cargo build` 才会进 exe）：

```powershell
# 自包含版：把官方 node.exe + .dsh-runtime + npm CLI 复制进 resources/ 再打包
npm run build:bundled

# 纯依赖 PC 版：只留 overlay，程序用系统 PATH 上的 node + 全局安装的 dsh
npm run build:external
```

- 内置版运行时定位：`resources/.dsh-runtime` → `DSH_RUNTIME` 环境变量 → 全局 npm
  （`npm root -g` 下的 `@deepseek-ai/dsh`）→ `node` on PATH。
- 外部版（`app_info.bundled === false`）：隐藏应用内 dsh 更新按钮（dsh 由用户自己的
  npm 管理，全局安装：`npm i -g @deepseek-ai/dsh`）；node 用 PATH 上的。
- **启动器自更新（GitHub Releases）**：设置环境变量 `DSH_UPDATE_OWNER` /
  `DSH_UPDATE_REPO` 后，启动页检测到更高版本的 release（tag `vX.Y.Z`，资产含
  `.exe`）时显示「更新启动器」按钮；下载、替换 exe、自动重启，只更新启动器本体，
  不重下 dsh 运行时。未设置环境变量时该功能静默关闭。
- 内置版的 dsh 运行时更新走应用内「检查更新」（npm 更新 resources/.dsh-runtime）。

## 跨平台（Windows / macOS / Linux）

- 每个平台在**各自的操作系统上构建**（`build:bundled` / `build:external` 同上），
  `bundle.targets: "all"` 会让 Tauri 产出该平台的安装包：Windows nsis+msi、macOS
  app+dmg、Linux deb+rpm+appimage。`bundle-resources.mjs` 会把**当前平台**的官方
  node 二进制（`node.exe` / `node`，来自运行脚本的 node，可用 `DSH_NODE` 覆盖）和
  `.dsh-runtime` 打进 resources/——`.dsh-runtime` 含平台相关原生模块，必须在目标
  平台上装好。
- 标题栏：Windows/Linux 无边框 + 网页自绘窗口按钮（右端）；macOS 保留原生红绿灯
  （`TitleBarStyle::Overlay` + `hiddenTitle`），网页标题栏左侧留出红绿灯空间并隐藏
  自绘按钮（前端按 `app_info.platform` 适配）。
- 启动器自更新：Windows 用 .cmd 换 exe；macOS/Linux 用 `sh` 等进程退出后
  `mv` + 重启（未在真机验证，发布前需各平台实测）。

## Android

- 启动页即 PC 版去掉本机实例/标题栏，只留远程节点；状态栏沉浸
  （edge-to-edge）：页面背景延伸到状态栏下方（融合），内容按原生状态栏高度
  留白（`status_bar_height`，WebView<140 的 env() 不可靠），状态栏图标深浅
  色跟随日/夜主题（uiMode 轮询——该设备上 uiMode 回调会静默）。
- 远程登录：`auth.rs` 网关登录拿 cookie → Kotlin `DshNativePlugin.setCookie`
  写全局 WebView CookieManager（wry 的 set_cookie 在安卓是 no-op）。
- 手工构建（本机无 Developer Mode，CLI 的符号链接步骤会失败）：
  ```powershell
  $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = '<ndk>\toolchains\llvm\prebuilt\windows-x86_64\bin\aarch64-linux-android24-clang.cmd'
  cargo build --release --target aarch64-linux-android   # 必须 release（或开 devUrl 的 dev 流程）
  # 复制 target/aarch64-linux-android/release/libdsh_app_lib.so → gen/android/app/src/main/jniLibs/arm64-v8a/
  cd gen/android; .\gradlew.bat :app:assembleArm64Release -x rustBuildUniversalRelease -x rustBuildArm64Release
  # release 未签名，用 apksigner 签名后 adb install -r
  ```
  注意：tauri 必须启用 **`custom-protocol` feature**（见 Cargo.toml）——否则移动端
  `dev` cfg 恒为 true，前端协议走"开发服务器代理"（`proxy_dev_request`），没有 devUrl
  时每个资源请求都 500（白屏）。桌面端不受影响（代理路径仅 mobile 编译）。

## 架构（历史 Electron 记录）

早期版本是 Electron 壳（`main.js` / `preload.js` / `shell.html`），Tauri 迁移后已全部删除；
当前实现为 Tauri 2（`web/` 前端 + `src-tauri/`），窗口/标题栏/嵌入 dsh 的机制见顶部
「构建与发布（Tauri）」。

## 为什么内嵌 dsh 必须用官方 Node，而不是 Electron 内置 Node

实测结论（本仓库验证过程）：dsh 解析 profile 安装的插件（`dsh-remote-gateway`、`@dsh-external/*`）
走 `ModuleLoader.fromInternal()`（cordis-plugin-loader）：通过 `node-addon-require-builtin` 加载 Node
内部模块 `internal/modules/esm/loader` 的 `getOrInitializeCascadedLoader()`，把内部 ESM loader 当作
`loader.internal` 从 profile 的 baseUrl 解析裸包。**Electron 的 Node 内核没有这个 internal API**
（ESM loader 集成被修补过），导致 internal 缺失、profile 插件全部 `ERR_MODULE_NOT_FOUND`。
这是结构性不兼容，不是配置问题。诊断脚本证明两个执行器的常规 `createRequire` 解析能力完全一致，
差异只在该 internal API。

因此：壳只当窗口/进程管理，dsh 运行时始终跑在官方 Node 上（Tauri 版同样如此，
bundled 版自带官方 node，external 版用系统 node）。

## 已验证（历史 Electron 记录）

- 壳 spawn 官方 node + npm 版 dsh：HTTP 200、`__DSH_BOOT__` 注入、`/api/events.mux` WS 握手通过
- 关窗/退出：`taskkill /T /F` 杀进程树，无端口/进程泄漏

## 已知限制与下一版

- **远程节点（已完成）**：直连网关 origin，主进程预登录（`POST /_gateway/login` 取
  `Set-Cookie`）→ 写入 view session（HttpOnly + SameSite=Strict + 7 天）→ 直接加载网关
  URL。fetch 与 WebSocket 都自动携带 cookie；origin 稳定，Chromium 磁盘缓存自然生效。
  同 host 多端口网关的 cookie 会互相覆盖——每次连接都重新预登录刷新（一次 ~ms POST）。
- 内嵌实例默认 disable remote-gateway（overlay）：本机使用不需要再包一层网关；
  远程访问走独立网关实例（8443）
