// 主题链路、缓存读取状态与存储迁移的源码契约。
//
// 这些功能大多依赖真实 Electron / Windows 包部署服务，单元测试跑不了整条链路，
// 但「界面接了哪根线、主进程有没有对应命令、危险动作有没有确认」都能从源码钉住。
// 真正的文件级行为在 cache-migration.test.cjs 里用临时目录验证。

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const main = read("electron", "main.cjs");
const preload = read("electron", "preload.cjs");
const store = read("src", "state", "app.ts");
const app = read("src", "App.tsx");
const css = read("src", "styles.css");
const theme = read("src", "lib", "theme.ts");
const indexHtml = read("index.html");
const bridge = read("src", "lib", "bridge.ts");
const syncScripts = read("scripts", "sync-ps-scripts.mjs");
const cacheSettings = read("src", "components", "CacheSettings.tsx");
const versionHistory = read("src", "components", "VersionHistory.tsx");
const advancedSettings = read("src", "components", "AdvancedSettings.tsx");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- 主题 ----------

test("主题：解析只有一处实现，显式偏好压过系统", () => {
  assert.match(theme, /export function resolveTheme/);
  assert.match(theme, /if \(preference === "light"\) return "light"/);
  assert.match(theme, /if \(preference === "dark"\) return "dark"/);
  assert.match(theme, /return prefersDark \? "dark" : "light"/);
  // 根节点同时写解析结果与偏好：CSS 只消费 data-theme，界面只展示 data-theme-preference。
  assert.match(theme, /root\.dataset\.theme = resolved/);
  assert.match(theme, /root\.dataset\.themePreference = preference \?\? "system"/);
  assert.match(theme, /root\.style\.colorScheme = resolved/);
});

