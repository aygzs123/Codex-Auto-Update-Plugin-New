// 把仓库里的 PowerShell 脚本同步到 desktop/resources/scripts/，供 electron-builder
// 的 extraResources 打进安装包。
//
// 为什么不直接把脚本放进 desktop/：同一份脚本在仓库里存在两份副本会立刻漂移。
// 这里以仓库为唯一来源，同步产物不入库（见 .gitignore）。
//
// 为什么必须用 extraResources 而不是 asar：PowerShell 无法从 app.asar 内执行 .ps1，
// 而且 CodexStoreUpdater.psm1 必须与被调脚本同目录 —— 每个脚本都用
// Import-Module (Join-Path $scriptRoot "CodexStoreUpdater.psm1") 定位模块。

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(desktopRoot, "..");

const pluginScripts = join(repoRoot, "plugins", "codex-ms-desktop-updater", "scripts");

// 最小自包含集：查版本 + 下载、安装、健康自检、修复，外加它们共同依赖的模块。
// 刻意排除 update-installed-plugin.ps1 和 run-automatic-maintenance.ps1 ——
// 两者都强制要求 <PluginRoot>\.codex-plugin\plugin.json，在自包含 exe 里必然抛错。
const sources = [
  join(pluginScripts, "CodexStoreUpdater.psm1"),
  join(pluginScripts, "check-codex-update.ps1"),
  join(pluginScripts, "install-codex-msix-and-restart.ps1"),
  join(pluginScripts, "check-codex-desktop-health.ps1"),
  // 「版本历史 / 回退」要用它列出缓存里的安装包。
  join(pluginScripts, "list-cached-codex-packages.ps1"),
  // 修复脚本不在插件 scripts/ 里，只存在于 docs/ 下（install/install.ps1 也是从那里
  // 把它拷进已安装插件的）。它零插件目录依赖，可以独立打包运行。
  join(repoRoot, "docs", "codex-desktop-encrypted-copy-fix", "repair-codex-desktop-bundles.ps1"),
];

const missing = sources.filter((source) => !existsSync(source));
if (missing.length > 0) {
  console.error("同步失败，以下源文件不存在：");
  for (const source of missing) console.error(`  ${source}`);
  process.exit(1);
}

const target = join(desktopRoot, "resources", "scripts");
mkdirSync(target, { recursive: true });
for (const source of sources) {
  copyFileSync(source, join(target, basename(source)));
}

console.log(`已同步 ${sources.length} 个脚本到 ${target}`);
