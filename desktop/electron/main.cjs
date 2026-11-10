// 主进程：窗口、菜单、IPC 接线。业务逻辑在 codex.cjs，PowerShell 在 ps.cjs。

const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  screen,
  session,
  shell,
} = require("electron");
const { createHash } = require("node:crypto");
const {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} = require("node:fs");
const { basename, join, resolve } = require("node:path");
const { spawn } = require("node:child_process");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const http = require("node:http");

const codex = require("./codex.cjs");
const github = require("./github.cjs");
const ps = require("./ps.cjs");
const cacheMigration = require("./cache-migration.cjs");

// 在 whenReady 之前设置，userData 才会落在 %APPDATA%\Codex Updater 而不是
// 由包名推导出的 codex-updater-desktop。
app.setName("Codex Updater");

const isDev = process.argv.includes("--dev") || !app.isPackaged;
const projectRoot = join(__dirname, "..");

// 开机自启拉起来的那个实例不该弹窗：用户刚开机，屏幕上不该莫名其妙多一个更新器。
const startHidden = process.argv.includes("--hidden");

// 单实例：双击两次任务栏上只该有一份更新器。两个实例能同时点「一键安装」，两条安装链路
// 会互相踩（一个在装 MSIX，另一个在关 Codex）。
//
// 必须在 whenReady 之前拿锁：ready 之后再判，第二个实例可能已经把 PowerShell 拉起来了。
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

// 渲染进程只能触发这些命令，且每个命令的脚本路径都是写死的内置脚本名。
const allowedCommands = new Set([
  "get_status",
  "check_update",
  "download_codex",
  "verify_download_signature",
  "install_codex",
  "list_cached_packages",
  "clear_cached_packages",
  // 逐个安装包的固定与删除。删除是不可撤销的，所以它和「清空缓存」一样先在主进程弹确认框；
  // 固定则写进缓存目录里的 .codex-pins.json，自动剪枝会跳过这些文件。
  "pin_cached_package",
  "delete_cached_package",
  "launch_codex",
  "check_health",
  "repair_bundles",
  "get_settings",
  "save_settings",
  "pick_directory",
  "open_path",
  "notify_update",
  "copy_text",
  // 打开 Codex 本体的安装目录。路径由主进程自己解析后记着，不接受渲染进程传路径 ——
  // 那正是 open_path 白名单要挡住的那件事，这里不能又开一个口子。
  "open_install_location",
  // GitHub Release 只读：取更新器自身的新版本与更新公告。
  "get_github_updates",
  // 在应用内下载更新器自己的安装包。只接受本仓库 Release 的下载地址，
  // 摘要必须来自 GitHub API 的响应（见 downloadAppUpdate）。
  "download_app_update",
  // 运行下载好的更新器安装包并退出。路径必须在应用自己的 updates 目录里。
  "install_app_update",
  // 打开 Release 页面。只接受本仓库的 releases 前缀，不接受任意 URL —— 否则这就是一个
  // 「让用户的浏览器打开任意地址」的接口。
  "open_release",
  // 网络诊断：只探测三个写死的地址（GitHub API / Release 下载页 / 分发源），
  // 不接受渲染进程传 URL —— 否则就变成一个任意探测接口。
  "check_network",
  // 托盘与任务栏的更新状态。只收版本号与一个布尔值，不落盘。
  "set_tray_status",
  // 设置 → 存储：磁盘空间、缓存迁移与应用本体迁移。
  //
  // 迁移相关的命令都在主进程里重新校验路径/卷（不信任界面传值），并且只在
  // 当前缓存目录与 Windows 已识别的 AppxVolume 上操作。open_storage_settings
  // 只打开系统设置页，不接受参数。
  "get_storage_info",
  "precheck_cache_migration",
  "migrate_cache",
  "cancel_cache_migration",
  "get_app_migration_capability",
  "move_codex_app",
  "open_storage_settings",
]);

// 更新器自身版本与更新公告的唯一来源。仓库写死，不让渲染进程传 —— 那等于允许界面把
// 用户引到任意 GitHub 仓库去读「新版本」并下载。
const GITHUB_REPO = "aygzs123/Codex-Auto-Update-Plugin-New";
// 五分钟内复用一次结果，避免窗口反复刷新把未认证的 60 次/小时配额用完。
const GITHUB_CACHE_MS = 5 * 60 * 1000;

let devServer;
const dragOffsets = new Map();

// 最近一次 get_status 解析出的安装位置，供「打开安装目录」用。
//
// 为什么不写进上面那个静态白名单：这个路径随版本变化（目录名里带版本号），而且它是
// Windows 给的、不是我们拼的，没法枚举。所以改成主进程自己拿着 —— 界面显示的就是它报上去
// 的那个值，来源同一处，不经过渲染进程的手。
let lastInstallLocation = null;

// 窗口引用必须留在模块级：单实例锁的 second-instance、托盘菜单、窗口位置记忆都要用它。
// 以前 createWindow 的返回值被 whenReady 丢掉了，没有引用就唤不回一个已经存在的窗口。
let mainWindow = null;
let tray = null;

// 正在跑的长命令条数。关窗保护只认它 > 0。
let busyCommands = 0;
// 关窗确认框开着的时候别再弹第二个。
let closePromptOpen = false;
// app.quit() 触发的关闭（托盘退出、退出菜单）不该被托盘最小化或关窗保护拦下来。
let isQuitting = false;

// 会真的改动系统、且可能跑很久的命令。关窗保护只认它们。
//
// 「检查更新」刻意不在里面：它不改动任何东西，网络往返跑到一半关窗完全无害，
// 为它弹一句「确定要中断吗」是把用户当贼防，还会让人以为关窗有风险。
//
// 「清空缓存」在里面：它是全应用唯一会真的删掉用户数据的命令，删到一半关窗会留下
// 一个「删了几个、还剩几个」说不清的中间状态。它本身跑得不算久，但判据是「会不会
// 改动系统」，不是「跑多久」。
const LONG_COMMANDS = new Set([
  "download_codex",
  "install_codex",
  "repair_bundles",
  "launch_codex",
  "clear_cached_packages",
  // 更新器自己的安装包也要算：下到一半退出会留下一个说不清是否完整的临时文件，
  // 而且用户多半以为「再点一次会接着下」。上次下载的残留会在下次下载前清掉，但它仍然是长命令。
  "download_app_update",
  // 迁移会搬动几个 GB 并改设置/动应用卷：跑到一半关窗，用户会看到一个说不清的
  // 「复制了几个、设置切没切」。这两条都不该被当成可以随手中断的命令。
  "migrate_cache",
  "move_codex_app",
]);

// ---------- 设置 ----------

function settingsPath() {
  return join(app.getPath("userData"), "settings.json");
}