test("主题：CSS 只认 data-theme，不再直接吃 prefers-color-scheme", () => {
  assert.match(css, /:root\[data-theme="dark"\] \{/);
  assert.doesNotMatch(css, /@media \(prefers-color-scheme: dark\)/, "CSS 不该再有第二条主题链路");
  // 局部覆盖（滚动条、顶栏、仪表）也都挂在 data-theme 下。
  assert.match(css, /:root\[data-theme="dark"\] \.topbar/);
  assert.match(css, /:root\[data-theme="dark"\] \.instrument/);
});

test("主题：preload 在首帧前同步上色，且订阅可取消", () => {
  assert.match(preload, /ipcRenderer\.sendSync\("desktop:initial-theme"\)/);
  assert.match(preload, /applyInitialTheme\(\);\r?\n\r?\ncontextBridge\.exposeInMainWorld/, "必须在暴露 API 之前执行");
  assert.match(preload, /root\.dataset\.theme = resolved/);
  assert.match(preload, /onThemeUpdated: \(callback\)/);
  assert.match(preload, /removeListener\("desktop:theme-updated"/);
  // index.html 的兜底脚本：preload 失败时也不留一帧纯白。
  assert.match(indexHtml, /prefers-color-scheme/);
  assert.match(indexHtml, /dataset\.theme/);
});

test("主题：主进程用 nativeTheme 解析并推给所有窗口", () => {
  assert.match(main, /ipcMain\.on\("desktop:initial-theme"/);
  assert.match(main, /nativeTheme\.shouldUseDarkColors \? "dark" : "light"/);
  assert.match(main, /nativeTheme\.on\("updated"/);
  assert.match(main, /send\("desktop:theme-updated", parsed\)/);
  assert.match(main, /window\.setBackgroundColor\(windowBackgroundColor\(\)\)/);
});

test("主题：保存失败回退到上一个值，过期请求被丢弃", () => {
  assert.match(store, /themeRequestSeq/);
  assert.match(store, /requestId !== themeRequestSeq/);
  assert.match(store, /const previous = get\(\)\.settings\?\.theme \?\? "system"/);
  assert.match(store, /主题保存失败，已恢复上一个设置/);
  assert.match(store, /applyThemeToDocument\(previous\)/);
  assert.match(store, /await invokeCommand<Settings>\("save_settings", \{ theme \}\)/);
  // 回读主进程归一化后的值，而不是假设它接受传入值。
  assert.match(store, /const settings = await invokeCommand<Settings>\("get_settings"\)/);
});

test("主题：外观设置支持三档与方向键，保存中显示进度", () => {
  assert.match(app, /pending=\{themePending\}/);
  assert.match(app, /onTheme=\{\(theme\) => void setTheme\(theme\)\}/);
  const appearance = read("src", "components", "AppearanceSettings.tsx");
  assert.match(appearance, /role="radiogroup"|role="radio"/);
  assert.match(appearance, /ArrowRight|ArrowDown/);
  assert.match(appearance, /tabIndex=/);
});

// ---------- 设置信息架构 ----------

test("设置：四个标签，切换时只渲染当前面板", () => {
  for (const label of ["通用", "外观", "存储", "关于"]) {
    assert.ok(app.includes(`label: "${label}"`), `设置标签缺少「${label}」`);
  }
  assert.match(app, /role="tablist"/);
  assert.match(app, /role="tab"/);
  assert.match(app, /aria-selected=\{value === tab\.id\}/);
  assert.match(app, /role="tabpanel"/);
  assert.ok(app.includes('settingsTab === "storage"'));
});

// ---------- 缓存读取状态 ----------

test("缓存：读取失败清空列表并标记 error，而不是继续展示旧数据", () => {
  assert.match(store, /cachedPackages: null,\s*\r?\n\s*cacheStatus: "error"/);
  assert.match(store, /cacheError: describe\(error\)/);
  assert.match(store, /generation !== cacheGeneration/);
  assert.match(store, /let cacheGeneration = 0/);
});

test("缓存：错误 / 空目录 / 扫描中三种状态在界面上分开说", () => {
  assert.match(cacheSettings, /cacheStatus === "error"/);
  assert.match(cacheSettings, /无法读取缓存目录/);
  assert.match(cacheSettings, /正在扫描/);
  assert.match(versionHistory, /无法读取缓存目录/);
  assert.match(versionHistory, /正在扫描缓存目录/);
  assert.match(versionHistory, /暂无安装包缓存/);
});

test("缓存：主进程监听目录，400ms 防抖，切换目录时重建", () => {
  assert.match(main, /watch\(directory, \{ persistent: false \}/);
  assert.match(main, /\}, 400\);/);
  assert.match(main, /function ensureCacheWatcher/);
  assert.match(main, /function closeCacheWatcher/);
  assert.match(main, /notifyCacheChanged/);
  assert.match(main, /send\("desktop:cache-changed"\)/);
  // 保存缓存目录后要重建监听，否则自动刷新还盯着旧目录。
  assert.match(main, /if \("downloadDirectory" in patch\) \{\s*\r?\n\s*ensureCacheWatcher\(\)/);
  // 渲染层同时用窗口焦点补偿（网络盘上 fs.watch 不一定报事件）。
  assert.match(app, /subscribeCacheChanged\(schedule\)/);
  assert.match(app, /window\.addEventListener\("focus", schedule\)/);
  assert.match(bridge, /onCacheChanged/);
});

// ---------- 存储与迁移 ----------

test("存储：白名单、长命令与空间读取都接上了", () => {
  for (const command of [
    "get_storage_info",
    "precheck_cache_migration",
    "migrate_cache",
    "cancel_cache_migration",
    "get_app_migration_capability",
    "move_codex_app",
    "open_storage_settings",
  ]) {
    assert.ok(main.includes(`"${command}"`), `白名单缺少 ${command}`);
    assert.ok(store.includes(`"${command}"`) || app.includes(`"${command}"`), `界面没有调用 ${command}`);
  }
  assert.match(main, /"migrate_cache",\s*\r?\n\s*"move_codex_app",/);
  assert.match(main, /statfs|freeSpaceFor/);
  assert.match(main, /ms-settings:savelocations/);
});

test("缓存迁移：所选文件夹 → 预检 → 复制 → SHA-256 校验 → 切换 → 清理，失败保留源", () => {
  assert.match(app, /const target = folder/);
  assert.doesNotMatch(app, /cacheDirectoryUnder/);
  assert.match(app, /precheckCacheMigration\(target\)/);
  // 旧安装包是可选项：勾选才搬，不勾只切设置。
  assert.match(app, /onApplyMigration/);
  assert.match(app, /saveDownloadDirectory\(target\)/);
  assert.match(cacheSettings, /缓存目录改为/);
  assert.match(cacheSettings, /迁移并切换/);
  assert.match(cacheSettings, /只切换目录/);
  assert.match(cacheSettings, /focus\(\)/, "确认块出现时焦点应落在取消上");
  assert.match(cacheSettings, /取消迁移/);
  assert.match(cacheSettings, /migrationRunning/);
  // 主进程只在全部校验通过后切换设置；执行前重新枚举，不复用界面清单。
  assert.match(main, /switchDirectory: \(target\) => \{\s*\r?\n\s*applyCacheDirectory\(target\)/);
  assert.match(store, /已取消迁移。源目录与设置都没有改动/);
  assert.match(store, /cleanupFailures/);
});

test("应用迁移：只读能力检测 + 只对已识别 AppxVolume 执行 + 原生确认默认取消", () => {
  // 两个脚本必须进同步清单，否则打包后 PowerShell 找不到它们。
  assert.ok(syncScripts.includes("get-codex-app-migration.ps1"), "能力检测脚本没进 sync 列表");
  assert.ok(syncScripts.includes("move-codex-app.ps1"), "迁移脚本没进 sync 列表");

  const detect = read("..", "plugins", "codex-ms-desktop-updater", "scripts", "get-codex-app-migration.ps1");
  const move = read("..", "plugins", "codex-ms-desktop-updater", "scripts", "move-codex-app.ps1");
  assert.match(detect, /Get-AppxVolume/);
  assert.match(detect, /Get-AppxPackage/);
  assert.match(detect, /ConvertTo-Json/);
  assert.doesNotMatch(detect, /Move-AppxPackage\s+-Package/, "检测脚本必须只读");
  assert.doesNotMatch(detect, /Start-Process/, "检测脚本不应该启动任何进程");

  assert.match(move, /Move-AppxPackage/);
  assert.match(move, /Get-AppxVolume/);
  assert.match(move, /Verb RunAs/);
  assert.match(move, /ResultPath/);
  assert.doesNotMatch(move, /robocopy|Copy-Item|New-Item.*Junction|mklink/i, "不能用复制 / 联接搬 WindowsApps");

  // 主进程的确认框：默认按钮必须是「取消」，且文案说明会关闭 Codex、需要 UAC。
  assert.match(main, /async function confirmMoveApp/);
  assert.match(main, /buttons: \["取消", "迁移"\]/);
  assert.match(main, /defaultId: 0/);
  assert.match(main, /会弹出一次管理员授权/);
  // 目标卷必须来自本次检测结果，不接受任意字符串。
  assert.match(main, /目标卷不在 Windows 已识别的 AppxVolume 列表里/);
  // 能力限制要说在前面：Windows 只认应用卷，不能让用户以为可以像缓存那样选任意文件夹。
  assert.match(advancedSettings, /不能直接装进自定义子目录/);
  assert.match(advancedSettings, /所选文件夹/);
  assert.match(advancedSettings, /Windows 应用存储位置/);
  assert.match(main, /resolveAppMigrationTarget\(args\?\.selectedDirectory, capability\)/);
  assert.match(advancedSettings, /包管理范围外的用户数据需单独管理/);
  assert.match(move, /NativeErrorCode -eq 1223/);
  assert.match(main, /cancelled: Boolean\(parsed.cancelled\)/);
});

test("缓存迁移进度有独立通道，不和安装进度混用", () => {
  assert.match(preload, /onCacheMigrationProgress/);
  assert.match(preload, /desktop:cache-migration/);
  assert.match(main, /send\("desktop:cache-migration", payload\)/);
  assert.match(app, /subscribeCacheMigration/);
  assert.match(store, /applyCacheMigrationProgress/);
});

// ---------- runner ----------

let failed = 0;
(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${error.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} 通过`);
  process.exit(failed === 0 ? 0 : 1);
})();
