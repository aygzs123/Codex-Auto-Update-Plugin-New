// 主进程：窗口、菜单、IPC 接线。业务逻辑在 codex.cjs，PowerShell 在 ps.cjs。

const { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeTheme, screen, shell } = require("electron");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");
const http = require("node:http");

const codex = require("./codex.cjs");

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
  // 只打开一个写死的 Windows 设置页。不接受渲染进程传 URI —— 那等于把
  // 「打开任意协议」的能力交出去，open_path 的白名单也就白做了。
  "open_storage_settings",
]);

let devServer;
const dragOffsets = new Map();

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

// ---------- 窗口位置记忆 ----------

const DEFAULT_WIDTH = 1120;
const DEFAULT_HEIGHT = 780;
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
    case "get_status":
      return codex.getStatus({ probe: false });
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
    case "open_storage_settings": {
      // MSIX 的安装位置由 Windows 决定，安装器改不了（Add-AppxPackage 不带 -Volume
      // 就装到系统卷）。用户真想把应用装到别的盘，唯一的路是系统设置里的
      // 「新的应用将保存到」。所以这里把他送到那一页，而不是假装我们能设。
      await shell.openExternal("ms-settings:storagesense");
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

function createApplicationMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Codex Updater",
        submenu: [
          {
            label: "关于 Codex Updater",
            click: () =>
              dialog.showMessageBox({
                type: "info",
                title: "关于 Codex Updater",
                message: "Codex Updater",
                detail:
                  "为 Windows 用户提供一键安装 Codex Desktop 的图形界面。\n\n" +
                  "安装包来自 Microsoft Store 官方分发源，安装前会校验 OpenAI 的 Authenticode 签名。",
                buttons: ["好"],
              }),
          },
          { type: "separator" },
          { role: "quit", label: "退出" },
        ],
      },
      {
        label: "操作",
        submenu: [
          { label: "检查更新", accelerator: "CmdOrCtrl+R", click: () => sendMenuAction("check") },
          { label: "一键安装 / 更新", accelerator: "CmdOrCtrl+I", click: () => sendMenuAction("install") },
          { label: "打开 Codex", click: () => sendMenuAction("launch") },
        ],
      },
      {
        label: "诊断",
        submenu: [
          { label: "健康自检（含窗口探测）", click: () => sendMenuAction("health") },
          { label: "修复资源副本（加密资源搬迁）", click: () => sendMenuAction("repair") },
          { type: "separator" },
          { label: "打开日志目录", click: () => sendMenuAction("open-logs") },
          { label: "打开缓存目录", click: () => sendMenuAction("open-cache") },
        ],
      },
      {
        // 窗口是无边框的（frame: false），这个原生菜单栏根本显示不出来 —— 它在这里
        // 唯一的作用是承载快捷键。所以界面顶栏只放「操作 / 诊断」两组（窗口命令由
        // 顶栏右上角的 − □ × 承担），这组仍然留着，否则 Ctrl+W / Ctrl+M 会静默失效。
        label: "窗口",
        submenu: [
          { label: "最小化", accelerator: "CmdOrCtrl+M", click: () => sendMenuAction("minimize") },
          { label: "最大化 / 还原", click: () => sendMenuAction("maximize") },
          { type: "separator" },
          { label: "关闭窗口", accelerator: "CmdOrCtrl+W", click: () => sendMenuAction("close") },
        ],
      },
    ]),
  );
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
  const window = new BrowserWindow({
    width: restore ? restore.width : DEFAULT_WIDTH,
    height: restore ? restore.height : DEFAULT_HEIGHT,
    ...(restore ? { x: restore.x, y: restore.y } : {}),
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
    // 开机自启那个实例先不出现在屏幕上，只留托盘；用户点托盘或通知再显示。
    show: !startHidden,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow = window;

  if (restore && restore.maximized) window.maximize();

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
    createApplicationMenu();
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