function readSettings() {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const merged = { ...readSettings(), ...patch };
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(settingsPath(), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}

// ---------- 主题 ----------

const THEME_VALUES = new Set(["system", "light", "dark"]);
const CHECK_INTERVAL_HOURS = [1, 3, 6, 12, 24];
const DEFAULT_CHECK_INTERVAL_HOURS = 6;

function normalizeTheme(value) {
  return THEME_VALUES.has(value) ? value : "system";
}

/**
 * 主题是全局开关，不是每个窗口各存一份。
 *
 * 设 `nativeTheme.themeSource` 之后，Chromium 的 `prefers-color-scheme` 会跟着它走，
 * 所以 CSS 那边一行都不用改 —— 界面里所有 `@media (prefers-color-scheme: dark)` 自动生效。
 * 窗口底色也由同一个值推导（见 windowBackgroundColor），不会出现「界面深色、打开时闪白光」。
 */
function applyTheme(theme) {
  nativeTheme.themeSource = normalizeTheme(theme);
}

/** 当前偏好与解析结果。preload 在首帧前同步读取它，避免闪白。 */
function currentThemeState() {
  return {
    preference: normalizeTheme(readSettings().theme),
    resolved: nativeTheme.shouldUseDarkColors ? "dark" : "light",
  };
}

function normalizeCheckInterval(value) {
  const hours = Number(value);
  return CHECK_INTERVAL_HOURS.includes(hours) ? hours : DEFAULT_CHECK_INTERVAL_HOURS;
}

// ---------- 缓存目录里的固定标记 ----------

const CACHE_PINS_FILE = ".codex-pins.json";

function currentCacheDirectory() {
  return codex.resolveDownloadDirectory(readSettings().downloadDirectory);
}

function cachePinsPath(directory) {
  return join(directory, CACHE_PINS_FILE);
}

function readCachePins(directory) {
  try {
    const parsed = JSON.parse(readFileSync(cachePinsPath(directory), "utf8"));
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writeCachePins(directory, pins) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(cachePinsPath(directory), `${JSON.stringify([...new Set(pins)], null, 2)}\n`, "utf8");
}

/**
 * 把界面传来的路径钉在「当前缓存目录里的一个 Codex 安装包」这一条上。
 *
 * 删除与固定都只接受这种路径。不能直接信 args.path：那会让这两条 IPC 变成「删任意文件」
 * 与「标记任意文件」的接口。文件名规则与 PowerShell 的 Get-CachedCodexPackages 一致。
 */
function resolveCachedPackage(directory, value) {
  const target = resolve(String(value || ""));
  if (target !== join(directory, basename(target))) throw new Error("安装包不在当前缓存目录里");
  if (!/^OpenAI\.Codex_.+\.(msix|msixbundle)$/i.test(basename(target))) throw new Error("不是 Codex 安装包");
  if (!existsSync(target)) throw new Error("安装包不存在");
  return target;
}

// ---------- 缓存目录监听 ----------

// 缓存目录里的文件变化（外部删除、下载完成、迁移清理）要能主动告诉界面。
// 监听器只在当前目录上存在一份：目录切换时必须先关掉旧的，否则界面会同时收到
// 两个目录的事件，而事件本身不带路径，界面无法分辨。
let cacheWatcher = null;
let cacheWatcherDirectory = null;
let cacheWatchTimer = null;

function closeCacheWatcher() {
  if (cacheWatchTimer) {
    clearTimeout(cacheWatchTimer);
    cacheWatchTimer = null;
  }
  if (cacheWatcher) {
    try {
      cacheWatcher.close();
    } catch {
      // 已经失效的监听器关不掉也无所谓，置空即可。
    }
    cacheWatcher = null;
  }
  cacheWatcherDirectory = null;
}

function notifyCacheChanged() {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("desktop:cache-changed");
  }
}

/**
 * 确保监听的是当前缓存目录。
 *
 * 300–500ms 防抖：一次清除或一次下载会在目录里产生多个事件，逐个转发会让界面
 * 连续重扫十几遍。事件里不带文件名 —— 只说明「变了」，内容仍由 list_cached_packages
 * 读取，避免监听通道变成第二个数据来源。
 */
function ensureCacheWatcher() {
  const directory = currentCacheDirectory();
  if (cacheWatcher && cacheWatcherDirectory === directory) return;
  closeCacheWatcher();
  try {
    cacheWatcher = watch(directory, { persistent: false }, () => {
      if (cacheWatchTimer) clearTimeout(cacheWatchTimer);
      cacheWatchTimer = setTimeout(() => {
        cacheWatchTimer = null;
        notifyCacheChanged();
      }, 400);
    });
    cacheWatcherDirectory = directory;
    cacheWatcher.on("error", () => closeCacheWatcher());
  } catch {
    // 目录还不存在（用户刚换到一个空文件夹）时监听会失败。等 list_cached_packages
    // 或下一次下载把目录建出来再挂，不在这里替用户创建目录。
    closeCacheWatcher();
  }
}

/**
 * 切换缓存目录。迁移与「保存设置」共用这一处，保证「落盘 → 重建监听 → 通知界面」
 * 三步顺序一致；任何一步单独漏掉，界面都会显示旧目录的内容。
 */
function applyCacheDirectory(value) {
  const saved = writeSettings({ downloadDirectory: String(value || "") });
  ensureCacheWatcher();
  notifyCacheChanged();
  return saved;
}

// ---------- 磁盘空间 ----------

/** 盘符标签只用于界面展示；不是盘符路径（例如 AppxVolume 的 UNC 形式）就原样显示。 */
function volumeLabel(path) {
  const match = /^([A-Za-z]):/.exec(String(path || ""));
  return match ? `${match[1].toUpperCase()} 盘` : String(path || "");
}

async function getStorageInfo() {
  // 安装位置优先用 get_status 记下来的那个值（bootstrap 时已经跑过一次）。
  // 没跑过才现场读一次，避免每次打开设置页都多起一个 PowerShell。
  if (!lastInstallLocation) {
    try {
      lastInstallLocation = (await codex.getStatus({ probe: false }))?.installLocation ?? null;
    } catch {
      lastInstallLocation = null;
    }
  }

  const cacheDirectory = currentCacheDirectory();
  const [downloadSpace, installSpace] = await Promise.all([
    cacheMigration.freeSpaceFor(cacheDirectory),
    lastInstallLocation ? cacheMigration.freeSpaceFor(lastInstallLocation) : Promise.resolve(null),
  ]);

  return {
    download: downloadSpace
      ? { path: cacheDirectory, totalBytes: downloadSpace.totalBytes, freeBytes: downloadSpace.freeBytes }
      : null,
    // Codex 未安装时这里是 null，界面显示「尚未安装」，不编一个 0。
    install:
      installSpace && lastInstallLocation
        ? { path: lastInstallLocation, totalBytes: installSpace.totalBytes, freeBytes: installSpace.freeBytes }
        : null,
  };
}

// ---------- 应用本体迁移 ----------

function parseJsonTail(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith("{")) continue;
    try {
      return JSON.parse(lines[index]);
    } catch {
      // 继续往前找：前面的行也可能是完整 JSON。
    }
  }
  return null;
}

/**
 * 读取 Codex 本体的迁移条件。
 *
 * 脚本只读（见 get-codex-app-migration.ps1）；这里再补上每个卷的真实剩余空间。
 * `movable` 只是本地条件判断 —— 执行结果仍以 Move-AppxPackage 之后回读的位置为准。
 */
async function getAppMigrationCapability() {
  const { stdout, stderr } = await ps.captureScript(codex.bundledScript("get-codex-app-migration.ps1"));
  const parsed = parseJsonTail(stdout);
  if (!parsed) {
    const detail = String(stderr || stdout || "").trim().split(/\r?\n/).slice(-3).join(" / ");
    throw new Error(detail || "迁移条件检测没有返回结果");
  }

  if (parsed.installLocation) lastInstallLocation = String(parsed.installLocation);

  const volumes = [];
  for (const volume of Array.isArray(parsed.volumes) ? parsed.volumes : []) {
    const path = String(volume?.path || "");
    if (!path) continue;
    const space = await cacheMigration.freeSpaceFor(path);
    volumes.push({
      path,
      label: volumeLabel(path),
      isSystemVolume: Boolean(volume?.isSystemVolume),
      freeBytes: space?.freeBytes ?? 0,
      totalBytes: space?.totalBytes ?? 0,
    });
  }

  return {
    installed: Boolean(parsed.installed),
    version: parsed.version ? String(parsed.version) : null,
    installLocation: parsed.installLocation ? String(parsed.installLocation) : null,
    packageVolume: parsed.packageVolume ? String(parsed.packageVolume) : null,
    movable: Boolean(parsed.movable),
    reason: String(parsed.reason || ""),
    volumes,
  };
}

