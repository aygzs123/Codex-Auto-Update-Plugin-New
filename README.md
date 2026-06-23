# Codex MS Desktop 更新插件

[English](README_EN.md) | [中文](README.md)

Codex Desktop 插件，用于通过 store.rg-adguard.net 检查 Codex 的
Microsoft Store 安装包，下载并安装较新的 MSIX 包。

## 功能

- 查询 `https://store.rg-adguard.net/api/GetFiles`，获取 Codex Microsoft Store
  条目的包链接。
- 使用 Codex Store 地址：
  `https://apps.microsoft.com/detail/9plm9xgg6vks?hl=en-GB&gl=HK`。
- 从响应中解析 `OpenAI.Codex_*.msix` / bundle 链接。
- 将最新可用版本和本机已安装的 `OpenAI.Codex` AppX 包版本进行比较。
- 版本校验后自动清理下载目录中版本小于或等于当前已安装版本的
  `OpenAI.Codex` 安装包。
- 只有使用 `-DownloadOnly`、`-Install` 或 `-InstallWithRestart` 时才会下载包。
- 只有明确使用 `-Install` 或 `-InstallWithRestart` 时才会运行 `Add-AppxPackage`。
- 可使用 `-InstallWithRestart` 启动独立安装流程，关闭 Codex、安装 MSIX 后再重启 Codex。
- 安装完成后会校验已安装版本不低于下载包版本，校验通过后删除已安装的 MSIX/AppX 包文件以节约存储空间。
- 可使用 `-NoProxy` 让本次 PowerShell 进程下载 MSIX 时不走代理。
- 可通过 `run-automatic-maintenance.ps1` 先根据 GitHub 远程仓库的 `plugin.json` 版本更新本插件，再自动检查并安装 Codex Desktop 更新。



## 目录结构

```text
plugins/codex-ms-desktop-updater/
  .codex-plugin/plugin.json
  skills/codex-ms-desktop-updater/SKILL.md
  scripts/CodexStoreUpdater.psm1
  scripts/check-codex-update.ps1
  scripts/update-installed-plugin.ps1
  scripts/run-automatic-maintenance.ps1
  tests/CodexStoreUpdater.Tests.ps1
```

## 使用

自动维护：先更新本插件，再在有新版本时安装 Codex Desktop 更新。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/run-automatic-maintenance.ps1 -NoProxy
```

仅检查 Codex Desktop 更新：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/check-codex-update.ps1 -CheckOnly
```

仅下载更新：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/check-codex-update.ps1 -DownloadOnly
```

下载并安装：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/check-codex-update.ps1 -Install
```

下载并启动关闭、安装、重启流程：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/check-codex-update.ps1 -InstallWithRestart -NoProxy
```

安装已下载的 MSIX 并重启 Codex：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-desktop-updater/scripts/install-codex-msix-and-restart.ps1 -PackagePath "<path-to-msix>"
```

下载的文件会保存到：

```text
plugins/codex-ms-desktop-updater/downloads/
```

每次检查到本机已安装版本后，脚本都会清理该目录中已安装版本及更旧版本的
`OpenAI.Codex_*.msix` / bundle / AppX 包。安装完成后会重新读取已安装版本并再清理一次。
`-InstallWithRestart` 的独立安装流程还会在版本校验通过后删除本次安装使用的包文件。

每日自动化运行 `run-automatic-maintenance.ps1 -NoProxy`。它会先比较本机插件版本和
`Asunazzz123/Codex-Auto-Update-Plugin` 远程仓库中的 `plugin.json` 版本。
如果插件远程版本更高，则下载 GitHub archive 并覆盖更新本机插件，同时保留
`downloads` 缓存；如果插件没有新版本，则跳过插件下载和更新。

随后它会检查 Codex Desktop。如果检测到新的 Codex MSIX，就启动独立安装流程：关闭
Codex、安装 MSIX、校验已安装版本、删除本次安装使用的包文件，并在安装结束后重启
Codex。如果 Codex Desktop 没有新版本，则跳过 MSIX 下载和安装，并且不通知。



## 版本管理与 CI

插件版本以 `plugins/codex-ms-desktop-updater/.codex-plugin/plugin.json` 的
`version` 字段为准。每次准备 push 仓库变更时，需要递增该版本。GitHub CI 会在
PR 和 push 到 `main` 时运行 `tools/Test-PluginVersionBump.ps1`，校验 head 版本
必须大于基线版本。

## 安装到本机 Codex

在当前 Windows 用户配置中，安装方式是复制：

```text
<repo>\plugins\codex-ms-desktop-updater
```

到：

```text
%USERPROFILE%\.codex\plugins\codex-ms-desktop-updater
```

然后在下面的文件中添加插件入口：

```text
%USERPROFILE%\.codex\.agents\plugins\marketplace.json
```

```json
{
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_INSTALL"
  },
  "category": "Developer Tools",
  "name": "codex-ms-desktop-updater",
  "source": {
    "path": "./plugins/codex-ms-desktop-updater",
    "source": "local"
  }
}
```

注意：在新设备安装插件后，如果需要每日自动安装更新，需要在该设备的 Codex Desktop 中单独创建每日自动化。
自动化应每天运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\plugins\codex-ms-desktop-updater\scripts\run-automatic-maintenance.ps1 -NoProxy
```

自动化会先检查插件自更新，再检查 Codex Desktop 更新。如果插件没有新版本，会跳过插件下载和更新；
如果 Codex Desktop 没有新版本，会跳过 MSIX 下载和安装。如果有新的 Codex MSIX，
它会关闭 Codex、安装 MSIX、校验已安装版本、删除本次安装使用的包文件，并在安装结束后重启 Codex。

`install/automation.toml` 是可迁移模板，使用 `{{CODEX_PLUGIN_ROOT}}` 和
`{{CODEX_MAINTENANCE_SCRIPT}}` 占位符，不包含个人设备盘符。运行 `install/install.ps1`
安装到本机时，会写入 `~/.codex` 下的实际插件路径和脚本路径。

仍然可以手动运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\plugins\codex-ms-desktop-updater\scripts\run-automatic-maintenance.ps1 -NoProxy
```

如果插件没有立即出现在 Codex 中，请重启 Codex。
