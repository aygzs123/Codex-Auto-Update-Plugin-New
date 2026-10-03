# Codex Updater Desktop

Codex 的一键安装器：Electron + React + TypeScript + Vite，打包成单个 Windows
NSIS `.exe`。不需要 Rust 或 Cargo，也不需要用户先装好插件。

## 开发

```powershell
cd desktop
npm install
npm run electron:dev
```

仅预览浏览器 UI（下载、安装和签名动作走模拟流程）：

```powershell
npm run dev
```

## 构建 Windows EXE

```powershell
npm run electron:build
```

安装包输出到 `desktop/release/`，默认是当前用户安装的 NSIS `.exe`
（不需要管理员权限）。应用图标是代码生成的（`resources/icon.ico`，七个尺寸、32 位
DIB 条目），改了 `scripts/make-icon.cjs` 之后跑 `npm run icon:make` 重建，并把产物一起
提交 —— `tests/icon.test.cjs` 会逐字节比对生成器输出与入库文件，忘了重建就是红的。
图标接了三处：`build.win.icon`（exe 与安装包）、`extraResources`（打包后托盘与窗口
运行期要读 `process.resourcesPath` 下那一份）、`BrowserWindow({ icon })`（开发态）。

打包的最后一步会自动跑 `npm run verify:package`：校验 `app.asar` 的索引自洽（所有条目
声明的大小之和必须恰好铺满数据区），再真的把 exe 拉起来确认它没有立刻退出。索引错位是
**静默**的 —— 用户双击后只会「没反应」，没有窗口也没有日志，所以这条验收不允许跳过。
本机若撞上 `EPERM ... rename 'win-unpacked.tmp' -> 'win-unpacked'`，改用
`npm run electron:build:local`（详见 [`../docs/development.md`](../docs/development.md)
的 EPERM 一节）。

> 跑 `verify:package` 或 `verify:render:packaged` 之前**先关掉正在运行的 Codex Updater**。
> 它们 spawn 一个真实 exe 并要求存活若干秒，而应用有单实例锁 —— 已经有一个实例在跑时，
> 新起来的那个会立刻退出，脚本会判成「启动后立刻退出」。这是单实例锁的正常行为。

## 界面行为

- **单实例。** 双击第二次只会把已有窗口 `restore` + `show` + `focus` 到前台，不会出现
  两个更新器同时点「一键安装」。
- **窗口位置尺寸记忆。** 存 `settings.json` 的 `windowBounds`，`resize`/`move` 防抖后写入；
  最大化时存的是 `getNormalBounds()`（还原矩形）而不是整屏尺寸。恢复前会拿
  `screen.getAllDisplays()` 的工作区求交集，外接显示器被拔掉时窗口不会开到看不见的地方。
- **任务栏进度。** 所有 `desktop:progress` 事件都要过 `progressReporter()`，在那里顺手喂
  `setProgressBar()`：阶段事件按百分比，下载字节数是不确定态（下载总量本就无从得知，
  不编造百分比）。命令结束在 `ipcMain.handle` 的 `finally` 里清成 `-1`。
- **关窗保护。** 只拦**会改动系统的长命令**（`download_codex` / `install_codex` /
  `repair_bundles` / `launch_codex`）——「检查更新」跑一半关掉完全无害，为它弹框是打扰。
  确认框默认按钮是「继续等待」，`app.quit()` 经 `before-quit` 置标志放行。
- **跟随系统深浅色。** `styles.css` 的颜色全在 `:root` 变量里，深色只由一个
  `@media (prefers-color-scheme: dark)` 重定义变量；窗口底色由 `nativeTheme` 决定，并订阅
  `nativeTheme.on("updated")`，免得系统切主题后新窗口闪一下白。卡片上那三个 macOS 装饰
  圆点保持字面量配色。
- **启动即查一次。** 界面就绪后异步跑一遍静默检查（不弹对话框），顶栏写出「上次检查
  HH:MM」。「诊断 → 复制诊断信息」把完整现场拼成一段文本写进剪贴板 —— 这是**即时动作**，
  界面忙的时候也必须能点，同事报障时正是安装刚失败的那一刻。