async function confirmMoveApp(capability, target) {
  const options = {
    type: "warning",
    title: "迁移 Codex",
    message: `要把 Codex 迁移到 ${target.path} 吗？`,
    detail:
      "迁移使用 Windows 包部署服务。迁移期间 Codex 会被关闭，并会弹出一次管理员授权（UAC）。" +
      "配置、会话、日志与项目目录不会一起迁移，它们仍留在原来的用户目录。" +
      "迁移完成后会重新读取安装位置，更新、修复、启动与回退都按新位置工作。",
    buttons: ["取消", "迁移"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return response === 1;
}

/**
 * 执行应用本体迁移。
 *
 * 目标卷必须出现在当前检测结果里 —— 界面传什么就移动什么等于允许渲染进程把用户的
 * Codex 扔到一个任意「卷」上。确认框在主进程里弹（默认取消），UAC 由脚本自行请求；
 * 用户拒绝授权是正常结果，不是异常。
 */
async function moveCodexApp(args) {
  const requested = String(args?.volume || "").trim();
  if (!requested) throw new Error("没有指定目标应用卷");

  const capability = await getAppMigrationCapability();
  if (!capability.installed) throw new Error("没有检测到已安装的 Codex，无法迁移。");
  if (!capability.movable) throw new Error(capability.reason || "当前包不满足迁移条件。");

  const target = capability.volumes.find((volume) => volume.path.toLowerCase() === requested.toLowerCase());
  if (!target) throw new Error("目标卷不在 Windows 已识别的 AppxVolume 列表里。");
  if (capability.packageVolume && target.path.toLowerCase() === capability.packageVolume.toLowerCase()) {
    throw new Error("目标卷就是 Codex 当前所在的卷，不需要迁移。");
  }

  if (!(await confirmMoveApp(capability, target))) {
    return { ok: false, cancelled: true, installLocation: capability.installLocation, message: "已取消迁移，Codex 没有被移动。" };
  }

  const resultPath = join(app.getPath("temp"), `codex-app-move-${process.pid}-${Date.now()}.json`);
  try {
    const { stdout, stderr } = await ps.captureScript(codex.bundledScript("move-codex-app.ps1"), {
      values: { "-Volume": target.path, "-ResultPath": resultPath },
    });

    // 提权子进程的 stdout 拿不到，结果以它写下的 JSON 文件为准；没有文件时退回
    // 父进程 stdout（非提权路径或脚本提前失败时会有）。
    const raw = existsSync(resultPath) ? readFileSync(resultPath, "utf8") : stdout;
    const parsed = parseJsonTail(raw);
    if (!parsed) {
      const detail = String(stderr || stdout || "").trim().split(/\r?\n/).slice(-3).join(" / ");
      throw new Error(detail || "迁移脚本没有返回可解析的结果");
    }

    if (parsed.installLocation) lastInstallLocation = String(parsed.installLocation);
    else {
      // 失败时也回读一次：脚本退出前可能已经把包移走了一半，界面必须以真实位置为准。
      try {
        lastInstallLocation = (await codex.getStatus({ probe: false }))?.installLocation ?? lastInstallLocation;
      } catch {
        // 读不到就保留旧值，界面上「检测迁移条件」会重新读。
      }
    }

    return {
      ok: Boolean(parsed.ok),
      cancelled: false,
      installLocation: parsed.installLocation ? String(parsed.installLocation) : lastInstallLocation,
      message: String(parsed.message || (parsed.ok ? "迁移完成。" : "迁移没有完成。")),
    };
  } finally {
    try {
      unlinkSync(resultPath);
    } catch {
      // 临时结果文件删不掉不影响迁移本身。
    }
  }
}

// ---------- 托盘与任务栏状态 ----------

let trayStatus = { version: null, downloading: false };

/**
 * 托盘角标：16×16 的实心圆点，用 BGRA 原位图直接生成。
 *
 * 不用图片文件：这是唯一一个运行期要用的 overlay 图标，为它多带一个资源文件、再处理
 * 打包路径，不值得。任务栏 overlay 只在有更新或在下载时出现，其余时候清掉。
 */
function trayOverlayIcon() {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - 7.5;
      const dy = y - 7.5;
      if (dx * dx + dy * dy > 34) continue;
      const offset = (y * size + x) * 4;
      buffer[offset] = 40; // B
      buffer[offset + 1] = 60; // G
      buffer[offset + 2] = 235; // R
      buffer[offset + 3] = 255; // A
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

function trayTooltip() {
  if (trayStatus.downloading) return "Codex Updater · 正在下载更新包";
  if (trayStatus.version) return `Codex Updater · 可更新到 ${trayStatus.version}`;
  return "Codex Updater";
}

function applyTrayStatus() {
  if (tray) tray.setToolTip(trayTooltip());
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (trayStatus.version) {
    mainWindow.setOverlayIcon(trayOverlayIcon(), trayTooltip());
  } else {
    mainWindow.setOverlayIcon(null, "");
  }
}

function setTrayStatus(args) {
  const version = String(args?.version || "").slice(0, 40) || null;
  trayStatus = { version, downloading: Boolean(args?.downloading) };
  applyTrayStatus();
  return { ok: true };
}

// ---------- GitHub Release（固定版本 / 更新公告） ----------

// 上一次成功读取的结果。落盘不只是为了省配额：固定版本策略在公司网络断掉时
// 不能突然变成「没有固定版本」，那会让所有人被提示升级到商店最新版。
let githubCache = null;

function githubCachePath() {
  return join(app.getPath("userData"), "github-cache.json");
}

function readGithubCache() {
  try {
    const parsed = JSON.parse(readFileSync(githubCachePath(), "utf8"));
    return parsed && typeof parsed === "object" && parsed.data ? parsed : null;
  } catch {
    return null;
  }
}

function writeGithubCache(cache) {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(githubCachePath(), `${JSON.stringify(cache)}\n`, "utf8");
  } catch {
    // 写缓存失败不该让一次正常的 GitHub 查询变成错误：顶多下次再查一遍。
  }
}

/**
 * 一次只读的 GitHub JSON 请求。
 *
 * 走 Electron 的 net 而不是 node:https：它会用系统代理设置，和用户在同一个网络环境下
 * 打开浏览器时的行为一致。带 User-Agent 是 GitHub API 的硬性要求。
 */
function requestJson(url, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: "GET", url });
    request.setHeader("Accept", "application/vnd.github+json");
    request.setHeader("User-Agent", "Codex-Updater");
    const timer = setTimeout(() => {
      request.abort();
      reject(new Error("GitHub 请求超时"));
    }, timeoutMs);

    request.on("response", (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        clearTimeout(timer);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const hint = response.statusCode === 403 ? "（可能触发了 GitHub API 限流）" : "";
          reject(new Error(`GitHub 返回 ${response.statusCode}${hint}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("GitHub 返回的不是 JSON"));
        }
      });
      response.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

/**
 * 取更新器自身的新版本与更新公告。
 *
 * 返回结构固定为 { updater, announcements, error, stale }：网络失败不抛给渲染进程，而是
 * 带上 error 与上次成功的结果 —— 公告不该因为一次断网就整块消失。
 */
async function getGithubUpdates(force = false) {
  if (githubCache === null) githubCache = readGithubCache();
  if (!force && githubCache && Date.now() - githubCache.at < GITHUB_CACHE_MS) {
    return { ...githubCache.data, error: null, stale: false };
  }
  try {
    const data = await github.fetchGithubUpdates({
      fetchJson: requestJson,
      repo: GITHUB_REPO,
      currentVersion: app.getVersion(),
    });
    githubCache = { at: Date.now(), data };
    writeGithubCache(githubCache);
    return { ...data, error: null, stale: false };
  } catch (error) {
    if (githubCache?.data) return { ...githubCache.data, error: error.message, stale: true };
    return { updater: null, announcements: [], error: error.message, stale: true };
  }
}

// ---------- 更新器自身更新 ----------

// 本仓库 Release 资产的下载前缀。这是应用内自更新唯一允许的下载地址空间。
const APP_UPDATE_PREFIX = `https://github.com/${GITHUB_REPO}/releases/download/`;
// 同一时间只允许一条下载：两条并发会写同一个目录，最后谁覆盖谁都说不清。
let appUpdateDownloading = false;

function appUpdatesRoot() {
  const root = join(app.getPath("userData"), "updates");
  mkdirSync(root, { recursive: true });
  return root;
}

/**
 * 按 URL 找到资产，并校验「能校验、可安装」。
 *
 * 摘要只认主进程自己从 GitHub API 拿到的那个值 —— 不接受渲染进程传摘要，否则「校验」
 * 就退化成「界面说它是好的」。没有摘要直接拒绝：无法校验不等于校验通过。
 */
async function resolveAppUpdateAsset(url) {
  if (!url.startsWith(APP_UPDATE_PREFIX)) throw new Error("更新包地址不在本仓库的 Release 下载路径下");
  let data = await getGithubUpdates(false);
  let asset = (data?.updater?.assets ?? []).find((candidate) => candidate.url === url) ?? null;
  if (!asset) {
    // 缓存可能刚好过期或换过一版 Release，强制重拉一次再找。
    data = await getGithubUpdates(true);
    asset = (data?.updater?.assets ?? []).find((candidate) => candidate.url === url) ?? null;
  }
  if (!asset) throw new Error("GitHub 上找不到这个更新包");
  if (!asset.name.toLowerCase().endsWith(".exe")) throw new Error("更新包不是 .exe");
  const digest = String(asset.digest || "");
  if (!/^sha256:[0-9a-f]{64}$/i.test(digest)) throw new Error("这个更新包没有 SHA-256 摘要，无法校验");
  return { ...asset, sha256: digest.slice("sha256:".length).toLowerCase() };
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** 把一个已存在的 .part 先读进哈希状态，后面的分片接着往里追加。 */
function hashExistingFile(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash));
  });
}

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

/** 一次下载尝试：支持从 startOffset 断点续传，边下边算 SHA-256。 */
async function downloadAppUpdateFile(asset, partialPath, emit, startOffset = 0) {
  let baseHash = null;
  if (startOffset > 0) {
    try {
      baseHash = await hashExistingFile(partialPath);
    } catch {
      // 临时文件读不了就当没有断点，从头下。
      startOffset = 0;
    }
  }

  return new Promise((resolveDownload, rejectDownload) => {
    const request = net.request({ method: "GET", url: asset.url });
    request.setHeader("Accept", "application/octet-stream");
    request.setHeader("User-Agent", "Codex-Updater");
    // 只有真的存在一段可复用的前缀时才发 Range。服务器不支持断点续传时会回 200
    // 并从头给全文，下面按「覆盖写」处理，不会把两份内容接在一起。
    if (startOffset > 0) request.setHeader("Range", `bytes=${startOffset}-`);

    let hash = baseHash ?? createHash("sha256");
    let received = startOffset;
    let total = asset.size > 0 ? asset.size : 0;
    let lastEmit = 0;
    let settled = false;
    const timer = setTimeout(() => {
      request.abort();
      fail(new Error("更新包下载超时"));
    }, 10 * 60 * 1000);

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectDownload(error);
    }

    function done() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveDownload(hash.digest("hex"));
    }

    request.on("response", (response) => {
      if (response.statusCode === 416) {
        // Range 起点越过了文件末尾：说明这个 .part 已经没有继续用的价值了。
        // 删掉它，下一次尝试会从 0 开始。
        try {
          unlinkSync(partialPath);
        } catch {
          // 删不掉也无妨，调用方会把它当成一次失败。
        }
        fail(new Error("断点位置无效，已重新开始下载"));
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        fail(new Error(`更新包下载失败：HTTP ${response.statusCode}`));
        return;
      }

      let append = startOffset > 0;
      if (response.statusCode === 200 && startOffset > 0) {
        // 服务器忽略了 Range：这份响应是完整文件，必须覆盖写，并且重新开始算摘要。
        append = false;
        received = 0;
        hash = createHash("sha256");
      }
      const length = Number(response.headers["content-length"]);
      if (Number.isFinite(length) && length > 0) total = append ? startOffset + length : length;
      if (startOffset > 0 && append) emit({ kind: "progress", received, total });

      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          hash.update(chunk);
          const now = Date.now();
          if (now - lastEmit >= 200) {
            lastEmit = now;
            emit({ kind: "progress", received, total });
          }
          callback(null, chunk);
        },
      });

      pipeline(response, meter, createWriteStream(partialPath, { flags: append ? "a" : "w" })).then(done).catch(fail);
    });
    request.on("error", fail);
    request.end();
  });
}

