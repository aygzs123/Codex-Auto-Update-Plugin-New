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
- 可使用 `-NoProxy` 让本次 PowerShell 进程下载 MSIX 时不走代理。



## 目录结构

```text
plugins/codex-ms-desktop-updater/
  .codex-plugin/plugin.json
  skills/codex-ms-desktop-updater/SKILL.md
  scripts/CodexStoreUpdater.psm1
  scripts/check-codex-update.ps1
  tests/CodexStoreUpdater.Tests.ps1
```

## 使用

仅检查更新：

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

每日自动化运行 `-InstallWithRestart -NoProxy`。如果检测到新版本，它会启动独立安装流程：
关闭 Codex、安装 MSIX，并在安装结束后重启 Codex。如果没有新版本，则不通知。


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
powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\plugins\codex-ms-desktop-updater\scripts\check-codex-update.ps1 -InstallWithRestart -NoProxy
```

如果没有新版本，脚本会跳过下载和安装。如果有新版本，它会关闭 Codex、安装 MSIX，并在安装结束后重启 Codex。

`install/automation.toml` 是可迁移模板，使用 `{{CODEX_PLUGIN_ROOT}}` 和
`{{CODEX_CHECK_SCRIPT}}` 占位符，不包含个人设备盘符。运行 `install/install.ps1`
安装到本机时，会写入 `~/.codex` 下的实际插件路径和脚本路径。

仍然可以手动运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\plugins\codex-ms-desktop-updater\scripts\check-codex-update.ps1 -InstallWithRestart -NoProxy
```

如果插件没有立即出现在 Codex 中，请重启 Codex。