## 后台与启动（可选项，默认关）

「后台与启动（可选）」卡片里两个开关，默认全关：**关窗后留在托盘里**、**开机自动启动**。
两个都会改变应用在用户机器上的存在方式，所以不默认开。

打开后：主进程每 6 小时发一次 `desktop:background-check`，渲染进程复用启动时那条
`autoCheckUpdate()` 再查一轮（**不新增第二条会走网络的代码**）；发现新版本时渲染进程调
`notify_update`，弹一条系统通知。三个条件缺一不可，依据都在主进程手上：窗口可见且聚焦时
不弹（用户正看着界面，顶栏已经写着结论）、`lastNotifiedVersion` 与本次版本相同不弹
（同一版本只提醒一次，且**只在真的弹出去之后才记账**）、系统支持通知。点通知只显示窗口。

**通知里不带任何安装动作**，也永远不会自动安装 —— 需要提权的安装永远由人点（见
AGENTS.md 那条「后台运行绝不弹 UAC」）。

开机自启只在 `app.isPackaged` 下真的写注册表（开发态 `process.execPath` 是
`electron.exe`，注册它等于往注册表里塞垃圾），启动参数带 `--hidden`，所以开机只是静默
起来查一次，不会弹窗。

> Windows 的系统通知要求应用有带 AppUserModelID 的快捷方式（`whenReady` 里设了
> `com.codex.updater`）。用安装包装出来的版本才有这个快捷方式，直接跑源码时通知不一定
> 弹得出来 —— 这是 Windows 的既有约束，不是代码问题。

## 运行时边界

- **脚本是内置的，不是调用已安装的插件。** 仓库里 `plugins/` 下的 PowerShell 脚本由
  `npm run sync:scripts` 复制进 `desktop/resources/scripts/`，打包时经 electron-builder
  的 `extraResources` 落到 `resources/scripts/`（**在 asar 之外** —— PowerShell 执行不了
  `app.asar` 里的 `.ps1`）。开发态则直接读 `desktop/resources/scripts/`。
  所以这个 exe 是自包含的：机器上没装过插件也能用，也不会去动
  `%USERPROFILE%\.codex` 下的任何东西。
- Electron 主进程只接受 17 个固定白名单命令（见 `electron/main.cjs` 的
  `allowedCommands`），不接受任意 shell 命令，也不接受渲染进程传脚本路径；
  每个命令对应的脚本名在主进程里写死。剪贴板只有**写**（`copy_text`）没有**读** ——
  一个能把用户剪贴板内容读走的接口没有任何存在的理由；要复制的文本由渲染进程拼
  （它手上才有完整状态），主进程只负责写进去。
- 渲染进程不启用 Node.js，使用 `contextIsolation` 和受控 preload IPC。
- MSIX 本体装到哪个盘由 Windows 的部署服务决定，本应用改不了（界面上只如实显示）。
  应用自己控制的是安装包缓存目录：安装包（几百 MB）和安装日志放在那里。
- 下载包检查 Authenticode 签名，并把签名者与**本机已安装的 Codex** 的发布者比对，
  再计算 SHA-256；没有远端摘要清单时不会把「已计算」误报成「摘要匹配」。
  期望发布者是现取的，不写死在代码里：Store 分发的包，发布者 DN 是 `CN=<GUID>` 形式
  （Codex 是 `CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B`），里面并没有 "OpenAI" 字样。