const APP_UPDATE_ATTEMPTS = 3;

/**
 * 下载更新器自己的安装包。
 *
 * 只接受本仓库 Release 资产、只认 .exe、必须带 GitHub 计算的摘要；下载到专用 updates
 * 目录，校验通过后才原子改名成正式文件。
 *
 * 失败重试 3 次，并且**尽量接着上一段的 .part 继续下**：几百 MB 的包在坏网络下断一次就
 * 从头来，用户看到的是进度条反复归零。网络错误保留 .part 供下一轮 Range 续传；摘要/大小
 * 对不上则说明这段内容本身有问题，删掉重下，不能把损坏的前缀接在下一份后面。
 * 三次都失败才清掉临时文件。
 */
async function downloadAppUpdate(args, emit) {
  if (appUpdateDownloading) throw new Error("已经有一个更新包在下载");
  const url = String(args?.url || "");
  const asset = await resolveAppUpdateAsset(url);
  const root = appUpdatesRoot();
  const target = join(root, asset.name);
  const partial = `${target}.part`;

  appUpdateDownloading = true;
  try {
    // 清掉上一次的残留（旧版本的安装包 / 半截 .part）。updates 目录只服务「这一次」，
    // 留在里面的旧安装包既不会被用到，又白占一百多 MB。
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (basename(path) === basename(partial)) continue;
      try {
        unlinkSync(path);
      } catch {
        // 删不掉（被占用）就算了，下次再试；不能因此让本次下载失败。
      }
    }

    let lastError = null;
    for (let attempt = 1; attempt <= APP_UPDATE_ATTEMPTS; attempt += 1) {
      const offset = fileSize(partial);
      try {
        if (offset > 0) {
          emit({ kind: "progress", received: offset, total: asset.size, attempt, resuming: true });
        }
        const sha256 = await downloadAppUpdateFile(asset, partial, emit, offset);
        const size = fileSize(partial);
        if (sha256 !== asset.sha256) {
          // 内容已经不对了，续传没有意义：删掉，下一轮从 0 开始。
          try {
            unlinkSync(partial);
          } catch {
            // 见上。
          }
          throw new Error("更新包 SHA-256 校验失败，已丢弃");
        }
        if (asset.size > 0 && size !== asset.size) {
          try {
            unlinkSync(partial);
          } catch {
            // 见上。
          }
          throw new Error(`更新包大小不符（${size} / ${asset.size}）`);
        }
        renameSync(partial, target);
        emit({ kind: "progress", received: size, total: size });
        return { path: target, size, sha256, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (attempt < APP_UPDATE_ATTEMPTS) {
          emit({
            kind: "progress",
            received: fileSize(partial),
            total: asset.size,
            attempt,
            retrying: true,
            message: String(error?.message || error),
          });
          await wait(1000 * attempt);
        }
      }
    }

    try {
      unlinkSync(partial);
    } catch {
      // 清理失败不应该盖掉真正的错误。
    }
    throw lastError ?? new Error("更新包下载失败");
  } finally {
    appUpdateDownloading = false;
  }
}

/**
 * 运行下载好的安装包。per-user NSIS 安装器，静默安装后自己启动新版本。
 *
 * 不请求提权：后台/应用内更新一旦弹 UAC，就成了「点了检查更新，回来发现卡在一个要密码
 * 的窗口后面」。路径必须在应用自己的 updates 目录里，后缀必须是 .exe。
 */
function installAppUpdate(args) {
  if (!app.isPackaged) throw new Error("开发模式下不安装更新包");
  const root = appUpdatesRoot();
  const target = resolve(String(args?.path || ""));
  if (target !== join(root, basename(target))) throw new Error("更新包不在应用的更新目录里");
  if (!target.toLowerCase().endsWith(".exe")) throw new Error("更新包不是 .exe");
  if (!existsSync(target)) throw new Error("更新包不存在，请重新下载");

  const child = spawn(target, ["--updated", "/S", "--force-run"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  // 先放行关闭流程，再退出：否则托盘/关窗保护会把这次退出当成「用户点了关闭」。
  isQuitting = true;
  app.quit();
  return { ok: true };
}

// ---------- 窗口位置记忆 ----------

// 首次打开就按「内容能完整摆下」的尺寸开，别让用户先手动拖一次：设置页是双栏
// 工作台（侧栏 + 内容），1120 宽会把卡片里的按钮和路径行挤到换行。高度同理，
// 780 只露出半张设置页。小屏上这两个值仍会被工作区裁掉（见 createWindow）。
const DEFAULT_WIDTH = 1180;
const DEFAULT_HEIGHT = 860;
const MIN_WIDTH = 760;
const MIN_HEIGHT = 640;

/** 读上次的窗口矩形。任何一项不是有限数就当没存过 —— 半个矩形比没有更糟。 */
function storedWindowBounds() {
  const bounds = readSettings().windowBounds;
  if (!bounds || typeof bounds !== "object") return null;
  const values = [bounds.x, bounds.y, bounds.width, bounds.height].map(Number);
  if (!values.every(Number.isFinite)) return null;
  return {
    x: values[0],
    y: values[1],
    width: Math.max(MIN_WIDTH, values[2]),
    height: Math.max(MIN_HEIGHT, values[3]),
    maximized: bounds.maximized === true,
  };
}

/**
 * 这块矩形还落在某个显示器上吗。
 *
 * 这一步不是为了好看：用户上次把窗口拖到外接显示器上，这次拔了显示器再打开，窗口就会开到
 * 一块不存在的屏幕上 —— 任务栏里有图标、点了也有反应，但屏幕上什么都看不到。用户的结论
 * 只会是「这软件坏了」，而它其实开得好好的。交集多大不重要，有一块可见就够。
 */
function isVisibleOnSomeDisplay(bounds) {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    );
  });
}

function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const maximized = mainWindow.isMaximized();
  // 最大化时 getBounds() 给的是整屏尺寸，直接存下来，下次还原就成了一个「占满屏幕的普通
  // 窗口」—— 用户再点最大化只会发现没反应。存 getNormalBounds() 才是还原时该回去的那个矩形。
  const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  writeSettings({
    windowBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized },
  });
}

// ---------- 图标与托盘 ----------

function iconPath() {
  // 打包后 resources/icon.ico 由 electron-builder 的 extraResources 放到 resources/ 下；
  // 开发时直接读仓库里那份。
  return app.isPackaged ? join(process.resourcesPath, "icon.ico") : join(projectRoot, "resources", "icon.ico");
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * 托盘图标按需创建，创建后不再销毁。
 *
 * 「按需」是指只在真的需要它的时候建：启动就带了 --hidden，或者用户关窗时按设置最小化到托盘。
 * 两个开关都关着却常驻一个托盘图标，那是白白多一个用户没要的东西。
 * 「创建后不销毁」是另一回事：托盘图标反复建/拆会让通知区域闪来闪去，而且窗口藏起来之后
 * 用户还得靠它把窗口找回来，拆了就真找不回来了。
 */
function ensureTray() {
  if (tray) return tray;
  const icon = iconPath();
  if (!existsSync(icon)) {
    // 图标缺失不该让整个应用起不来（开发机上删过 resources 就是这样）。托盘只是少一个入口，
    // 窗口和主流程都不依赖它，所以这里只报一句、继续跑。
    console.error(`托盘图标缺失，跳过托盘：${icon}`);
    return null;
  }
  tray = new Tray(icon);
  tray.setToolTip(trayTooltip());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示主界面", click: () => showMainWindow() },
      // 先把窗口叫出来再发命令：检查的结论落在界面上，窗口藏着的用户看到通知会想知道细节。
      {
        label: "立即检查更新",
        click: () => {
          showMainWindow();
          sendMenuAction("check");
        },
      },
      {
        label: "查看更新公告",
        click: () => {
          showMainWindow();
          sendMenuAction("announce");
        },
      },
      {
        label: "打开缓存目录",
        click: () => {
          const directory = currentCacheDirectory();
          try {
            mkdirSync(directory, { recursive: true });
          } catch {
            // 目录建不出来时 openPath 会把系统错误原样返回，交给下面的 catch。
          }
          void shell.openPath(directory).catch((error) => console.error("打开缓存目录失败：", error));
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("double-click", () => showMainWindow());
  applyTrayStatus();
  return tray;
}

/**
 * 把「开机自动启动」落到注册表。
 *
 * 只在打包态真的调用：开发模式下 process.execPath 是 node_modules 里的 electron.exe，
 * 注册它只会留下一个开机就报错的启动项（而且指向一个随时会被 npm 删掉的路径）。
 * 设置值本身照常落盘 —— 装成正式版之后那次启动会按记忆值补上。
 */
function applyLoginItem(enabled) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: enabled ? ["--hidden"] : [] });
}

// ---------- 主题 ----------

/**
 * 窗口底色。
 *
 * 这个值只在「页面还没画出来」的那一瞬间可见，但深色系统下用浅色值就是一道白光 —— 用户
 * 看到的是「打开就闪一下」，观感上比界面本身没适配深色还差。CSS 那边不用管 NativeTheme：
 * Chromium 的 prefers-color-scheme 自己就跟着系统走。
 */
function windowBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? "#16181d" : "#edf1f7";
}

// ---------- 后台复查 ----------

