# Codex MS Store 更新插件

[English](README_EN.md) | [中文](README.md)

这是一个仓库内的 Codex 插件，用于通过 store.rg-adguard.net 检查 Codex 的
Microsoft Store 安装包，下载较新的 MSIX 包，并且只在明确指定时执行安装。

## 功能

- 查询 `https://store.rg-adguard.net/api/GetFiles`，获取 Codex Microsoft Store
  条目的包链接。
- 使用 Codex Store 地址：
  `https://apps.microsoft.com/detail/9plm9xgg6vks?hl=en-GB&gl=HK`。
- 从响应中解析 `OpenAI.Codex_*.msix` / bundle 链接。
- 将最新可用版本和本机已安装的 `OpenAI.Codex` AppX 包版本进行比较。
- 版本校验后自动清理下载目录中版本小于或等于当前已安装版本的
  `OpenAI.Codex` 安装包。
- 只有使用 `-DownloadOnly` 或 `-Install` 时才会下载包。
- 只有明确使用 `-Install` 时才会运行 `Add-AppxPackage`。

本项目有意不包含将 Microsoft Store MSIX 文件重新托管到 GitHub Release 的自动化。

## 目录结构

```text
plugins/codex-ms-store-updater/
  .codex-plugin/plugin.json
  skills/codex-ms-store-updater/SKILL.md
  scripts/CodexStoreUpdater.psm1
  scripts/check-codex-update.ps1
  tests/CodexStoreUpdater.Tests.ps1
```

## 使用

仅检查更新：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-store-updater/scripts/check-codex-update.ps1 -CheckOnly
```

仅下载更新：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-store-updater/scripts/check-codex-update.ps1 -DownloadOnly
```

下载并安装：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/codex-ms-store-updater/scripts/check-codex-update.ps1 -Install
```

下载的文件会保存到：

```text
plugins/codex-ms-store-updater/downloads/
```

每次检查到本机已安装版本后，脚本都会清理该目录中已安装版本及更旧版本的
`OpenAI.Codex_*.msix` / bundle / AppX 包。安装完成后会重新读取已安装版本并再清理一次。


## 安装到本机 Codex

在当前 Windows 用户配置中，安装方式是复制：

```text
<repo>\plugins\codex-ms-store-updater
```

到：

```text
%USERPROFILE%\.codex\plugins\codex-ms-store-updater
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
  "name": "codex-ms-store-updater",
  "source": {
    "path": "./plugins/codex-ms-store-updater",
    "source": "local"
  }
}
```

如果插件没有立即出现在 Codex 中，请重启 Codex。
