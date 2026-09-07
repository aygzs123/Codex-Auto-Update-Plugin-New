# Codex MS Desktop 自动更新插件

[English](README_EN.md) | [中文](README.md)

一个面向 Windows 的 Codex Desktop(Microsoft Store / MSIX 版)更新工具。它通过
`store.rg-adguard.net` 查询 Codex 商店包、比较版本、下载较新的 MSIX/bundle,
并在你明确要求时才执行 `Add-AppxPackage` 安装。配套提供本地 Web 界面、健康
自检与窗口探测、每日自动化模板。

## 特性

- **更新检查**:查询 `https://store.rg-adguard.net/api/GetFiles` 获取 Codex
  Store 条目(`9plm9xgg6vks`)的包链接,解析 `OpenAI.Codex_*.msix` / bundle。
- **按需下载与安装**:只有 `-DownloadOnly` / `-Install` / `-InstallWithRestart`
  才下载;只有 `-Install` / `-InstallWithRestart` 才执行 `Add-AppxPackage`。
- **安装后重启**:`-InstallWithRestart` 会启动独立流程——关闭 Codex、安装
  MSIX、校验已装版本不低于下载版本、再重启 Codex。
- **自动清理**:校验通过后删除已安装/更旧的 `OpenAI.Codex` 包文件,节约磁盘。
- **插件自更新**:对比本机与远端 `plugin.json` 版本,自动从 GitHub 更新插件。
- **代理控制**:`-NoProxy` 让本次进程下载不走代理。
- **Web 界面**:本地可视化操作,按钮即命令(见下文「Web 界面」)。
- **健康自检 + 窗口探测**:检测"进程在跑但主窗口不出现"的官方加密资源搬迁
  bug(见下文「健康自检与窗口探测」与 `docs/`)。

## 目录结构

```text
plugins/codex-ms-desktop-updater/   Codex 插件本体
  .codex-plugin/plugin.json         插件清单(版本号以此为唯一来源)
  skills/codex-ms-desktop-updater/  插件技能说明
  scripts/                          核心脚本(见「命令参考」)
  tests/                            PowerShell 测试
webui/                              本地 Web 界面(扩展)
docs/codex-desktop-encrypted-copy-fix/  Codex「无窗口」bug 修复记录与脚本
install/                            一键安装到本机 Codex + 每日自动化模板
tools/Test-PluginVersionBump.ps1    CI 版本校验脚本
```

## 命令参考

所有命令都在**仓库根目录**执行,使用 PowerShell。

### 自动维护(插件自更新 + Codex 更新)

先更新本插件,再在有新版时下载安装并重启 Codex:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\scripts\run-automatic-maintenance.ps1 -NoProxy
```

### 手动控制 Codex 更新

| 目的 | 命令 |
|------|------|
| 仅检查是否有新版 | `check-codex-update.ps1 -CheckOnly` |
| 仅下载 | `check-codex-update.ps1 -DownloadOnly` |
| 下载并安装(不重启) | `check-codex-update.ps1 -Install` |
| 下载 → 关闭 → 安装 → 重启 | `check-codex-update.ps1 -InstallWithRestart -NoProxy` |
| 强制下载最新包(即使已装) | `download-latest-codex-msix.ps1 -NoProxy` |
| 安装已下载的 MSIX 并重启 | `install-codex-msix-and-restart.ps1 -PackagePath "<路径>"` |

其中 `run-automatic-maintenance.ps1`、`update-installed-plugin.ps1`、
`download-latest-codex-msix.ps1` 均接受 `-NoProxy`。

下载文件保存到:

```text
plugins/codex-ms-desktop-updater/downloads/
```

> 该目录是运行缓存,已被 `.gitignore` 忽略,不会入库。

## 安装到本机 Codex

对当前 Windows 用户安装(复制插件并写入每日自动化):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\install.ps1
```

它会:

- 把 `plugins\codex-ms-desktop-updater` 复制到
  `%USERPROFILE%\.codex\plugins\codex-ms-desktop-updater`(**跳过** `downloads` 缓存);
- 用 `install\automation.toml` 模板,把占位符替换成该机器真实路径后写入
  `%USERPROFILE%\.codex\automations\daily-codex-desktop-update-check\automation.toml`;
- 模板保持可迁移,不含盘符硬编码(用 `{{CODEX_PLUGIN_ROOT}}` 等占位符)。

安装后若插件未立即出现,重启 Codex Desktop 即可。

### 手动复制(不使用 install.ps1)

将插件目录复制到 `%USERPROFILE%\.codex\plugins\codex-ms-desktop-updater`,
然后在 `%USERPROFILE%\.codex\.agents\plugins\marketplace.json` 登记:

```json
{
  "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
  "category": "Developer Tools",
  "name": "codex-ms-desktop-updater",
  "source": { "path": "./plugins/codex-ms-desktop-updater", "source": "local" }
}
```

每日自动化若需在新设备重建,在该设备 Codex Desktop 中创建每日运行
`run-automatic-maintenance.ps1 -NoProxy` 即可。