/**
 * 后台模式下「自己再查一遍」的间隔。
 *
 * 默认 6 小时：开机的那个进程会常驻好几天，只在启动那一下查一次是不够的；但查一次是一次
 * 真实的网络往返（脚本侧还有三层兜底重试），按小时算的间隔既够用又不至于变成定时骚扰。
 * 用户可以在设置里从 1 / 3 / 6 / 12 / 24 小时里选。
 */
let backgroundTimer = null;

function backgroundCheckIntervalMs(settings = readSettings()) {
  return normalizeCheckInterval(settings.checkIntervalHours) * 60 * 60 * 1000;
}

/**
 * 按设置值决定要不要后台复查。
 *
 * 三个条件同时成立才会有定时器：
 *   1. 用户没有关掉「自动检查更新」（autoCheck 默认开）；
 *   2. 后台模式开着 —— 托盘常驻或开机自启。只有这两种情况下进程才会活很久；
 *   3. 间隔是设置里那个值。
 * 任一条件不成立，进程随窗口一起退出（或用户明确不要自动检查），定时器纯属多余。
 */
function applyBackgroundTimer() {
  if (backgroundTimer) {
    clearInterval(backgroundTimer);
    backgroundTimer = null;
  }
  const settings = readSettings();
  if (settings.autoCheck === false) return;
  if (!settings.minimizeToTray && !settings.launchAtLogin) return;

  backgroundTimer = setInterval(() => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("desktop:background-check");
    }
  }, backgroundCheckIntervalMs(settings));
}

/**
 * 「发现新版本」的系统通知。
 *
 * 三道判据缺一不可，而且**都在主进程**——因为依据都在这里：
 *   1. 窗口可见且聚焦时不弹。用户正盯着界面，顶栏已经写着「可更新到 X」，再弹一条是重复打扰。
 *   2. 同一个版本只提醒一次（落盘记 lastNotifiedVersion）。开机三次提醒三次，用户会把通知关掉，
 *      那以后真的该提醒时也就没人看了。
 *   3. 系统支持通知。
 *
 * 通知只说「可更新到 X」，**不带任何安装按钮**：需要提权的安装永远由人点（见 AGENTS.md）。
 */
// 「自动下载完成」是同一版本的第二次提醒，不该被 lastNotifiedVersion 挡掉。
// 它只在本进程里有效：下载状态本身也没落盘，重启后重新检查即可。
let lastDownloadedNotified = null;

function notifyUpdate(args) {
  const version = String(args.version || "");
  if (!version) return { shown: false, reason: "no-version" };
  // 用户可以在设置里整个关掉通知。默认开 —— 关掉之后自动检查仍然照常跑，只是不出声。
  if (readSettings().notifyUpdates === false) return { shown: false, reason: "disabled" };

  const downloaded = args.downloaded === true;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    return { shown: false, reason: "focused" };
  }
  if (downloaded ? lastDownloadedNotified === version : readSettings().lastNotifiedVersion === version) {
    return { shown: false, reason: "already-notified" };
  }
  if (!Notification.isSupported()) return { shown: false, reason: "unsupported" };

  const notification = new Notification({
    title: "Codex 有新版本",
    body: downloaded
      ? `已自动下载 ${version} 的安装包，打开更新器即可安装。`
      : `可更新到 ${version}，点这里打开更新器查看。`,
  });
  notification.on("click", () => showMainWindow());
  notification.show();
  // 通知成功弹出去之后才记下来。先记再弹的话，弹失败（比如被系统静音）也会被当成
  // 「已经提醒过」，这个版本就再也不会提醒了。
  if (downloaded) lastDownloadedNotified = version;
  else writeSettings({ lastNotifiedVersion: version });
  return { shown: true };
}

// ---------- 网络诊断 ----------

// 只探这三个写死的地址，渲染进程传不进来 URL。它们正好覆盖应用要走的几条网络路径：
// 读公告/版本（GitHub API）、下更新器安装包（Release 下载）、查 Codex 新版本（分发源）。
const NETWORK_TARGETS = [
  { id: "github-api", label: "GitHub API（版本与更新公告）", url: `https://api.github.com/repos/${GITHUB_REPO}` },
  { id: "github-release", label: "GitHub 更新下载", url: `https://github.com/${GITHUB_REPO}/releases/latest` },
  { id: "store-index", label: "Microsoft 分发源索引", url: "https://store.rg-adguard.net/" },
];

/** 只等响应头：能拿到状态码就说明这一跳通了，不需要把页面正文下回来。 */
function probeUrl(url, timeoutMs = 8000) {
  return new Promise((resolveProbe, rejectProbe) => {
    const started = Date.now();
    const request = net.request({ method: "GET", url });
    request.setHeader("User-Agent", "Codex-Updater");
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      request.abort();
      finish(rejectProbe, new Error("连接超时"));
    }, timeoutMs);

    request.on("response", (response) => {
      const latencyMs = Date.now() - started;
      response.on("error", () => {});
      try {
        response.destroy();
      } catch {
        // 只要头，正文不读了。
      }
      finish(resolveProbe, { status: response.statusCode, latencyMs });
    });
    request.on("error", (error) => finish(rejectProbe, error));
    request.end();
  });
}

/**
 * 网络与代理诊断。
 *
 * 返回值里的 proxy 是 Chromium 实际采用的代理规则（DIRECT / PROXY ...）。应用用
 * Electron 的 net 发请求，走的就是它 —— 用户在浏览器里正常、应用里连不上时，这一行往往是
 * 唯一能解释差别的证据。命令只读，不写任何设置。
 */
async function checkNetwork() {
  let proxy = "";
  try {
    proxy = await session.defaultSession.resolveProxy("https://api.github.com/");
  } catch {
    proxy = "";
  }
  const results = await Promise.all(
    NETWORK_TARGETS.map(async (target) => {
      try {
        const { status, latencyMs } = await probeUrl(target.url);
        return {
          ...target,
          ok: status >= 200 && status < 400,
          status,
          latencyMs,
          error: null,
        };
      } catch (error) {
        return { ...target, ok: false, status: null, latencyMs: null, error: String(error?.message || error) };
      }
    }),
  );
  return { checkedAt: Date.now(), proxy, results };
}

// ---------- 缓存：逐个固定与删除 ----------

/**
 * 删除一个缓存里的安装包。
 *
 * 和「清空缓存」一样先弹原生确认框（默认「取消」）：这是不可撤销的删除，误点的代价是
 * 再也回不到那个版本。路径只接受当前缓存目录里的 Codex 安装包（resolveCachedPackage）。
 */