- **更新时可能弹一次 UAC。** 新版 Codex 的 `AppxManifest.xml` 声明了一个以 `localSystem`
  运行的打包服务（`<desktop6:Extension Category="windows.service">`），Windows 因此要求
  **管理员上下文**才能 `Add-AppxPackage`，否则报 `HRESULT: 0x80073D28`。所以更新前会先用
  `Test-CodexPackageRequiresElevation` 读一遍安装包清单：需要提权时由分离的 worker 拉起一个
  **短命的提权子进程**（`-Verb RunAs`，界面会显示「正在请求管理员权限」），只做「关 Codex + 装包」；
  版本校验、缓存剪枝、重启 Codex 与窗口探针仍留在**非提权**的 worker 里 ——
  从提权进程发 `explorer.exe shell:AppsFolder` 激活请求行为不确定。UAC 被取消只会让提权子进程起不来，worker 会以一条
  说明「什么都没改动、Codex 没有被关闭」的 FATAL 收场，界面不会卡在「正在安装」。
  提权只加在 worker 里也是必须的：`ps.cjs` 的 `captureScript` 没有超时，UAC 若弹在 launcher
  那个进程里，界面会**永久**停在工作中，既不报错也不超时。
- 签名修复只操作用户目录缓存，不修改 `WindowsApps`。
- 关闭 Codex 进程时按**包的安装路径**匹配，绝不按进程名 —— 用户自己的 ChatGPT 桌面版
  进程名相同，按名字杀会误伤。

## 缓存保留策略

**桌面应用一个包都不删。** 它给三个 PowerShell 调用都加上 `-KeepAll`（检查、下载、安装），
把所有下载过的 `OpenAI.Codex` 安装包留在缓存目录里。界面上「安装包缓存」卡片显示当前有
几个、共占多少，想腾空间点「清空缓存」（弹一次确认，默认按钮是「取消」）。

为什么不像每日自动化那样自动剪枝（那边保留最近 2 个，约 1.67 GB）：自动剪枝的判据是
「按版本倒序留 N 个」，对用户是**隐形**的 —— 同事发现 C 盘少了几个 GB 时，界面上一个字都
没解释删了什么、为什么删。宁可让磁盘慢慢涨，由人决定什么时候清。

代价是缓存会一直涨（每个包约 800 MB），所以占用数字必须**一直摆在界面上**，不能藏进折叠
起来的设置里。这也是「清空缓存」和缓存目录入口放在同一张卡片、排在版本历史之前的原因。

「清空缓存」只删 `Get-CachedCodexPackages` 认得出来的 Codex 安装包：`.partial` 半成品、
别的应用的包、用户自己放进缓存目录的文件都不碰 —— 缓存目录是用户自己选的任意文件夹，
这个动作**不等价于对整个目录 `rm -rf`**。删不掉的（被杀毒软件或安装进程占着）逐个记下来
报给界面，不中断整批，脚本始终以 0 退出。

保留 2 个而不是 1 个这条（自动化侧）是为了让「更新完发现有问题」能退回上一版：新装上的
那一版的安装包，正是下一次更新时的回退目标。回退入口在界面的「版本历史」卡片和失败告警里；
那张卡片对普通用户没什么用，可以在「安装包缓存」里关掉（**只隐藏卡片，不影响任何行为**）。

回退依赖缓存里留着的安装包，所以它只对**带着这条策略更新过一次**之后的版本有效 ——
更早的安装包在旧策略下已被删除，而分发源只提供最新版，找不回来。

## 发布

改 `package.json` 里的 `version`，再打 `desktop-v*` 标签，即可触发 GitHub Actions
发布工作流（`.github/workflows/desktop-release.yml`）。工作流会先核对标签与
`package.json` 的版本一致，再跑测试和构建，最后把 `desktop/release/*.exe` 发到
Release。不需要额外服务器。

> 当前构建**未做代码签名**。用户首次运行会看到 SmartScreen 的「Windows 已保护你的
> 电脑」提示，需要点「更多信息 → 仍要运行」。要消除这个提示只能买 Authenticode
> 证书并在工作流里配置签名。

发给同事最省事的方式是**直接把 `desktop/release/` 里那个 `Codex Updater Setup x.y.z.exe`
发过去**：仓库虽然是公开的、Release 页谁都能下，但让每个人自己去翻 Release 页挑版本
反而多一道手续，而且容易下到旧的那一版。安装包是当前用户安装、不需要管理员权限，
装完在开始菜单和桌面上都有带图标的快捷方式。
