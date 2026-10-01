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
（不需要管理员权限）。

## 运行时边界

- **脚本是内置的，不是调用已安装的插件。** 仓库里 `plugins/` 下的 PowerShell 脚本由
  `npm run sync:scripts` 复制进 `desktop/resources/scripts/`，打包时经 electron-builder
  的 `extraResources` 落到 `resources/scripts/`（**在 asar 之外** —— PowerShell 执行不了
  `app.asar` 里的 `.ps1`）。开发态则直接读 `desktop/resources/scripts/`。
  所以这个 exe 是自包含的：机器上没装过插件也能用，也不会去动
  `%USERPROFILE%\.codex` 下的任何东西。
- Electron 主进程只接受 15 个固定白名单命令（见 `electron/main.cjs` 的
  `allowedCommands`），不接受任意 shell 命令，也不接受渲染进程传脚本路径；
  每个命令对应的脚本名在主进程里写死。
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
  从提权进程发 `explorer.exe shell:AppsFolder` 激活请求行为不确定，而且探针失败还会打出
  「官方加密资源搬迁 bug」那套误导性结论。UAC 被取消只会让提权子进程起不来，worker 会以一条
  说明「什么都没改动、Codex 没有被关闭」的 FATAL 收场，界面不会卡在「正在安装」。
  提权只加在 worker 里也是必须的：`ps.cjs` 的 `captureScript` 没有超时，UAC 若弹在 launcher
  那个进程里，界面会**永久**停在工作中，既不报错也不超时。
- 签名修复只操作用户目录缓存，不修改 `WindowsApps`。
- 关闭 Codex 进程时按**包的安装路径**匹配，绝不按进程名 —— 用户自己的 ChatGPT 桌面版
  进程名相同，按名字杀会误伤。

## 缓存保留策略

装完之后缓存里保留**最近 2 个** `OpenAI.Codex` 安装包（约 1.67 GB），更旧的自动清理。
留 2 个而不是 1 个，是为了让「更新完发现有问题」能退回上一版：新装上的那一版的安装包，
正是下一次更新时的回退目标。回退入口在界面的「版本历史」卡片和失败告警里。

回退依赖本应用自己保留下来的安装包，所以它只对**带着这条策略更新过一次**之后的版本
有效 —— 更早的安装包在旧策略下已被删除，而分发源只提供最新版，找不回来。

## 发布

改 `package.json` 里的 `version`，再打 `desktop-v*` 标签，即可触发 GitHub Actions
发布工作流（`.github/workflows/desktop-release.yml`）。工作流会先核对标签与
`package.json` 的版本一致，再跑测试和构建，最后把 `desktop/release/*.exe` 发到
Release。不需要额外服务器。

> 当前构建**未做代码签名**。用户首次运行会看到 SmartScreen 的「Windows 已保护你的
> 电脑」提示，需要点「更多信息 → 仍要运行」。要消除这个提示只能买 Authenticode
> 证书并在工作流里配置签名。