async function deleteCachedPackage(args) {
  const directory = currentCacheDirectory();
  const target = resolveCachedPackage(directory, args?.path);
  const options = {
    type: "warning",
    title: "删除安装包",
    message: `要删除 ${basename(target)} 吗？`,
    detail: "已安装的 Codex 不受影响。但删除后无法再用它回退或重装，需要时得重新下载。",
    buttons: ["取消", "删除"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  if (response !== 1) return { cancelled: true };

  unlinkSync(target);
  // 文件没了，固定标记也不该留着：下次下载同名包时不该继承一个「已固定」的状态。
  try {
    writeCachePins(
      directory,
      readCachePins(directory).filter((name) => name !== basename(target)),
    );
  } catch {
    // 标记写不进去不影响删除结果。
  }
  return { deleted: true, path: target };
}

/** 固定 / 取消固定一个安装包。固定之后自动剪枝会跳过它（见 CodexStoreUpdater.psm1）。 */
function pinCachedPackage(args) {
  const directory = currentCacheDirectory();
  const target = resolveCachedPackage(directory, args?.path);
  const name = basename(target);
  const pins = new Set(readCachePins(directory));
  if (args?.pinned === false) pins.delete(name);
  else pins.add(name);
  writeCachePins(directory, [...pins]);
  return { pinned: pins.has(name), pinnedPaths: [...pins] };
}

// ---------- 命令 ----------

function progressReporter(sender) {
  return (event) => {
    if (!sender.isDestroyed()) sender.send("desktop:progress", event);
    // 顺带喂任务栏进度条。所有 desktop:progress 事件都从这里过，所以这里一处就够，
    // 不需要新的 IPC，也不用改 codex.cjs —— 窗口被别的窗口盖住时，任务栏上还能看见
    // 「在下载」。这是纯粹的附加显示，渲染进程那边的进度条该怎样还怎样。
    const window = BrowserWindow.fromWebContents(sender);
    if (!window || window.isDestroyed()) return;
    if (event.kind === "phase" && typeof event.percent === "number") {
      window.setProgressBar(Math.min(1, Math.max(0, event.percent / 100)));
    } else if (event.kind === "download-bytes") {
      // 2 = 不确定态（一根来回跑的条）。下载总量是脚本那边算不出来的，编一个百分比
      // 反而会让进度条先跑到头再跳回去，比不确定态更难看。
      window.setProgressBar(2);
    }
  };
}

async function executeCommand(event, command, args = {}) {
  if (!allowedCommands.has(command)) throw new Error(`不允许执行命令：${command}`);
  const emit = progressReporter(event.sender);

  switch (command) {
    case "get_status": {
      const status = await codex.getStatus({ probe: false });
      // 顺手记下安装位置：「打开安装目录」要用，而它必须是主进程解析出来的值。
      lastInstallLocation = status?.installLocation ?? null;
      return status;
    }
    case "check_update":
      // 保留份数由设置决定：0 = 桌面端默认的「不自动清理」（-KeepAll），N>0 = 保留最近 N 个。
      // 和下面 install_codex 一样放在 args 之后，渲染进程传什么都不许覆盖这个策略。
      return codex.checkUpdate({ ...args, cacheKeepCount: readSettings().cacheKeepCount });
    case "download_codex":
      return codex.downloadCodex({ ...args, cacheKeepCount: readSettings().cacheKeepCount }, emit);
    case "verify_download_signature":
      return codex.verifySignature(args);
    case "install_codex":
      // 剪枝目录在这里解析并传下去：codex.cjs 不读 settings（那是 main 的职责），
      // 而 worker 必须在**缓存目录**里剪枝，不能从安装包路径反推 —— 路径是界面给的，
      // 反推出来的目录未必是缓存，剪错目录会把不相干的安装包删掉。
      return codex.installCodex(
        {
          ...args,
          downloadDirectory: codex.resolveDownloadDirectory(readSettings().downloadDirectory),
          cacheKeepCount: readSettings().cacheKeepCount,
        },
        emit,
      );
    case "list_cached_packages": {
      // 「版本历史 / 回退」要用的缓存清单。只读，不写任何东西；固定状态来自缓存目录里的
      // .codex-pins.json，由下面的 pin_cached_package 维护。
      const list = await codex.listCachedPackages(args);
      const directory = codex.resolveDownloadDirectory(args.downloadDirectory ?? readSettings().downloadDirectory);
      const pins = new Set(readCachePins(directory));
      // 目录此时已经存在（脚本刚读过），是挂监听的时机。用户换目录后这里会重建。
      ensureCacheWatcher();
      return {
        ...list,
        packages: list.packages.map((pkg) => ({ ...pkg, pinned: pins.has(basename(pkg.path)) })),
      };
    }
    case "pin_cached_package":
      return pinCachedPackage(args);
    case "delete_cached_package":
      return deleteCachedPackage(args);
    case "clear_cached_packages": {
      // 桌面端不再自动剪枝（见 codex.cjs 的 KEEP_ALL_CACHE），所以这是用户回收磁盘空间的
      // 唯一手段，也是唯一一个会真的删掉用户数据的命令 —— 先确认再动手。
      // 用户在确认框里点了「取消」时返回 cancelled 而不是抛错：取消是正常选择，
      // 不是失败，界面上不该出现一条红色的错误。
      const confirmed = await confirmClearCache();
      if (!confirmed) return { cancelled: true };
      return codex.clearCachedPackages(args);
    }
    case "launch_codex":
      // 启动要等主窗口出现（最多 20 秒），期间必须把进展推给界面，
      // 否则等待期就是一段「点了没反应」。
      return codex.launchCodex(args, emit);
    case "check_health":
      return codex.getStatus({ probe: Boolean(args.probe) });
    case "repair_bundles":
      return codex.repairBundles(args, emit);
    case "get_settings":
      return { ...readSettings(), defaultDownloadDirectory: codex.downloadsRoot(), logsDirectory: codex.logsRoot() };
    case "save_settings": {
      // 按 args 里**实际出现**的键组 patch，不能写成定长对象：
      // writeSettings 是浅合并，而 `{ downloadDirectory: String(args.downloadDirectory ?? "") }`
      // 这种写法在 args 没带这个键时会把它写成空串 —— 用户只是拨了一下「开机自启」的开关，
      // 自定义缓存目录就被悄悄抹掉了。
      const patch = {};
      if ("downloadDirectory" in args) patch.downloadDirectory = String(args.downloadDirectory ?? "");
      if ("minimizeToTray" in args) patch.minimizeToTray = Boolean(args.minimizeToTray);
      if ("launchAtLogin" in args) patch.launchAtLogin = Boolean(args.launchAtLogin);
      // 版本历史卡片是纯展示，隐藏它不动磁盘上的任何东西（缓存里的安装包照旧留着，
      // 回退入口仍然在失败告警里）。清缓存是另一个明确的动作，见 clear_cached_packages。
      if ("showVersionHistory" in args) patch.showVersionHistory = Boolean(args.showVersionHistory);
      // 已关闭的公告 id。限制条数：这些 id 只增不减，不设上限迟早把配置文件撑大。
      if ("dismissedTips" in args) {
        patch.dismissedTips = Array.isArray(args.dismissedTips) ? args.dismissedTips.map(String).slice(-20) : [];
      }
      // 外观与更新策略。值在主进程归一化：界面传 "auto"、99 小时这种值进来也不会落盘。
      if ("theme" in args) patch.theme = normalizeTheme(args.theme);
      if ("autoCheck" in args) patch.autoCheck = Boolean(args.autoCheck);
      if ("autoDownload" in args) patch.autoDownload = Boolean(args.autoDownload);
      if ("notifyUpdates" in args) patch.notifyUpdates = Boolean(args.notifyUpdates);
      if ("checkIntervalHours" in args) patch.checkIntervalHours = normalizeCheckInterval(args.checkIntervalHours);
      if ("cacheKeepCount" in args) {
        const count = Number(args.cacheKeepCount);
        // 0 = 不自动清理；上限 10，避免界面被填进一个离谱的数字后把缓存全删了。
        patch.cacheKeepCount = Number.isFinite(count) && count >= 0 ? Math.min(Math.round(count), 10) : 0;
      }
      const saved = writeSettings(patch);
      // 这些开关不只是落盘，还要真的动系统与本进程：自启要写注册表，后台复查要起/停定时器，
      // 主题要改 nativeTheme（CSS 的 prefers-color-scheme 会自动跟上）。
      if ("launchAtLogin" in patch) applyLoginItem(saved.launchAtLogin);
      if (
        "minimizeToTray" in patch ||
        "launchAtLogin" in patch ||
        "autoCheck" in patch ||
        "checkIntervalHours" in patch
      ) {
        applyBackgroundTimer();
      }
      if ("theme" in patch) applyTheme(saved.theme);
      // 缓存目录变了：监听器必须跟着换到新目录，否则「打开缓存目录」看到的是新目录、
      // 自动刷新却还盯着旧目录。
      if ("downloadDirectory" in patch) {
        ensureCacheWatcher();
        notifyCacheChanged();
      }
      return saved;
    }
    case "notify_update":
      return notifyUpdate(args);
    case "copy_text": {
      // 剪贴板命令只接受文本，不接受「读剪贴板」—— 一个能读走用户剪贴板内容的接口没有任何
      // 存在的理由。文本由渲染进程拼好（它手上才有完整状态），这里只负责写进去。
      const text = String(args.text || "");
      if (!text) throw new Error("没有可复制的文本");
      clipboard.writeText(text);
      return { ok: true };
    }
    case "pick_directory": {
      const window = BrowserWindow.fromWebContents(event.sender);
      // 选的是「缓存放在哪个文件夹」。真实缓存目录固定落在它下面的
      // Codex Updater\downloads，由渲染层拼接后交给 precheck_cache_migration；
      // 这里只返回用户选中的文件夹，不保存任何东西。
      const result = await dialog.showOpenDialog(window, {
        title: "选择缓存文件夹",
        buttonLabel: "选择此文件夹",
        properties: ["openDirectory", "createDirectory"],
        defaultPath: currentCacheDirectory(),
      });
      if (result.canceled || result.filePaths.length === 0) return { canceled: true };
      return { canceled: false, path: result.filePaths[0] };
    }
    case "open_path": {
      // 只允许打开本应用自己的目录，不接受任意路径。每一项都来自主进程自己或设置里的
      // 「缓存目录」，没有一项是 args 里的东西 —— 白名单判定也在后面用 target 对照。
      //
      // 缓存目录要把「用户在高级设置里指定的那个」也算进来：只认 downloadsRoot()
      // 的话，用户把缓存换到别的盘之后，「打开缓存目录」会打开另一个（空的）文件夹
      // —— 而回退功能恰恰把安装包留在了他指定的那个目录里。
      const allowed = new Set([
        codex.logsRoot(),
        codex.downloadsRoot(),
        codex.resolveDownloadDirectory(readSettings().downloadDirectory),
        app.getPath("userData"),
      ]);
      const target = String(args.path || "");
      if (!allowed.has(target)) throw new Error("只能打开本应用的目录");
      mkdirSync(target, { recursive: true });
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      return { ok: true };
    }
    case "open_install_location": {
      // 打开 Codex 装在哪儿。这里以前打开的是 Windows 设置里的「新的应用将保存到」——
      // 理由是「安装位置我们改不了，只能告诉你从哪改」。但用户问的是「为什么不是打开路径」，
      // 而路径其实是**打得开**的：C:\Program Files\WindowsApps 那一级确实锁着（列目录都被
      // 拒），可具体到 OpenAI.Codex_<版本>_<arch>__<hash> 这个包目录对 BUILTIN\Users 有
      // ReadAndExecute，Explorer 能正常打开、能看见里面的文件。所以这颗按钮现在做它字面上
      // 说的事，而不是替用户打开另一个问题。
      //
      // 路径只有两个来源，都在主进程：bootstrap 那次 get_status 记下来的，或者万一没跑过
      // （正常一定会跑）现场补一次。渲染进程传路径过来是不接受的。
      const target = lastInstallLocation ?? (await codex.getStatus({ probe: false }))?.installLocation ?? null;
      lastInstallLocation = target;
      if (!target) throw new Error("没有检测到已安装的 Codex，打开不了安装目录");
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      return { ok: true };
    }
    case "get_storage_info":
      return getStorageInfo();
    case "precheck_cache_migration":
      // 预检只读。执行时会重新枚举一次，界面拿到的这份摘要不是授权。
      return cacheMigration.precheck({
        sourceDirectory: currentCacheDirectory(),
        targetDirectory: args.targetDirectory,
      });
    case "migrate_cache": {
      const sendProgress = (payload) => {
        if (!event.sender.isDestroyed()) event.sender.send("desktop:cache-migration", payload);
      };
      return cacheMigration.migrate({
        sourceDirectory: currentCacheDirectory(),
        targetDirectory: args.targetDirectory,
        onProgress: sendProgress,
        // 提交点：所有文件都已在目标目录且校验通过后才切设置。这里抛错时
        // 源目录与设置保持原样（cache-migration.cjs 会原样抛出）。
        switchDirectory: (target) => {
          applyCacheDirectory(target);
        },
      });
    }
    case "cancel_cache_migration":
      return cacheMigration.cancelMigration();
    case "get_app_migration_capability":
      return getAppMigrationCapability();
    case "move_codex_app":
      return moveCodexApp(args);
    case "open_storage_settings":
      // 「新内容的保存位置」页，而不是存储感知：用户来这里是为了换应用安装的盘。
      await shell.openExternal("ms-settings:savelocations");
      return { ok: true };
    case "get_github_updates":
      // 只读、失败不抛（结果里带 error 与上次成功的数据）。断网不该让公告整块消失，
      // 更不该让启动界面报错。
      return getGithubUpdates(Boolean(args.force));
    case "download_app_update": {
      // 进度走独立通道：desktop:progress 属于 Codex 安装链路，两边的 phase 语义不同。
      // 任务栏进度条仍然复用 —— 窗口被盖住时，用户能看见「还在下载」。
      const sendAppUpdate = (payload) => {
        if (event.sender.isDestroyed()) return;
        event.sender.send("desktop:app-update", payload);
        const window = BrowserWindow.fromWebContents(event.sender);
        if (window && !window.isDestroyed() && payload.total > 0) {
          window.setProgressBar(Math.min(1, Math.max(0, payload.received / payload.total)));
        }
      };
      return downloadAppUpdate(args, sendAppUpdate);
    }
    case "install_app_update":
      return installAppUpdate(args);
    case "check_network":
      return checkNetwork();
    case "set_tray_status":
      return setTrayStatus(args);
    case "open_release": {
      const url = String(args.url || "");
      const allowedPrefix = `https://github.com/${GITHUB_REPO}/releases/`;
      // 只认本仓库的 Release 页面。URL 是 GitHub 返回的，但仍然在这里再校一遍：
      // 渲染进程可以传任意字符串过来，这个命令的本质是「让系统浏览器打开一个地址」。
      if (!url.startsWith(allowedPrefix)) throw new Error("只能打开本项目的 GitHub Release 页面");
      await shell.openExternal(url);
      return { ok: true };
    }
    default:
      throw new Error(`不支持的命令：${command}`);
  }
}

// ---------- 菜单 ----------

function sendMenuAction(action) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("desktop:menu-action", action);
  }
}

