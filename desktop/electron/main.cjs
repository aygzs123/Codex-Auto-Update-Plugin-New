// 主进程：窗口、菜单、IPC 接线。业务逻辑在 codex.cjs，PowerShell 在 ps.cjs。

const { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeTheme, net, screen, shell } = require("electron");
const { createHash } = require("node:crypto");
const {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { basename, join, resolve } = require("node:path");
const { spawn } = require("node:child_process");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const http = require("node:http");

const codex = require("./codex.cjs");
const github = require("./github.cjs");

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

/** 流式下载到 .part，边下边算 SHA-256，并把进度推给渲染进程。 */
function downloadAppUpdateFile(asset, partialPath, emit) {
  return new Promise((resolveDownload, rejectDownload) => {
    const request = net.request({ method: "GET", url: asset.url });
    request.setHeader("Accept", "application/octet-stream");
    request.setHeader("User-Agent", "Codex-Updater");

    const hash = createHash("sha256");
    let received = 0;
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
      if (response.statusCode < 200 || response.statusCode >= 300) {
        fail(new Error(`更新包下载失败：HTTP ${response.statusCode}`));
        return;
      }
      const length = Number(response.headers["content-length"]);
      if (Number.isFinite(length) && length > 0) total = length;

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

      pipeline(response, meter, createWriteStream(partialPath)).then(done).catch(fail);
    });
    request.on("error", fail);
    request.end();
  });
}

/**
 * 下载更新器自己的安装包。
 *
 * 只接受本仓库 Release 资产、只认 .exe、必须带 GitHub 计算的摘要；下载到专用 updates
 * 目录，校验通过后才原子改名成正式文件。失败时删掉 .part，不留半截文件。
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

    const sha256 = await downloadAppUpdateFile(asset, partial, emit);
    if (sha256 !== asset.sha256) throw new Error("更新包 SHA-256 校验失败，已丢弃");
    const size = statSync(partial).size;
    if (asset.size > 0 && size !== asset.size) throw new Error(`更新包大小不符（${size} / ${asset.size}）`);
    renameSync(partial, target);
    emit({ kind: "progress", received: size, total: size });
    return { path: target, size, sha256 };
  } catch (error) {
    try {
      unlinkSync(partial);
    } catch {
      // 同上：清理失败不应该盖掉真正的错误。
    }
    throw error;
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
  tray.setToolTip("Codex Updater");
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
 * 6 小时是权衡的结果：开机的那个进程会常驻好几天，只在启动那一下查一次是不够的；但查一次
 * 是一次真实的网络往返（脚本侧还有三层兜底重试），按小时算的间隔既够用又不至于变成定时骚扰。
 */
const BACKGROUND_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let backgroundTimer = null;

/**
 * 按设置值决定要不要后台复查。
 *
 * 「后台模式开着」= 用户开了托盘常驻或开机自启 —— 只有这两种情况下进程才会活很久，
 * 也才谈得上「过几小时再查一遍」。两个开关都关着时进程随窗口一起退出，定时器纯属多余。
 */
function applyBackgroundTimer() {
  if (backgroundTimer) {
    clearInterval(backgroundTimer);
    backgroundTimer = null;
  }
  const settings = readSettings();
  if (!settings.minimizeToTray && !settings.launchAtLogin) return;

  backgroundTimer = setInterval(() => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("desktop:background-check");
    }
  }, BACKGROUND_CHECK_INTERVAL_MS);
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
function notifyUpdate(args) {
  const version = String(args.version || "");
  if (!version) return { shown: false, reason: "no-version" };

  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    return { shown: false, reason: "focused" };
  }
  if (readSettings().lastNotifiedVersion === version) return { shown: false, reason: "already-notified" };
  if (!Notification.isSupported()) return { shown: false, reason: "unsupported" };

  const notification = new Notification({
    title: "Codex 有新版本",
    body: `可更新到 ${version}，点这里打开更新器查看。`,
  });
  notification.on("click", () => showMainWindow());
  notification.show();
  // 通知成功弹出去之后才记下来。先记再弹的话，弹失败（比如被系统静音）也会被当成
  // 「已经提醒过」，这个版本就再也不会提醒了。
  writeSettings({ lastNotifiedVersion: version });
  return { shown: true };
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
      return codex.checkUpdate(args);
    case "download_codex":
      return codex.downloadCodex(args, emit);
    case "verify_download_signature":
      return codex.verifySignature(args);
    case "install_codex":
      // 剪枝目录在这里解析并传下去：codex.cjs 不读 settings（那是 main 的职责），
      // 而 worker 必须在**缓存目录**里剪枝，不能从安装包路径反推 —— 路径是界面给的，
      // 反推出来的目录未必是缓存，剪错目录会把不相干的安装包删掉。
      return codex.installCodex(
        { ...args, downloadDirectory: codex.resolveDownloadDirectory(readSettings().downloadDirectory) },
        emit,
      );
    case "list_cached_packages":
      // 「版本历史 / 回退」要用的缓存清单。只读，不写任何东西。
      return codex.listCachedPackages(args);
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
      const saved = writeSettings(patch);
      // 这两个开关不只是落盘，还要真的动系统与本进程：自启要写注册表，后台复查要起/停定时器。
      if ("launchAtLogin" in patch) applyLoginItem(saved.launchAtLogin);
      if ("minimizeToTray" in patch || "launchAtLogin" in patch) applyBackgroundTimer();
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
      const result = await dialog.showOpenDialog(window, {
        title: "选择安装包缓存目录",
        properties: ["openDirectory", "createDirectory"],
        defaultPath: codex.resolveDownloadDirectory(readSettings().downloadDirectory),
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
nativeTheme.on("updated", () => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setBackgroundColor(windowBackgroundColor());
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
