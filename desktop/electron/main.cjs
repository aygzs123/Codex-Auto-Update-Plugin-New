// 主进程：窗口、菜单、IPC 接线。业务逻辑在 codex.cjs，PowerShell 在 ps.cjs。

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");
const http = require("node:http");

const codex = require("./codex.cjs");

// 在 whenReady 之前设置，userData 才会落在 %APPDATA%\Codex Updater 而不是
// 由包名推导出的 codex-updater-desktop。
app.setName("Codex Updater");

const isDev = process.argv.includes("--dev") || !app.isPackaged;
const projectRoot = join(__dirname, "..");

// 渲染进程只能触发这些命令，且每个命令的脚本路径都是写死的内置脚本名。
const allowedCommands = new Set([
  "get_status",
  "check_update",
  "download_codex",
  "verify_download_signature",
  "install_codex",
  "list_cached_packages",
  "launch_codex",
  "check_health",
  "repair_bundles",
  "get_settings",
  "save_settings",
  "pick_directory",
  "open_path",
  // 只打开一个写死的 Windows 设置页。不接受渲染进程传 URI —— 那等于把
  // 「打开任意协议」的能力交出去，open_path 的白名单也就白做了。
  "open_storage_settings",
]);

let devServer;
const dragOffsets = new Map();

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

// ---------- 命令 ----------

function progressReporter(sender) {
  return (event) => {
    if (!sender.isDestroyed()) sender.send("desktop:progress", event);
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
    case "save_settings":
      return writeSettings({ downloadDirectory: String(args.downloadDirectory ?? "") });
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
  const window = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 760,
    minHeight: 640,
    title: "Codex Updater",
    backgroundColor: "#edf1f7",
    frame: false,
    titleBarStyle: "hidden",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

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

  return window;
}

// ---------- IPC ----------

ipcMain.handle("desktop:command", (event, command, args) => executeCommand(event, command, args || {}));

ipcMain.handle("desktop:window", (event, action) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  if (action === "minimize") window.minimize();
  if (action === "maximize") window.isMaximized() ? window.unmaximize() : window.maximize();
  if (action === "close") window.close();
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
  })
  .catch((error) => {
    console.error("Electron 窗口启动失败：", error);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (devServer) devServer.kill();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