// 应用菜单整个不要。窗口是无边框的（frame: false），但原生菜单栏并不总会随之消失：
// 一旦没有显式清空，Windows 上仍可能露出 Electron 默认的 File / Edit 这一套。
// 界面自己的入口全在侧栏里，窗口按钮在顶栏的红绿灯上，菜单栏没有任何存在的理由。
function removeApplicationMenu() {
  Menu.setApplicationMenu(null);
}

// 快捷键原来是靠菜单的 accelerator 承载的，菜单删掉之后必须在主进程里自己接管，
// 否则 Ctrl+R / Ctrl+I / Ctrl+M / Ctrl+W 会静默失效。
const SHORTCUT_ACTIONS = {
  r: "check",
  i: "install",
  m: "minimize",
  w: "close",
};

function attachKeyboardShortcuts(window) {
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) return;
    // 只认「Ctrl + 单个字母」：带 Alt / Shift / Meta 的组合留给系统或输入法。
    if (!input.control || input.alt || input.shift || input.meta) return;
    const action = SHORTCUT_ACTIONS[String(input.key).toLowerCase()];
    if (!action) return;
    // 不拦截的话 Ctrl+R 会同时触发 Chromium 自己的重新加载。
    event.preventDefault();
    sendMenuAction(action);
  });
}

// ---------- 窗口 ----------

function waitForDevServer(url, attempts = 40) {
  return new Promise((resolve, reject) => {
    const probe = (remaining) => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) return resolve();
        retry(remaining);
      });
      request.on("error", () => retry(remaining));
      request.setTimeout(500, () => {
        request.destroy();
        retry(remaining);
      });
    };
    const retry = (remaining) => {
      if (remaining <= 0) return reject(new Error("Vite 开发服务器启动超时"));
      setTimeout(() => probe(remaining - 1), 250);
    };
    probe(attempts);
  });
}

async function createWindow() {
  const stored = storedWindowBounds();
  // 存的矩形不在任何显示器上就整块丢掉（外接显示器拔了的场景），回到默认尺寸居中。
  const restore = stored && isVisibleOnSomeDisplay(stored) ? stored : null;
  // 初始矩形要收进工作区。默认 1180×860 比不少笔记本的工作区还高（1280×800@150%
  // 缩放的工作区只有约 1280×752），从外接大屏切回来时上次存的大矩形也可能超出。
  // 超出的部分 Windows 不会替你挪回来：窗口底部（含内容区最后一行）会直接落在
  // 屏幕外，用户看到的是一扇「缺了下半截」的窗口。
  const area = (restore ? screen.getDisplayMatching(restore) : screen.getPrimaryDisplay()).workArea;
  // 存的尺寸比工作区还大时，**不要**把它裁成工作区大小 —— 那会得到一扇「顶满屏幕、
  // 还比上次拖的小」的窗口，用户以为界面被压扁了。改用默认尺寸并居中：尺寸是设计过的，
  // 位置还留在这块显示器上。放大窗口是用户主动做的事，不该由一次换屏被动完成。
  const fits = Boolean(restore) && restore.width <= area.width && restore.height <= area.height;
  const width = Math.min(fits ? restore.width : DEFAULT_WIDTH, Math.max(MIN_WIDTH, area.width));
  const height = Math.min(fits ? restore.height : DEFAULT_HEIGHT, Math.max(MIN_HEIGHT, area.height));
  const x = restore
    ? fits
      ? Math.min(Math.max(restore.x, area.x), area.x + area.width - width)
      : Math.round(area.x + (area.width - width) / 2)
    : undefined;
  const y = restore
    ? fits
      ? Math.min(Math.max(restore.y, area.y), area.y + area.height - height)
      : Math.round(area.y + (area.height - height) / 2)
    : undefined;
  const window = new BrowserWindow({
    width,
    height,
    ...(restore ? { x, y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: "Codex Updater",
    backgroundColor: windowBackgroundColor(),
    // 图标只在开发模式下起作用（打包后由 exe 自带的图标决定），但开发时任务栏上
    // 有一个 Electron 原子图标很扎眼，顺手接上。
    icon: iconPath(),
    frame: false,
    titleBarStyle: "hidden",
    autoHideMenuBar: true,
    // 先不显示：窗口的 DIP 矩形要在建好之后重新钉一次（见下面的 setBounds），
    // 钉准了再露出来，否则会先闪一下错误大小。开机自启的实例本来就不显示。
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow = window;
  // 新窗口先接上当前的托盘/任务栏状态（有更新时右上角那颗 overlay 角标）。
  applyTrayStatus();
  // 双保险：应用级菜单已清空，这里再把窗口自己的菜单摘掉。
  window.removeMenu();
  attachKeyboardShortcuts(window);

  // 混合缩放的多显示器上，创建窗口时传进去的 DIP 尺寸会先按**主屏**工作区裁一次、
  // 再按主屏缩放折算一次：主屏 150% + 副屏 100% 时，请求 1049×852 实际得到
  // 700×501。窗口打开后只剩左边一窄条，右半边卡片和下半截内容都在窗口外 ——
  // 这就是「正常打开 exe 却显示不全」的来源。等窗口已经建在目标屏幕上之后，
  // setBounds 用的才是那块屏幕真实的 DIP 尺寸，所以在这里把矩形钉回去。
  const placed = window.getBounds();
  const targetBounds = {
    x: restore ? x : placed.x,
    y: restore ? y : placed.y,
    width,
    height,
  };
  if (
    placed.width !== width ||
    placed.height !== height ||
    placed.x !== targetBounds.x ||
    placed.y !== targetBounds.y
  ) {
    window.setBounds(targetBounds);
  }

  // 最大化会自己把窗口显示出来；其余情况等尺寸钉好再显示（开机自启的保持隐藏）。
  if (restore && restore.maximized) window.maximize();
  else if (!startHidden) window.show();

  if (isDev) {
    const command = "npm run dev -- --host 127.0.0.1";
    devServer =
      process.platform === "win32"
        ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
            cwd: projectRoot,
            windowsHide: true,
            stdio: "ignore",
          })
        : spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1"], { cwd: projectRoot, stdio: "ignore" });
    await waitForDevServer("http://127.0.0.1:1420");
    await window.loadURL("http://127.0.0.1:1420");
  } else {
    await window.loadFile(join(projectRoot, "dist", "index.html"));
  }

  if (startHidden) ensureTray();

  window.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error(`窗口资源加载失败：${description} (${code}) → ${url}`);
  });

  // 最大化状态变化要推给渲染进程，否则最大化按钮的图标不会跟着变成「还原」。
  // 双击标题栏最大化也走这条路径，一并覆盖。
  const publishWindowState = () => {
    if (!window.isDestroyed()) {
      window.webContents.send("desktop:window-state", { maximized: window.isMaximized() });
    }
  };
  window.on("maximize", publishWindowState);
  window.on("unmaximize", publishWindowState);

  // 位置尺寸记忆。resize/move 在一次拖动里会连着触发几十次，每次都写一遍 settings.json
  // 就是几十次磁盘写，所以防抖到停下来 400ms 之后再写一次。
  let boundsTimer = null;
  const scheduleSaveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      boundsTimer = null;
      saveWindowBounds();
    }, 400);
  };
  window.on("resize", scheduleSaveBounds);
  window.on("move", scheduleSaveBounds);
  window.on("maximize", scheduleSaveBounds);
  window.on("unmaximize", scheduleSaveBounds);

  window.on("close", (event) => {
    if (boundsTimer) {
      clearTimeout(boundsTimer);
      boundsTimer = null;
    }
    saveWindowBounds();

    if (isQuitting) return;

    if (busyCommands > 0) {
      event.preventDefault();
      void confirmCloseWhileBusy(window);
      return;
    }

    if (tray && readSettings().minimizeToTray) {
      // 最小化到托盘：用户按了 ×，但设置里说了「关窗不停后台」，那就别真退。
      event.preventDefault();
      window.hide();
    }
  });

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  return window;
}