## Web 界面(可视化操作 · 扩展)

不想敲命令行时,可在浏览器里点按钮完成检查 / 下载 / 安装 / 重启 / 健康自检:

```text
webui/
  server.py         本地桥接服务(Python 标准库,零第三方依赖)
  index.html        单文件界面(无外部 CDN,可离线)
  start-webui.ps1   启动脚本
  start-webui.bat   双击启动入口
```

### 启动

双击 `webui\start-webui.bat`(或运行 `start-webui.ps1`)。脚本会自动:

1. 检测本机 Python(`py` → `python` → `python3`);
2. 在后台启动 `server.py`,仅监听 `127.0.0.1:8765`;
3. 打开浏览器进入界面(已运行则直接打开)。

### 界面功能

顶部三张状态卡:Codex 已安装版本、**运行进程数 / 主窗口**、插件本地版本。
日志经 SSE 实时滚动。

| 按钮 | 对应脚本 |
|------|----------|
| 🔍 检查 Codex 更新 | `check-codex-update.ps1 -CheckOnly -NoProxy` |
| ⬇️ 下载并安装 + 重启 | `check-codex-update.ps1 -InstallWithRestart -NoProxy` |
| 📦 检查插件更新 | `update-installed-plugin.ps1 -CheckOnly -NoProxy` |
| 🔄 更新插件 | `update-installed-plugin.ps1 -NoProxy` |
| 🩺 健康自检 | `check-codex-desktop-health.ps1` |
| 🚀 健康自检 + 启动探测 | `check-codex-desktop-health.ps1 -Probe` |

> 安全说明:服务只绑定 `127.0.0.1`,局域网 / 公网不可访问。按钮只触发项目内
> 预定义脚本与固定参数,不接受任意命令,不引入新的任意命令执行面。

## 健康自检与窗口探测(扩展)

Codex Desktop(商店版)有一个官方 bug:**更新后进程在运行,但主窗口不出现**。
原因是 MSIX 加密资源搬迁到用户目录时,App 的 `fs.copyFileSync` 复制失败
(`errno=-4094`)。本仓库提供只读自检与可选启动探测:

```powershell
# 只读体检:各搬迁 bundle 是否存在 / 是否残留 .staging-*
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\scripts\check-codex-desktop-health.ps1

# 自检后启动 App 并等待主窗口(复现「进程在、无窗口」)
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\scripts\check-codex-desktop-health.ps1 -Probe -ProbeSeconds 25
```

退出码:`0` 健康 / `1` 组件缺失或降级 / `2` 未安装 / `3` 探测超时未出现主窗口。

- `-InstallWithRestart` 安装后也会自动探测窗口;若未出现主窗口,安装日志会写
  `WINDOW_PROBE=FAILED` 与搬迁健康快照并提示修复脚本。
- 若确认为该 bug,运行 `docs\` 下的修复脚本即可恢复(见下)。

## 修复文档:docs/codex-desktop-encrypted-copy-fix

`docs/codex-desktop-encrypted-copy-fix/` 记录了「Codex Desktop 启动后无窗口」
问题的完整调查与修复:

- `README.md` —— 现象、根因(加密 MSIX 资源 + Node copyFile 失败)、影响面、
  Bundle ID 计算、手动与脚本修复、验证结果、回滚方法;
- `repair-codex-desktop-bundles.ps1` —— **可复用、幂等**的修复脚本。它会动态
  计算当前安装版本的五个组件 bundle ID(win-cli / win-rg / wsl-cli / wsl-rg /
  cua_node),用字节流复制绕过加密复制失败,并对每个组件做 SHA-256 全量校验。

修复脚本用法(需先退出 Codex):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\codex-desktop-encrypted-copy-fix\repair-codex-desktop-bundles.ps1
```

> 安全边界:脚本只写 `%LOCALAPPDATA%\OpenAI\Codex` 与 `%USERPROFILE%\.codex`,
> **绝不改动** `C:\Program Files\WindowsApps` 下的文件 / ACL / 所有权。每次重跑
> 对已健康的缓存输出 `SKIP`,不会破坏既有状态。每次 Store 更新后若复发,直接
> 重跑即可(脚本按当前安装版本动态计算 ID,可跨版本)。

## 版本管理与 CI

插件版本唯一来源是
`plugins\codex-ms-desktop-updater\.codex-plugin\plugin.json` 的 `version` 字段。
推送仓库改动前请递增该版本(数值 SemVer 风格,如 `0.3.0`)。GitHub CI 在 PR 和
push 到 `main` 时运行 `tools\Test-PluginVersionBump.ps1`,要求 head 版本大于
基线版本。

## 测试

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\Install.Tests.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\tests\CodexStoreUpdater.Tests.ps1
```

## 维护说明

- 仓库根 `AGENTS.md`:面向只负责「把插件装进本机 Codex」的 Codex agent。
- `.codex/AGENTS.md`:面向维护本仓库本身(版本管理、验证流程)。