/**
 * 长命令在飞的时候用户按了关闭。
 *
 * 默认按钮是「继续等待」而不是「仍然关闭」：用户多半是手快或者忘了自己在装东西，
 * 回车键落到「关闭」上会把一次装了一半的安装打断。
 */
async function confirmCloseWhileBusy(window) {
  if (closePromptOpen) return;
  closePromptOpen = true;
  try {
    const { response } = await dialog.showMessageBox(window, {
      type: "warning",
      title: "仍在进行中",
      message: "更新器正在执行操作，现在关闭会中断它。",
      detail: "继续等待可以让这次操作正常跑完；中断后可能需要重新下载或重新安装。",
      buttons: ["继续等待", "仍然关闭"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1) {
      // destroy 而不是 close：close 会再走一遍这个 handler，用户得连点两次。
      isQuitting = true;
      if (window.isDestroyed()) return;
      window.destroy();
    }
  } finally {
    closePromptOpen = false;
  }
}

/**
 * 清空缓存前的确认。
 *
 * 放在主进程而不是渲染进程：这是**不可撤销**的删除，原生模态框不会被误点穿透，也不会
 * 因为界面重渲染或忙态切换而消失。默认按钮是「取消」—— 回车键落到「清空缓存」上，
 * 同事留着回退用的那几个包就没了。
 *
 * 措辞里必须点明「已安装的 Codex 不受影响」：用户看到「删除」第一反应是「会不会把
 * Codex 卸了」，而这正是他最不能接受的结果。
 */
async function confirmClearCache() {
  const options = {
    type: "warning",
    title: "清空安装包缓存",
    message: "要删除缓存里的全部 Codex 安装包吗？",
    detail: "已安装的 Codex 不受影响。但删除后无法再回退到旧版本，需要时得重新下载（每个约 800 MB）。",
    buttons: ["取消", "清空缓存"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return response === 1;
}

// ---------- IPC ----------

// 同步读取初始主题：preload 在页面脚本之前调用，晚一步就会先渲染出一帧浅色。
// 只用 sendSync 读两个字符串，不涉及文件 IO 之外的任何事；设置文件很小。
ipcMain.on("desktop:initial-theme", (event) => {
  event.returnValue = currentThemeState();
});

ipcMain.handle("desktop:command", async (event, command, args) => {
  // 关窗保护只认这几条长命令，计数也就只在它们身上加减。
  const tracked = LONG_COMMANDS.has(command);
  if (tracked) busyCommands += 1;
  try {
    return await executeCommand(event, command, args || {});
  } finally {
    if (tracked) busyCommands -= 1;
    // 清任务栏进度条。放在 finally 里是因为失败路径同样要清 —— 命令抛错之后那根条
    // 若留在半路，用户会一直以为还在下载。
    const window = BrowserWindow.fromWebContents(event.sender);
    if (busyCommands === 0 && window && !window.isDestroyed()) window.setProgressBar(-1);
  }
});

ipcMain.handle("desktop:window", (event, action) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  if (action === "minimize") window.minimize();
  if (action === "maximize") window.isMaximized() ? window.unmaximize() : window.maximize();
  if (action === "close") window.close();
  // 「关闭更新器」是**退出**，不是关窗：开了托盘常驻之后 close 只会把它藏起来，
  // 用户按了「关闭更新器」却发现进程还在，只会以为这软件退不掉。
  if (action === "quit") app.quit();
  // 最大化按钮要显示「还原」图标，所以渲染进程得知道当前状态。查询用这个，
  // 后续变化由下面的 maximize/unmaximize 事件推。
  if (action === "is-maximized") return window.isMaximized();
});

ipcMain.on("desktop:drag-start", (event, point) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !point) return;
  const [left, top] = window.getPosition();
  dragOffsets.set(window.id, { left: left - Number(point.screenX), top: top - Number(point.screenY) });
});

ipcMain.on("desktop:drag-move", (event, point) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const offset = window && dragOffsets.get(window.id);
  if (!window || !offset || !point) return;
  window.setPosition(Math.round(Number(point.screenX) + offset.left), Math.round(Number(point.screenY) + offset.top));
});

ipcMain.on("desktop:drag-end", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) dragOffsets.delete(window.id);
});

// ---------- 生命周期 ----------

app.whenReady()
  .then(async () => {
    // 没抢到锁的第二个实例在这里直接收摊。不能只靠上面那句 app.quit()：quit 是异步的，
    // 而这个 then 排在同一轮事件循环里，不挡住的话第二个实例仍会把窗口和 PowerShell 建出来。
    if (!hasSingleInstanceLock) return;

    // Windows 上通知必须带一个 AppUserModelID 才会显示，否则 Notification.show() 一声不吭
    // 地什么都不发生 —— 而且它不报错，是那种「功能写了但没生效」的静默坏法。
    // 这个值与 package.json 的 build.appId 一致。
    app.setAppUserModelId("com.codex.updater");

    // 注册表里的自启项可能被别的东西清掉（清理软件、重装），所以每次启动都按落盘值重新写一次。
    applyLoginItem(readSettings().launchAtLogin);

    // 主题要在建窗口之前定下来：backgroundColor 和 Chromium 的 prefers-color-scheme
    // 都读它，晚一步就会出现「深色界面配浅色窗口底」的那一下白闪。
    applyTheme(readSettings().theme);

    // 启动时确认内置脚本到位：缺失时给出明确原因，而不是等到用户点按钮才报错。
    //
    // 这里必须 try/catch，不能写成 existsSync(codex.bundledScript(...))：bundledScript
    // 在脚本缺失时是**抛错**（见 codex.cjs），existsSync 永远等不到 false，
    // 那句判断是死代码 —— 脚本真丢了它一声不吭。
    try {
      codex.bundledScript("check-codex-update.ps1");
    } catch (error) {
      console.error("内置脚本缺失，请重新安装或运行 npm run sync:scripts：", error.message);
    }
    removeApplicationMenu();
    await createWindow();
    // 缓存目录可能已经存在（用户以前下载过）。先挂上监听，界面首次扫描之后就能收到
    // 外部删除/新增的通知；目录还不存在时 ensureCacheWatcher 会安静地跳过。
    ensureCacheWatcher();
    applyBackgroundTimer();
  })
  .catch((error) => {
    console.error("Electron 窗口启动失败：", error);
    app.quit();
  });

// 第二个实例被拦下之后，用户看到的是「双击了没反应」—— 除非我们把已有窗口叫到前台。
// 用户双击图标时不关心谁是第一个实例，他只想看到那个窗口。
app.on("second-instance", () => {
  showMainWindow();
});

// 系统主题切换时把窗口底色跟着换掉，否则深色下改主题再开窗口又会闪一下白。
//
// 同时把「解析后的主题」推给界面：偏好是「跟随系统」时，根节点的 data-theme 必须跟着
// 系统走；显式浅色 / 深色时这条事件不改界面（渲染层按偏好自己判断），但窗口底色
// 仍需按当前真实配色重算。
nativeTheme.on("updated", () => {
  const parsed = currentThemeState();
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.setBackgroundColor(windowBackgroundColor());
    window.webContents.send("desktop:theme-updated", parsed);
  }
});

app.on("window-all-closed", () => {
  if (devServer) devServer.kill();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  else showMainWindow();
});

// app.quit() 走的是 close 事件，不是 destroy —— 不置这个标志，托盘里的「退出」会被
// 关窗保护反过来拦下来（明明正在装东西，用户点了退出，反倒弹一个「仍在进行中」）。
app.on("before-quit", () => {
  isQuitting = true;
});
