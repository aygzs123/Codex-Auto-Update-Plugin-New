// 渲染冒烟测试：把构建产物真正加载进 Electron，确认窗口能渲染出内容。
//
// 存在的原因：vite 的 base 缺失时产物会引用绝对路径 /assets/...，在 loadFile() 的
// file:// 协议下被解析成盘符根（file:///C:/assets/...）而 404。dev 模式走 http
// 服务器所以完全看不出问题，而打包产物只会白屏且不抛错 —— 这个脚本专门盯住这个
// 静默失败。
//
// 这里会注册一组桩 IPC 处理器：真实 main.cjs 才会连 PowerShell，而这个脚本只关心
// 渲染。喂进确定的健康数据后，断言覆盖的不再只是「有东西渲染出来」，而是「拿到状态
// 数据后界面呈现正确」。
//
// 用法：
//   npm run verify:render           校验 dist/ 构建产物
//   npm run verify:render:packaged  校验 electron-builder 打包后的 app.asar 内产物

const { app, BrowserWindow, Menu, clipboard, ipcMain, nativeTheme } = require("electron");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const desktopRoot = join(__dirname, "..");
const packaged = process.argv.includes("--packaged");
const indexPath = packaged
  ? join(desktopRoot, "release", "win-unpacked", "resources", "app.asar", "dist", "index.html")
  : join(desktopRoot, "dist", "index.html");

// --screenshot=<目录>：把各状态的界面截图落盘，用来人工核对视觉效果。
// 断言只能保证「没被裁切、够大」，好不好看还得看。
const screenshotArg = process.argv.find((argument) => argument.startsWith("--screenshot"));
const screenshotDir = screenshotArg
  ? join(desktopRoot, screenshotArg.includes("=") ? screenshotArg.split("=")[1] : "release-verify/ui")
  : null;

const targetLabel = packaged ? "打包产物 (app.asar)" : "构建产物 (dist/)";

// --width=<px>：窗口宽度。主窗口 minWidth 是 760，窄宽度下才能复现布局挤压。
const widthArg = process.argv.find((argument) => argument.startsWith("--width"));
const windowWidth = widthArg && widthArg.includes("=") ? Number(widthArg.split("=")[1]) : 1120;

// --dark：强制深色再截图。桌面端跟随系统主题，深色下对比度出问题不会在浅色
// 截图里露出来，所以给一个能单独截深色的开关（只影响截图，不改断言）。
const darkMode = process.argv.includes("--dark");

// 打包态还必须确认脚本落在 asar 之外。PowerShell 无法执行 app.asar 内的 .ps1，
// 而 extraResources 配错时这件事不会报错，只会等到用户点「一键安装」才失败。
const PACKAGED_SCRIPTS = [
  "CodexStoreUpdater.psm1",
  "check-codex-update.ps1",
  "install-codex-msix-and-restart.ps1",
  "check-codex-desktop-health.ps1",
  "list-cached-codex-packages.ps1",
  "clear-cached-codex-packages.ps1",
  "repair-codex-desktop-bundles.ps1",
];
const packagedScriptsDir = join(desktopRoot, "release", "win-unpacked", "resources", "scripts");

const failedLoads = [];
const consoleErrors = [];

// 两个场景。默认场景是「本机已装 Codex」,用来验证已安装态的呈现;
// --not-installed 覆盖的是这个 exe 的主用途 —— 新机器上装 Codex,此时健康脚本
// 退出码为 2、没有任何组件,界面必须给出「一键安装」而不是「检查并更新」。
const notInstalled = process.argv.includes("--not-installed");
// --installing 关掉真实后端事件，改由主进程脚本化地推一串进度事件，
// 用来验证「后端进度事件 → 界面呈现」这一段：不确定进度条、百分比推进、
// 静默期爬升、软告警、日志区。这些不依赖真的装一次 Codex。
const installing = process.argv.includes("--installing");
// --menu：展开顶栏的下拉菜单，验证它没有被下面滚动的内容盖住。
// 顶栏浮在内容之上是靠堆叠顺序撑住的，内容区一旦建立自己的层叠上下文（比如某个
// 祖先带了 backdrop-filter），菜单就会连同顶栏一起被压到内容下面 —— 点不到也看不见。
const menuOpen = process.argv.includes("--menu");

// --launch-no-window：从菜单触发「打开 Codex」，桩返回「进程起来了但没有主窗口」，
// 且判定为 relocation-bug（资源目录下留着复制失败的中转目录）。这条路径以前是
// fire-and-forget：界面上报「已请求启动」，用户屏幕上什么都没有，看起来就是
// 「点了没反应」。这个场景专门验证那种情况现在会给出结论和补救入口。
const launchNoWindow = process.argv.includes("--launch-no-window");

// --launch-unknown：同样是「没有主窗口」，但判定是 unknown —— 现有证据既不能证明、
// 也不能排除搬迁 bug。这条场景钉的是「不要指控」：卡片必须如实说判不出原因，
// **不能**出现「修复资源副本」按钮。2026-10-01 的真实误诊正是这一类：机器完全正常，
// 只是首次启动在落几百 MB 运行时，界面却断言了搬迁 bug，把用户推去跑修复脚本。
const launchUnknown = process.argv.includes("--launch-unknown");

// --health-partial：五个资源副本里有一个是 `[PART ]`（目标目录不在、但留着
// `.staging-*` / `.repair-*` 中转目录）。这是**唯一**会弹出资源修复横幅的形状。
//
// 这条场景之所以必须单独跑一遍：默认场景用的是真机形状（`wsl-cli` 只是 missing、没有
// 残留），它钉的是「组件缺失**不**弹卡片」；而 `partial` 那一档必须有卡片、且文案要
// 点到具体组件名 —— 两种形状在同一个夹具里表达不了，只能分两个场景。
const healthPartial = process.argv.includes("--health-partial");

// --notice：从菜单触发「检查更新」，验证命令的结论是**居中的模态对话框**。
// 以前是右下角 toast：用户点完按钮，视线还在主区（视线的另一头），很容易整个错过
// —— 而这里弹的是命令唯一的反馈。所以这个场景断言的不是「它出现了」，而是
// 「居中、完整落在视口内、按钮点得到、点完真的会关掉」。
//
// 顺带钉住自动检查的反面：启动时那次检查**不弹模态**。用户什么都没要求，启动就糊一个
// 居中对话框是打扰，所以这个场景要断言「手动点之前页面上没有 .modal-dialog」。
const noticeOpen = process.argv.includes("--notice");

// --up-to-date：桩返回「装的已经是最新版本」（installed == available == 26.901.6511.0，
// 与 STUB_HEALTH / STUB_UPDATE_LATEST 里那个版本一致）。
//
// 用户原话：「启动的时候只读取了版本，不会识别到是不是最新的版本号……要点检查版本号
// 才能查到是最新的」。这个场景就是那句话的回归测试：启动后什么都不点，顶栏就该写着
// 「已是最新」、主按钮是「打开 Codex」、次按钮「仅检查更新」隐去，而且**没有弹任何对话框**。
const upToDateScenario = process.argv.includes("--up-to-date");

// --boot：启动的**第一段** —— 只读本机（get_settings → get_status），网络那一步还没开始。
//
// 用户原话：「读取本机的时候应该给一下更好的提示吧，不然不知道」。这一段走得很快（两条本地
// 命令，一次 IPC 往返），所以以前界面从空白直接蹦出一个版本号，中间发生过什么没人交代。
//
// 为什么非要单开一条渲染场景：别的场景全都在等 `phase !== "checking"`（那是它们的前提），
// 只有这里把**第一条命令挂住**，让界面停在 checking 态上。没有它，主区那段提示就只有源码
// 文本断言 —— 那只证明字符串写在代码里，证明不了它真的画在屏幕上、也没被别的分支盖掉。
const bootHold = process.argv.includes("--boot");

// --checking：「检查更新」跑到一半（网络往返挂住不返回）时的界面。
//
// 这条场景钉的是一个交互问题：命令跑着的时候，所有能再触发命令的入口都必须点不动。
// 以前「检查更新」压根不置任何忙标志，用户点一下没见反应就连点，于是并发发出好几次
// 检查、连弹好几次结论；反过来，标志位若漏清，界面会永久锁死，用户只能重启应用。
// 所以这里两件事都要看到：跑着时点不动（按钮 disabled + 再发命令不产生第二次 IPC），
// 跑完之后重新点得动。
//
// 桩把**每一次** check_update 都挂住，所以启动时那次自动检查本身就提供了「命令跑着」
// 的窗口 —— 这正是本场景现在挂住的那条命令。这一点很关键：断言从「用户点出来的那次」
// 变成了「启动自动跑的那次」，如果照旧按「先发一次再连点」写，计数虽然还是 1，
// 但证明的东西已经换了，属于假绿。
const checkingHold = process.argv.includes("--checking");

// --rollback：点一次「版本历史」里的回退按钮，走完整条真实链路
// （按钮 → store.rollback → 校验签名 → 装旧包）。这条场景要证明的不只是「卡片画出来了」，
// 而是：回退真的带着 allowDowngrade 发出去了、跑着的时候按钮点不动、跑完能回到正常态。
// 安装那一步用挂住的方式模拟一次长命令，否则它瞬间返回，观察不到「正在回退」的中间态。
const rollbackScenario = process.argv.includes("--rollback");

// --app-update：「设置 → 关于 → 检查更新」这条自更新链路。
//
// 桩里放一个比当前版本新的 `desktop-v0.6.0`（带 .exe 资产与 sha256 摘要），于是
// 「检查更新」之后必须出现「发现新版本 v0.6.0」与「下载并安装」；点下载（走 IPC 桩，
// 不跑真实安装器）之后必须变成「已下载…可以安装」。
//
// 这条场景同时验证公告的两个来源：CHANGELOG 历史（0.1.0 / 0.2.0）来自打包进应用的
// JSON，0.6.0 来自远端 —— 合并后按时间倒序、同 tag 不重复。
const appUpdateScenario = process.argv.includes("--app-update");

// --storage：设置 → 存储里的三条真实交互。
//
// 它们共同的特征是「会动用户磁盘上的东西」，所以这里验证的恰恰是**不轻易动**：
//   - 外观三档即时切换，根节点 data-theme 必须真的跟着变；
//   - 「更改位置」先出确认块，焦点落在「取消」，确认之前一条 migrate_cache 都不许发；
//   - 「迁移应用本体」先只读检测，选定卷再执行；主进程确认框在桩里不存在，所以桩直接回
//     「已取消」——界面必须把取消当成正常选择（提示，不是红字错误）。
// 全程不执行真实迁移、不跑 Move-AppxPackage、不碰真实缓存。
const storageScenario = process.argv.includes("--storage");

// 进度序列取自 scripts/simulate-install.cjs 跑出来的真实事件流（含静默期爬升 20%→53%）。
const PROGRESS_STREAM = [
  { kind: "phase", id: "install", phase: "preparing", label: "准备安装", percent: 4 },
  { kind: "log", line: "Worker started for package: C:\\cache\\OpenAI.Codex_26.924.2738.0_x64__2p2nqsd0c76g0.msix", at: "2026-09-28 06:20:31" },
  { kind: "phase", id: "install", phase: "closing", label: "关闭正在运行的 Codex", percent: 12 },
  { kind: "phase", id: "install", phase: "installing", label: "Windows 正在安装 Codex", percent: 20 },
  { kind: "phase", id: "install", phase: "installing", label: "Windows 正在安装 Codex", percent: 53 },
  { kind: "phase", id: "install", phase: "verifying", label: "安装完成，正在校验版本", percent: 78 },
  { kind: "phase", id: "install", phase: "cleanup", label: "安装包未删除（不影响使用）", percent: 86, warning: true },
  { kind: "log", line: "Package cleanup verification failed; file still exists: C:\\cache\\OpenAI.Codex_26.924.2738.0_x64__2p2nqsd0c76g0.msix", at: "2026-09-28 06:20:41" },
  { kind: "phase", id: "install", phase: "restarting", label: "正在启动 Codex", percent: 90 },
  { kind: "phase", id: "install", phase: "probing", label: "正在确认 Codex 窗口", percent: 94 },
  { kind: "phase", id: "install", phase: "done", label: "安装完成，Codex 已启动", percent: 100 },
];

// 固定的健康数据，形状与 check-codex-desktop-health.ps1 的真实输出一致。
const STUB_HEALTH = notInstalled
  ? {
      installed: false,
      exitCode: 2,
      packageFullName: null,
      version: null,
      installLocation: null,
      overall: "not-installed",
      components: [],
      pluginsMaterialized: false,
      appUserModelId: null,
      probeResult: null,
      probeMessage: null,
      startupDiagnosis: null,
      needsRepair: false,
      repairTargets: [],
      raw: "",
    }
  : {
      installed: true,
      exitCode: 0,
      packageFullName: "OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0",
      version: "26.901.6511.0",
      // 故意用一个 **D 盘** 的安装位置。检测与显示都不许对系统盘做任何假设：
      // 用户把「新的应用将保存到」设成别的盘时，包里报出来就是这种路径。
      installLocation: "D:\\WindowsApps\\OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0",
      // 这一份**故意不是「五项全 ok」**，它照抄的是 2026-10-02 那台真机的形状：
      // wsl-cli 是 `[MISS ]`（目标目录不在、连残留都没有），脚本因此判
      // OVERALL=degraded —— 而那台机器上 Codex 打开完全正常，界面却常驻一张
      // 「Codex 可能无法正常打开窗口」的横幅。组件缺失不等于启动会坏，
      // 默认夹具用真机形状，这条「不弹卡片」就不会再退回去。
      //
      // overall 必须跟着写 degraded：脚本对任何非 ok 组件都判 degraded，
      // 只改组件不改它，造出来的是一份自相矛盾的夹具。
      overall: "degraded",
      // --health-partial 把 wsl-cli 换成 `[PART ]`（目标目录不在、但留着 .staging 中转目录）
      // —— 那才是有证据的「物化试过、没跑完」，也是唯一该出现修复横幅的形状。
      components: [
        { state: "ok", symbol: "OK", name: "win-cli", path: "C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\8e5b6932", leftovers: 0 },
        { state: "ok", symbol: "OK", name: "win-rg", path: "C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\c6063512", leftovers: 0 },
        healthPartial
          ? { state: "partial", symbol: "PART", name: "wsl-cli", path: "C:\\Users\\me\\.codex\\bin\\wsl\\65bf23c0", leftovers: 3 }
          : { state: "missing", symbol: "MISS", name: "wsl-cli", path: "C:\\Users\\me\\.codex\\bin\\wsl\\b53f5e5f", leftovers: 0 },
        { state: "ok", symbol: "OK", name: "wsl-rg", path: "C:\\Users\\me\\.codex\\bin\\wsl\\1a4f6f66", leftovers: 0 },
        { state: "ok", symbol: "OK", name: "cua_node", path: "C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\b474a88d", leftovers: 0 },
      ],
      pluginsMaterialized: false,
      appUserModelId: null,
      probeResult: null,
      probeMessage: null,
      startupDiagnosis: null,
      // repairTargets 照 healthRepairTargets 的口径写（只认 partial）；needsRepair 是
      // 「窗口没出现 **或** 有残留」，这里没有探针，所以两者同真同假。
      needsRepair: healthPartial,
      repairTargets: healthPartial ? ["wsl-cli"] : [],
      raw: "",
    };

// 「检查更新」的固定结论：装了 26.901.6511.0，官方分发源上有 26.902.100.0。
const STUB_UPDATE = {
  installedVersion: "26.901.6511.0",
  availableVersion: "26.902.100.0",
  fileName: "OpenAI.Codex_26.902.100.0_x64__2p2nqsd0c76g0.msix",
  updateAvailable: true,
  downloadedPath: null,
  skipped: false,
  // 真实脚本即便只跑 `-CheckOnly` 也会剪枝下载缓存（保留最近两个），所以这个字段有内容
  // 是常态；夹具给空数组，因为这里没有真的动过磁盘。
  removedCacheFiles: [],
  downloadDirectory: "C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\downloads",
};

// --up-to-date 用的结论：装的就是最新版 —— updateAvailable=false，且
// installedVersion 与 availableVersion 相等（脚本判「已是最新」就是这两个相等）。
//
// installedVersion 必须与 STUB_HEALTH 里那个版本一致：真实运行里 get_status 与
// check_update 报的是同一个已安装版本，夹具让它们不一致就造出了一种现实中不存在的形状，
// 顶栏那行断言也就不再说明任何事情。
const STUB_UPDATE_LATEST = {
  ...STUB_UPDATE,
  installedVersion: "26.901.6511.0",
  availableVersion: "26.901.6511.0",
  fileName: null,
  updateAvailable: false,
};

// 自更新场景用的 GitHub Release：比当前打包版本（0.4.0）新一版，资产带 GitHub
// 计算好的 sha256 摘要。下载命令只认这个摘要，所以桩里必须给得像真的。
//
// 正文带 Markdown 标记（标题、列表、反引号），用来验证公告摘要会把它剥成纯文本；
// 直接铺原文的话，界面上会出现一排 `##` 和 `-`。
const STUB_UPDATER = {
  version: "0.6.0",
  tag: "desktop-v0.6.0",
  name: "Codex Updater 0.6.0",
  body: "## 本次更新\n\n- 设置 → 关于可以直接检查更新\n- 公告按 `CHANGELOG` 维护\n\n升级后请重启一次应用。",
  url: "https://github.com/aygzs123/Codex-Auto-Update-Plugin-New/releases/tag/desktop-v0.6.0",
  publishedAt: "2026-11-20T00:00:00Z",
  assets: [
    {
      name: "Codex Updater Setup 0.6.0.exe",
      size: 88_000_000,
      url: "https://github.com/aygzs123/Codex-Auto-Update-Plugin-New/releases/download/desktop-v0.6.0/CodexUpdater.exe",
      digest: `sha256:${"a".repeat(64)}`,
    },
  ],
};

// 「版本历史」卡片的数据源。三行一次覆盖三种 relation：比当前新的（已下载未安装）、
// 当前这一版、以及唯一能回退的那一版。未安装的机器上缓存是空的 —— 这条也要有，
// 空列表必须给出解释文案，不能是一个空盒子。
const CACHE_DIRECTORY = "C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\downloads";
const INSTALL_LOCATION = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0";

// --storage 场景的磁盘与迁移夹具。数字写大一点没关系，反正它们只用来渲染；
// 关键是路径必须是「真实形状」—— 安装位置带版本号，AppxVolume 以 WindowsApps 结尾。
const STUB_STORAGE = {
  download: { path: CACHE_DIRECTORY, totalBytes: 512_000_000_000, freeBytes: 238_000_000_000 },
  install: { path: INSTALL_LOCATION, totalBytes: 512_000_000_000, freeBytes: 238_000_000_000 },
};
// 缓存目录必须等于用户选择，不允许再追加固定子目录。
const MIGRATION_FOLDER = "E:\\Codex 缓存";
const MIGRATION_TARGET = MIGRATION_FOLDER;
let cachePickerPath = MIGRATION_FOLDER;
let emptyMigration = false;
let cancelCachePick = false;
const STUB_APP_CAPABILITY = {
  installed: true,
  version: "26.901.6511.0",
  installLocation: INSTALL_LOCATION,
  packageVolume: "C:\\Program Files\\WindowsApps",
  movable: true,
  reason: "Windows 报告该包可以移动到其他 AppxVolume。",
  volumes: [
    {
      path: "C:\\Program Files\\WindowsApps",
      label: "C:",
      isSystemVolume: true,
      freeBytes: 238_000_000_000,
      totalBytes: 512_000_000_000,
    },
    {
      path: "E:\\WindowsApps",
      label: "E:",
      isSystemVolume: false,
      freeBytes: 900_000_000_000,
      totalBytes: 1_000_000_000_000,
    },
    // 第二个候选卷存在的意义：下拉框必须真的能选，选中值要原样传给 move_codex_app。
    // 只有一个选项时「选择」这一步等于没测 —— 界面把值写死也照样通过。
    {
      path: "F:\\WindowsApps",
      label: "F:",
      isSystemVolume: false,
      freeBytes: 64_000_000_000,
      totalBytes: 128_000_000_000,
    },
  ],
};

// 设置桩必须可写：主题切换走的是 save_settings → get_settings 回读，
// 桩若恒回初始值，界面会「保存成功」却立刻弹回上一个主题，量到的永远是初始态。
const DEFAULT_STUB_SETTINGS = {
  downloadDirectory: "",
  defaultDownloadDirectory: CACHE_DIRECTORY,
  logsDirectory: "C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\logs",
  dismissedTips: [],
  // 新增设置的默认档：主题跟随系统、自动检查开、自动下载关、通知开、每 6 小时复查、
  // 不自动清理缓存。显式写出来而不是靠缺省值，界面断言才不是「字段全空也恰好成立」。
  theme: "system",
  autoCheck: true,
  autoDownload: false,
  notifyUpdates: true,
  checkIntervalHours: 6,
  cacheKeepCount: 0,
  showVersionHistory: true,
};
let stubSettings = { ...DEFAULT_STUB_SETTINGS };
const cachedPackage = (version, relation) => ({
  version,
  architecture: "x64",
  sizeBytes: 836000000 + Number(version.split(".")[1]) * 1000,
  modifiedAt: "2026-09-20T09:00:00Z",
  relation,
  path: `${CACHE_DIRECTORY}\\OpenAI.Codex_${version}_x64__2p2nqsd0c76g0.msix`,
});
const STUB_CACHED_PACKAGES = notInstalled
  ? { downloadDirectory: CACHE_DIRECTORY, installedVersion: null, packages: [] }
  : {
      downloadDirectory: CACHE_DIRECTORY,
      installedVersion: "26.901.6511.0",
      packages: [
        cachedPackage("26.902.100.0", "newer"),
        cachedPackage("26.901.6511.0", "installed"),
        cachedPackage("26.896.100.0", "older"),
      ],
    };

// 每条命令真实走过的 IPC 次数（见 registerStubHandlers）。
const commandCalls = {};
// 每条命令最后一次收到的参数。回退场景要拿它证明 allowDowngrade 真的传下去了 ——
// 少了这个开关，Add-AppxPackage 会被 Windows 拒绝，而界面看起来一切正常。
const commandArgs = {};
// --checking 场景里被挂住的 check_update，按调用顺序排队；测试侧调用 release() 放行。
const releaseHeldUpdate = [];
const releaseUpdate = () => releaseHeldUpdate.splice(0).forEach((resolve) => resolve());
// --boot 场景里被挂住的 get_settings：bootstrap 的第一条命令，挂住它，界面就停在
// 「正在读取本机」那一段上。放行之后启动照常往下走。
const releaseHeldBoot = [];
const releaseBoot = () => releaseHeldBoot.splice(0).forEach((resolve) => resolve());
// --rollback 场景里被挂住的 install_codex，同上。
const releaseHeldInstall = [];
const releaseInstall = () => releaseHeldInstall.splice(0).forEach((resolve) => resolve());

function registerStubHandlers() {
  // preload 在首帧前用 sendSync 读主题。真实主进程有这条 handler；这里没有的话
  // Electron 只会打一行警告，但页面首帧的主题会退回 matchMedia —— 深色截图就不可信了。
  ipcMain.on("desktop:initial-theme", (event) => {
    event.returnValue = {
      preference: darkMode ? "dark" : "system",
      resolved: darkMode || nativeTheme.shouldUseDarkColors ? "dark" : "light",
    };
  });
  ipcMain.handle("desktop:command", (_event, command, args) => {
    // 记下每条命令真的走了几次 IPC。这是「命令跑着时再点不会叠加」唯一可靠的证据：
    // DOM 上的 disabled 只说明按钮点不动，说明不了快捷键/其它入口有没有绕过去。
    commandCalls[command] = (commandCalls[command] || 0) + 1;
    commandArgs[command] = args || {};
    switch (command) {
      case "get_settings":
        // --boot 场景把它挂住：它是 bootstrap 的第一条命令，卡在这里界面就老老实实待在
        // 「正在读取本机」那一段。真实运行时这一段只有一次 IPC 往返，不挂住根本量不到。
        if (bootHold) {
          return new Promise((resolve) => {
            releaseHeldBoot.push(() =>
              resolve({
                downloadDirectory: "",
                defaultDownloadDirectory: "C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\downloads",
                logsDirectory: "C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\logs",
              }),
            );
          });
        }
        return { ...stubSettings };
      case "save_settings":
        // 只合并、不校验：真实主进程归一化的逻辑在 main.cjs，由单测钉住；
        // 这里要的是「写进去的值能被读回来」，否则主题断言测的就不是保存链路。
        Object.assign(stubSettings, args || {});
        return { ...stubSettings };
      case "get_status":
      case "check_health":
        return STUB_HEALTH;
      case "list_cached_packages": {
        // 不桩的话默认分支会回一个 {}，渲染进程读 packages 会炸。
        //
        // 路径跟着当前缓存目录走：存储场景会切换目录，桩若恒回旧目录的路径，
        // 界面顶部的「缓存所在磁盘」就会和输入框里的新目录对不上 —— 那是假象，
        // 不是产品 bug，但会让截图和断言都开始说谎。
        const directory = stubSettings.downloadDirectory || CACHE_DIRECTORY;
        return {
          ...STUB_CACHED_PACKAGES,
          downloadDirectory: directory,
          packages: STUB_CACHED_PACKAGES.packages.map((pkg) => ({
            ...pkg,
            path: `${directory}\\${pkg.path.split("\\").pop()}`,
          })),
        };
      }
      case "get_storage_info":
        return { ...STUB_STORAGE };
      case "precheck_cache_migration": {
        // 预检只读；返回一份与缓存夹具一致的清单。注意这里**不是**授权：
        // 真正的 migrate_cache 桩永远不会被调用（场景断言它的调用次数是 0）。
        const target = String(args?.targetDirectory ?? MIGRATION_TARGET);
        const files = (emptyMigration ? [] : STUB_CACHED_PACKAGES.packages).map((pkg) => ({
          name: pkg.path.split("\\").pop(),
          sizeBytes: pkg.sizeBytes,
        }));
        return {
          sourceDirectory: CACHE_DIRECTORY,
          targetDirectory: target,
          files,
          totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
          freeBytes: 900_000_000_000,
          conflicts: [],
        };
      }
      case "pick_directory":
        return storageScenario && !cancelCachePick ? { canceled: false, path: cachePickerPath } : { canceled: true };
      case "pick_app_migration_directory":
        return {
          selectedDirectory: "F:\\团队工具\\Codex",
          volumePath: "F:\\WindowsApps",
          reason: "应用由 Windows 安装在此卷的 WindowsApps 下。",
        };
      case "migrate_cache":
        // 场景里只走到确认块就取消。真的被调用说明「确认前不许动」这条被破坏了，
        // 场景断言会失败；这里仍然给一个诚实的取消结果，别让流程卡死。
        return {
          ok: false,
          cancelled: true,
          sourceDirectory: CACHE_DIRECTORY,
          targetDirectory: String(args?.targetDirectory ?? MIGRATION_TARGET),
          copiedCount: 0,
          copiedBytes: 0,
          skippedCount: 0,
          cleanedCount: 0,
          cleanupFailures: [],
        };
      case "cancel_cache_migration":
        return { cancelling: false };
      case "get_app_migration_capability":
        return storageScenario
          ? { ...STUB_APP_CAPABILITY }
          : {
              installed: false,
              version: null,
              installLocation: null,
              packageVolume: null,
              movable: false,
              reason: "尚未检测。",
              volumes: [],
            };
      case "move_codex_app":
        // 真实主进程会先弹原生确认框、再跑提权脚本。桩里直接回「已取消」，
        // 验证的正是「用户拒绝」这条正常路径：界面给提示，不亮红字。
        return {
          ok: false,
          cancelled: true,
          installLocation: null,
          message: "已取消迁移，Codex 没有被移动。",
        };
      case "open_storage_settings":
        return { ok: true };
      case "verify_download_signature":
        // 回退和安装共用同一道签名闸门。桩回「通过」，让流程能走到安装那一步 ——
        // 校验失败的分支由 tests/verify.test.cjs 真正执行着判断逻辑。
        //
        // 发布者写成真实的 GUID 形式，不是 "CN=OpenAI, ..."：那个假值正是当初把
        // 「主题里含 openai」这套判断喂出来的东西，留着它等于把 bug 的现场擦干净了。
        return {
          status: "verified",
          publisher: "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B",
          expectedPublisher: "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B",
          authenticode: "Valid",
          sha256: "9f2c4a1d7e5b8036c6f1a2d4e8b70c395a1f6d2e4c8b0a3f5d7e9c1b2a4f608d",
          message: "签名校验通过",
        };
      case "install_codex":
        // 回退场景把安装挂住：真实安装要跑几十秒，界面「正在回退…」的中间态全靠它才观察得到。
        if (rollbackScenario) {
          return new Promise((resolve) => {
            releaseHeldInstall.push(() =>
              resolve({
                ok: true,
                windowMissing: false,
                remedy: null,
                healthSnapshot: [],
                logPath: "C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\logs\\install.log",
                version: "26.896.100.0",
                health: { ...STUB_HEALTH, version: "26.896.100.0" },
              }),
            );
          });
        }
        return {};
      // 「打开 Codex」的失败形态：启动请求发出去了、进程也在跑，但主窗口没出现。
      // 桩里按场景给出不同的 startupDiagnosis —— 界面必须据此切换文案与修复入口。
      //
      // probeMessage 照抄真实脚本的口径：只收 WARNING 行与判定说明句，
      // STARTUP_DIAGNOSIS= 是单独一栏，不会混进这里（见 electron/parse.cjs）。
      // 秒数写 20：这两种判定都没触发「还在落缓存」的延长，探针就是走满了 20 秒。
      case "launch_codex":
        return {
          ok: false,
          windowVisible: false,
          version: "26.901.6511.0",
          appUserModelId: "OpenAI.Codex_2p2nqsd0c76g0!App",
          probeMessage:
            "WARNING: Codex Desktop processes are up but NO main window appeared within 20 s. " +
            (launchUnknown
              ? "No cause could be determined from the relocation-health evidence. This is not, by itself, " +
                "evidence of the encrypted-resource relocation bug."
              : "This is the signature of the official encrypted-resource relocation bug."),
          startupDiagnosis: launchUnknown ? "unknown" : "relocation-bug",
          health: {
            ...STUB_HEALTH,
            exitCode: 3,
            // 这两条场景演的是「五个资源副本都好端端的，主窗口照样没出现」——
            // 也就是 2026-09-07 那次真实搬迁 bug 的形状（win-cli 自己物化是成功的，
            // 窗口却没起来）。所以组件必须显式覆盖成全 ok，不能沿用默认夹具里那个
            // missing 的 wsl-cli：脚本是按组件算 overall 的，「组件 degraded + overall ok」
            // 是真实运行里造不出来的自相矛盾夹具。
            overall: "ok",
            components: STUB_HEALTH.components.map((component) => ({
              ...component,
              state: "ok",
              symbol: "OK",
              leftovers: 0,
            })),
            appUserModelId: "OpenAI.Codex_2p2nqsd0c76g0!App",
            probeResult: "window-not-visible",
            probeMessage: "WARNING: Codex Desktop processes are up but NO main window appeared within 20 s.",
            startupDiagnosis: launchUnknown ? "unknown" : "relocation-bug",
            needsRepair: true,
            // 空数组是**故意的**：这两条场景演的是「组件都好好的、就是窗口没出来」，
            // 那正是 needsRepair 的探针分支，不是资源残留。通用修复横幅的判据是
            // repairTargets，这里给它空，横幅才只可能来自启动卡片这一张 ——
            // 顺带把「两张卡片不会同时出现」这件事在冒烟层也钉住。
            repairTargets: [],
          },
        };
      case "check_update":
        // --checking 场景把它挂住：真实的 check_update 是一次网络往返，几秒不回话。
        // 返回一个由测试侧决定何时 resolve 的 Promise，就有了一段稳定的「命令跑着」
        // 的窗口可以用来观察界面。每次调用各挂一个，方便反复观察。
        //
        // 注意挂住的是**每一次**调用，包括启动时那次自动检查 —— 这正好给场景提供了
        // 一个真实形状的「启动就在忙」的窗口（用户什么都没点，界面已经置灰）。
        if (checkingHold) {
          return new Promise((resolve) => {
            releaseHeldUpdate.push(() => resolve({ ...STUB_UPDATE }));
          });
        }
        return { ...(upToDateScenario ? STUB_UPDATE_LATEST : STUB_UPDATE) };
      case "get_github_updates":
        // 不桩的话会落到默认分支回一个 {}：渲染进程读到 undefined 字段，公告与更新结论
        // 都变成空的 —— 而界面上看起来一切正常。
        //
        // 公告只放远端的 0.6.0；0.1.0 ~ 0.5.0 来自打包进应用的 CHANGELOG，
        // 两条来源合并后必须是 0.6.0 在最前、且没有重复的 tag。
        return appUpdateScenario
          ? {
              updater: { ...STUB_UPDATER },
              announcements: [{ ...STUB_UPDATER }],
              error: null,
              stale: false,
            }
          : { updater: null, announcements: [], error: null, stale: false };
      case "download_app_update":
        // 自更新场景：不真的下载一百多兆，也不跑真实安装器。这里只验证
        // 「界面 → IPC → 回到界面」这条链路，以及下载完成后界面切到可安装态。
        return {
          path: "C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\updates\\Codex Updater Setup 0.6.0.exe",
          size: STUB_UPDATER.assets[0].size,
          sha256: "a".repeat(64),
        };
      case "install_app_update":
        // 真正的安装会启动安装器并退出应用。桩里只回执，不跑它。
        return { ok: true };
      case "open_release":
        // 「查看公告」只验证链路通到主进程；真实 URL 前缀校验在 main.cjs，由单测钉住。
        return { ok: true };
      case "copy_text":
        // 「复制诊断信息」的链路要真的走完才叫验证过：菜单 → runAction → store 拼文本 →
        // IPC → 剪贴板。这里写进**真实的**系统剪贴板，断言再从主进程读回来。
        clipboard.writeText(String(args?.text ?? ""));
        return { ok: true };
      case "notify_update":
        // 自动检查拿到「有新版」之后会调它。断言在真机上做不了（开发模式下通知不一定
        // 显示得出来），这里只确认调用真的发生了，别让它落进默认分支里悄无声息。
        return { shown: false, reason: "stub" };
      default:
        return {};
    }
  });
  // 窗口控制是主进程实现的，这里没有主进程，所以补一个最小桩：关键是
  // is-maximized 必须回 false，否则渲染进程的 Promise 会 reject，控制台里留一堆
  // 未注册 handler 的报错，把真正的失败淹掉。
  ipcMain.handle("desktop:window", (_event, action) => (action === "is-maximized" ? false : undefined));
}

function recordConsoleMessage(...args) {
  // Electron 35+ 传单个 details 对象，更早的版本传 (event, level, message, ...)。
  const details = args[0];
  if (details && typeof details === "object" && "message" in details) {
    if (details.level === "error" || details.level === "warning") {
      consoleErrors.push(`${details.level}: ${details.message}`);
    }
    return;
  }
  const [, level, message] = args;
  if (level >= 2) consoleErrors.push(String(message));
}

async function inspect(window) {
  const run = (script) => window.webContents.executeJavaScript(script);
  // 界面改成了「概览 / 诊断 / 版本历史 / 设置」四页，DOM 里同时只存在当前这一页。
  // 每次 inspect 都先回概览，再逐页导航采集 —— 顺序固定，测量结果才可重复。
  const go = async (view) => {
    await run(
      `(() => { const item = document.querySelector('.nav-item[data-nav="${view}"]'); if (item) item.click(); return !!item; })()`,
    );
    // 页面入场动画 0.24s；等它落定再量，否则位置都在动画起始帧上。
    await new Promise((resolve) => setTimeout(resolve, 300));
  };

  await go("overview");
  const overview = await run(`(() => {
    const text = (selector) => {
      const element = document.querySelector(selector);
      return element ? element.textContent.trim() : "";
    };
    const cta = document.querySelector(".cta-row .button.primary");
    const shell = document.querySelector(".app-shell");
    return {
      phase: shell ? shell.dataset.phase : null,
      rootChildren: document.getElementById("root")?.childElementCount ?? -1,
      hasAppShell: !!document.querySelector(".app-shell"),
      styleSheetCount: document.styleSheets.length,
      heading: text(".hero-card h1"),
      // 主区那枚小标题（Up to date / Installed / One-click Setup / Local check）。
      // 它也得跟着启动阶段走：第一段还没拿到 status，按老写法会掉到「One-click Setup」。
      eyebrow: text(".hero-card .eyebrow"),
      // 主区副标题。用户明确要求「读取本机的时候应该给一下更好的提示吧，不然不知道」——
      // 启动是「只读本机」→「联网查最新版」两段，副标题是唯一能交代中间态的地方：
      // 第一段要说清在读什么且不联网，第二段要自己声明查询还在飞。
      lede: text(".hero-card .lede"),
      // 版本结论现在只在主区给：大字是结论，右侧「版本状态」仪表写「当前 → 分发源」。
      // 顶栏那枚小胶囊已经删掉（窗口一窄就截断版本号），所以这里量的是仪表本身。
      instrument: (() => {
        const nodes = [...document.querySelectorAll(".inst-flow .inst-node")];
        return {
          nodes: nodes.map((node) => ({
            label: node.querySelector(".k")?.textContent.trim() ?? "",
            value: node.querySelector(".v")?.textContent.trim() ?? "",
            pending: !!node.querySelector(".skeleton"),
          })),
          foot: text(".inst-foot"),
        };
      })(),
      // 「上次检查 14:32」。顶栏删掉之后它落到主区底部的 .hero-meta 里 ——
      // 结论已经出来了，就必须能说出它是什么时候问到的。
      lastCheck: text(".hero-meta span"),
      // 顶栏的公告铃铛与红点。公告不再铺在概览页里，入口就是这颗铃铛。
      bell: (() => {
        const button = document.querySelector(".bell-button");
        if (!button) return null;
        return {
          present: true,
          dot: !!document.querySelector(".bell-dot"),
          label: button.getAttribute("aria-label") || "",
          expanded: button.getAttribute("aria-expanded") === "true",
        };
      })(),
      ctaLabel: cta ? cta.textContent.trim() : "",
      ctaDisabled: cta ? cta.disabled : null,
      // 主区一共几颗按钮。次按钮「仅检查更新」在「已是最新」时应当隐去 ——
      // 已经没什么可检查的了，留着一颗只会让人以为还有别的事可做。
      ctaCount: document.querySelectorAll(".cta-row button").length,
      healthRows: document.querySelectorAll(".health-row").length,
      verdict: text(".verdict"),
      fieldHelp: Array.from(document.querySelectorAll(".field-help")).map((node) => node.textContent.trim()).join(" | "),
      activity: {
        label: text(".progress-line span"),
        percent: text(".progress-line strong"),
        indeterminate: !!document.querySelector(".progress-track.indeterminate"),
        fillWidth: document.querySelector(".progress-fill")?.style.width ?? "",
        subline: text(".subline"),
        warning: text(".error-text.soft"),
        logSummary: text(".log-details summary"),
        logText: text(".log"),
      },
      // 高级设置的路径行：输入框用 width:100% 会把按钮挤到裁切，这里量出来。
      // 高级设置里的**每一条**路径行都要量：输入框 flex:1 会把右边的按钮挤到折行
      // 或溢出容器，而折行既不会让 scrollWidth 超出、也不会溢出容器，只有行盒数量
      // 反映得出来。以前只量第一行，新加的「Codex 安装位置」那一行就等于没被检查
      // —— 而它右边的按钮（现在是「打开安装目录」，改名前是「打开 Windows 存储设置」）
      // 恰恰是路径行里最长的一个。
      pathRowButtons: (() => {
        const rows = [...document.querySelectorAll(".path-row")];
        if (rows.length === 0) return null;
        return rows.flatMap((row, rowIndex) => {
          const rowRect = row.getBoundingClientRect();
          return [...row.querySelectorAll("button")].map((button) => {
            const rect = button.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(button);
            const lineBoxes = new Set([...range.getClientRects()].map((entry) => Math.round(entry.top))).size;
            return {
              rowIndex,
              label: button.textContent.trim(),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              lineBoxes,
              clipped: button.scrollWidth > button.clientWidth + 1 || lineBoxes > 1,
              overflowsRow: Math.round(rect.right) > Math.round(rowRect.right) + 1,
            };
          });
        });
      })(),
      // 「Codex 安装位置」显示的是包自己报的路径。它必须原样呈现：用户可能把应用
      // 装到了 D 盘，任何「按 C 盘拼一遍」的做法都会在这里露出来。
      installLocationField: (() => {
        const field = document.querySelector("#install-location");
        return field ? field.value : null;
      })(),
      // 窗口控制按钮：既是美观问题也是可点区域问题，14px 的圆点太小了。
      windowControls: [...document.querySelectorAll(".window-controls button")].map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          label: button.getAttribute("aria-label") || "",
          className: button.className,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          left: Math.round(rect.left),
        };
      }),
      // 只认硬错误：.error-text.soft 是软告警（安装包删不掉、窗口探测失败这类
      // 已知且已有补救入口的情况），不是失败。
      errorText: text(".error-text:not(.soft)"),
      // 脚本原始输出的落点（健康面板里的窗口探测诊断就在这里）。
      rawOutputs: [...document.querySelectorAll(".raw-output")].map((node) => node.textContent.trim()),
      // 「打开 Codex」失败时的横幅：既要看到结论，也要能真的点到修复按钮 ——
      // 只留一句提示、用户找不到下一步，对他而言仍然是「点了没反应」。
      launchCard: (() => {
        const cards = [...document.querySelectorAll(".panel.warn-card")];
        const card = cards.find((node) => node.textContent.includes("主窗口没有出现"));
        if (!card) return null;
        const heading = card.querySelector("h3");
        // 卡片正文也要看：判定不出来时必须如实说明，而且**不能**出现修复按钮的文案。
        const text = card.textContent.replace(/\s+/g, " ").trim();
        const button = card.querySelector("button");
        if (!button) return { heading: heading ? heading.textContent.trim() : "", text, missingButton: true };
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          heading: heading ? heading.textContent.trim() : "",
          text,
          buttonLabel: button.textContent.trim(),
          buttonDisabled: button.disabled,
          buttonWidth: Math.round(rect.width),
          buttonHeight: Math.round(rect.height),
          buttonTop: Math.round(rect.top),
          buttonCovered: !(hit && (hit === button || button.contains(hit))),
          hitTag: hit ? hit.className || hit.tagName : "(空)",
        };
      })(),
      // 页面上所有告警卡的标题。默认场景用它做**否定**断言：组件缺失（真机那份夹具里
      // wsl-cli 就是 missing）不该弹任何卡片，所以这个列表必须是空的。
      //
      // 只断言「修复横幅的读取器返回 null」不够 —— 那样即使有人把横幅标题改回旧文案
      // 「检测到启动资源不完整」，读取器同样返回 null，误报就这么漏过去了。
      warnCardHeadings: [...document.querySelectorAll(".panel.warn-card h3")].map((node) =>
        node.textContent.trim(),
      ),
      // 资源修复横幅（「资源副本留有未完成的物化痕迹」）。
      //
      // **按标题定位，不能取第一张 .warn-card**：安装失败与启动失败那两张也在册，
      // 取第一张的话，这条断言在别的场景里会安静地量到另一张卡片。
      // 匹配用「资源副本」这个子串而不是整句标题：标题措辞可以微调，
      // 但一旦它不再是「关于资源副本」的那张卡，这条就该红。
      repairCard: (() => {
        const cards = [...document.querySelectorAll(".panel.warn-card")];
        const card = cards.find((node) => (node.querySelector("h3")?.textContent ?? "").includes("资源副本"));
        if (!card) return null;
        return {
          heading: card.querySelector("h3").textContent.trim(),
          text: card.textContent.replace(/\s+/g, " ").trim(),
        };
      })(),
      // 版本历史 / 回退卡片。
      //
      // 逐行量按钮，而不是只看卡片在不在：回退按钮被挤到折行或被旁边的元素盖住时，
      // 「卡片渲染出来了」这条断言照样通过，用户却点不到 —— 而这个功能全部的价值
      // 就在那一颗按钮上。顺带数一遍页面上的「删除」字样：删掉旧安装包是不可逆的，
      // 一旦有人加回一颗删除按钮，这里必须挡住。
      rollback: (() => {
        const card = document.querySelector(".rollback-card");
        if (!card) return null;
        const rows = [...card.querySelectorAll(".rollback-row")];
        const help = [...card.querySelectorAll(".field-help")].map((node) => node.textContent.trim());
        // 这张卡片在页面靠下，不先滚进视口的话 elementFromPoint 只会拿到 null，
        // 报出来的是「被盖住」——一个和真实原因（压根不在视口里）无关的结论。
        //
        // 量完必须把滚动位置还回去。inspect() 一次运行里会被调用好几遍，留下一个
        // 滚过的视口，后面每一次基于 elementFromPoint 的测量都会量错：实测就是
        // 「打开 Codex 失败横幅里的修复按钮被盖住（顶部 -348px）」——按钮根本没动过，
        // 是视口被这一次测量带跑了。
        const scroller = document.querySelector(".app-scroll");
        const savedScrollTop = scroller ? scroller.scrollTop : 0;
        // 模态结论对话框开着的时候不做命中测试：遮罩铺满整屏且 z-index 高于一切，
        // 任何坐标都会命中遮罩本身，量出来一律是「被盖住」——那是对话框该有的行为，
        // 不是回退按钮的问题。
        const modalOpen = !!document.querySelector(".modal-backdrop");
        const measured = rows.map((row) => {
          const button = row.querySelector(".rollback-action");
          if (button) button.scrollIntoView({ block: "center" });
          const rect = button ? button.getBoundingClientRect() : null;
          const hit =
            rect && !modalOpen
              ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
              : null;
          let lineBoxes = 0;
          if (button) {
            const range = document.createRange();
            range.selectNodeContents(button);
            lineBoxes = new Set([...range.getClientRects()].map((entry) => Math.round(entry.top))).size;
          }
          return {
            version: row.querySelector(".health-labels strong")?.textContent.trim() ?? "",
            state: row.querySelector(".health-state")?.textContent.trim() ?? "",
            className: row.className,
            buttonLabel: button ? button.textContent.trim() : "",
            buttonDisabled: button ? button.disabled : null,
            buttonWidth: rect ? Math.round(rect.width) : 0,
            buttonHeight: rect ? Math.round(rect.height) : 0,
            buttonLineBoxes: lineBoxes,
            // 跳过了命中测试就报 false：没量到的东西不能当成测出了缺陷。
            buttonCovered: rect && !modalOpen ? !(hit && (hit === button || button.contains(hit))) : false,
            overflowsRow: rect ? Math.round(rect.right) > Math.round(row.getBoundingClientRect().right) + 1 : false,
          };
        });
        if (scroller) scroller.scrollTop = savedScrollTop;

        return {
          heading: text(".rollback-card h3"),
          rowCount: rows.length,
          emptyHelp: rows.length === 0 ? help.join(" | ") : "",
          deleteButtonCount: [...card.querySelectorAll("button")].filter((button) =>
            button.textContent.includes("删除"),
          ).length,
          // 主按钮在回退途中该说什么，由它区分「安装」和「回退」。
          ctaLabel: cta ? cta.textContent.trim() : "",
          rows: measured,
        };
      })(),
      // 安装包缓存卡片。缓存不再自动清理之后，这张卡片是用户判断「占了多少、要不要清」
      // 的唯一入口，所以它得真的在页面上、标题上真的带着占用数字、清空按钮真的点得到。
      //
      // 标题里的占用不是装饰：它是「C 盘会不会被占满」这个担心最直接的答案。
      // 数字算错（比如把 sizeBytes 求和漏了）在这里就会露出来。
      cache: (() => {
        const card = [...document.querySelectorAll(".settings-card")].find((node) =>
          node.querySelector("summary")?.textContent.includes("安装包缓存"),
        );
        if (!card) return null;
        const summary = card.querySelector("summary")?.textContent.trim() ?? "";
        const clearButton = [...card.querySelectorAll("button")].find((button) =>
          button.textContent.includes("清空缓存"),
        );
        const toggle = card.querySelector('input[type="checkbox"]');
        return {
          summary,
          // 「更改位置…」是换目录的入口，它必须在这张卡片里 —— 用户看到占了多少之后，
          // 下一个问题必然是「能不能挪到别的盘」。
          hasBrowse: [...card.querySelectorAll("button")].some((b) => b.textContent.includes("更改位置")),
          clearLabel: clearButton ? clearButton.textContent.trim() : "",
          clearDisabled: clearButton ? clearButton.disabled : null,
          clearIsDanger: clearButton ? clearButton.classList.contains("danger") : null,
          historyToggleChecked: toggle ? toggle.checked : null,
          help: [...card.querySelectorAll(".field-help")].map((node) => node.textContent.trim()),
        };
      })(),
      // 命令结果的模态对话框。toast 已被彻底移除，所以这里连「页面上还有没有
      // 贴边的浮层」一起量：留着就说明又退回旧做法了。
      notice: (() => {
        const backdrop = document.querySelector(".modal-backdrop");
        const dialog = document.querySelector(".modal-dialog");
        const toast = !!document.querySelector(".toast");
        if (!backdrop || !dialog) return { present: false, toast };
        const rect = dialog.getBoundingClientRect();
        const button = dialog.querySelector("button");
        const buttonRect = button ? button.getBoundingClientRect() : null;
        const hit = buttonRect
          ? document.elementFromPoint(buttonRect.left + buttonRect.width / 2, buttonRect.top + buttonRect.height / 2)
          : null;
        return {
          present: true,
          toast,
          heading: text(".modal-dialog h3"),
          message: text(".modal-dialog p"),
          buttonLabel: button ? button.textContent.trim() : "",
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          // 居中程度用「偏了多少像素」而不是布尔值：失败时能直接看出偏到哪去了。
          //
          // 用 offsetTop/offsetHeight 而不是 getBoundingClientRect()：前者是布局位置，
          // 不受 transform 影响；后者会把入场动画的 translateY 算进去。断言「居中」
          // 说的是布局，把它挂到动画进度上，就会得到一个时灵时不灵的假失败
          // （实测同一个构建跑三次，两次 6px、一次 0px）。
          offsetX: Math.round(dialog.offsetLeft + dialog.offsetWidth / 2 - backdrop.clientWidth / 2),
          offsetY: Math.round(dialog.offsetTop + dialog.offsetHeight / 2 - backdrop.clientHeight / 2),
          inViewport:
            rect.top >= -1 &&
            rect.left >= -1 &&
            rect.bottom <= window.innerHeight + 1 &&
            rect.right <= window.innerWidth + 1,
          buttonHittable: !!(hit && (hit === button || button.contains(hit))),
          buttonFocused: button ? document.activeElement === button : false,
          // 模态要压过顶栏：顶栏是 z-index 30，对话框必须在它上面。
          backdropZ: Number(getComputedStyle(backdrop).zIndex) || 0,
          // 遮罩的几何与变换：定位偏了时要能一眼看出是遮罩没盖住视口、
          // 还是 transform 还在动画帧上，而不是只看到一个「偏了 N px」。
          backdropTop: Math.round(backdrop.getBoundingClientRect().top),
          backdropHeight: Math.round(backdrop.getBoundingClientRect().height),
          viewportHeight: window.innerHeight,
          transform: getComputedStyle(dialog).transform,
        };
      })(),
    };
  })()`);

  // 诊断页：健康结论、组件行、窗口探测原始输出都在那一页。
  await go("diagnostics");
  const diagnostics = await run(`(() => {
    const text = (selector) => {
      const element = document.querySelector(selector);
      return element ? element.textContent.trim() : "";
    };
    return {
      verdict: text(".verdict"),
      fieldHelp: Array.from(document.querySelectorAll(".field-help")).map((node) => node.textContent.trim()).join(" | "),
      healthRows: document.querySelectorAll(".health-row").length,
      rawOutputs: [...document.querySelectorAll(".raw-output")].map((node) => node.textContent.trim()),
    };
  })()`);

  // 设置页拆成了四个标签（通用 / 外观 / 存储 / 关于）。DOM 里同时只存在当前标签的
  // 内容，所以逐标签点击、逐标签采集；不先切标签就去找「安装包缓存」卡片，会得到
  // 一整片 null，而下面的断言会把 null 当成「没毛病」——那种绿是假的。
  await go("settings");
  const clickTab = async (tab) => {
    await run(
      `(() => { const el = document.getElementById("settings-tab-${tab}"); if (el) el.click(); return !!el; })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 220));
  };
  const settingsTabs = await run(`(() => {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    return {
      count: tabs.length,
      labels: tabs.map((tab) => tab.textContent.trim()),
      selected: tabs.filter((tab) => tab.getAttribute("aria-selected") === "true").length,
      panelIds: tabs.map((tab) => tab.getAttribute("aria-controls")),
    };
  })()`);

  await clickTab("general");
  const general = await run(`(() => {
    const cards = [...document.querySelectorAll(".settings-card")];
    const bySummary = (needle) =>
      cards.find((card) => card.querySelector("summary")?.textContent.includes(needle)) ?? null;
    const updateCard = bySummary("更新与通知");
    const networkCard = bySummary("网络诊断");
    return {
      hasUpdateCard: !!updateCard,
      updateSwitchCount: updateCard ? updateCard.querySelectorAll(".switch").length : 0,
      intervalValue: updateCard?.querySelector(".field-select")?.value ?? null,
      hasNetworkCard: !!networkCard,
      hasNetworkButton: !!(
        networkCard && [...networkCard.querySelectorAll("button")].some((b) => b.textContent.includes("诊断"))
      ),
    };
  })()`);

  await clickTab("appearance");
  const appearance = await run(`(() => {
    const card = [...document.querySelectorAll(".settings-card")].find((node) =>
      node.querySelector("summary")?.textContent.includes("外观"),
    );
    return {
      hasThemeCard: !!card,
      themeActive: card?.querySelector(".theme-option[data-active='true'] strong")?.textContent.trim() ?? "",
      themeOptionCount: card ? card.querySelectorAll(".theme-option").length : 0,
      themeRadios: card ? card.querySelectorAll('[role="radio"]').length : 0,
      themeChecked: card?.querySelector('[role="radio"][aria-checked="true"] strong')?.textContent.trim() ?? "",
    };
  })()`);

  await clickTab("storage");
  const settings = await run(`(() => {
    const pathRowButtons = (() => {
      const rows = [...document.querySelectorAll(".path-row")];
      if (rows.length === 0) return null;
      return rows.flatMap((row, rowIndex) => {
        const rowRect = row.getBoundingClientRect();
        return [...row.querySelectorAll("button")].map((button) => {
          const rect = button.getBoundingClientRect();
          // 只量文字节点的行盒：按钮是 inline-flex，图标和文字各占一个盒子，
          // 把图标算进去会把「同一行」误判成两行。
          const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
          const nodes = [];
          while (walker.nextNode()) {
            if (walker.currentNode.textContent.trim()) nodes.push(walker.currentNode);
          }
          let lineBoxes = 0;
          if (nodes.length) {
            const range = document.createRange();
            range.setStart(nodes[0], 0);
            range.setEnd(nodes[nodes.length - 1], nodes[nodes.length - 1].textContent.length);
            lineBoxes = new Set([...range.getClientRects()].map((entry) => Math.round(entry.top))).size;
          }
          return {
            rowIndex,
            label: button.textContent.trim(),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            lineBoxes,
            clipped: button.scrollWidth > button.clientWidth + 1 || lineBoxes > 1,
            overflowsRow: Math.round(rect.right) > Math.round(rowRect.right) + 1,
          };
        });
      });
    })();

    const installLocationField = (() => {
      const field = document.querySelector("#install-location");
      return field ? field.value : null;
    })();

    const cache = (() => {
      const card = [...document.querySelectorAll(".settings-card")].find((node) =>
        node.querySelector("summary")?.textContent.includes("安装包缓存"),
      );
      if (!card) return null;
      const summary = card.querySelector("summary")?.textContent.trim() ?? "";
      const clearButton = [...card.querySelectorAll("button")].find((button) =>
        button.textContent.includes("清空缓存"),
      );
      const toggle = card.querySelector('input[type="checkbox"]');
      return {
        summary,
        hasBrowse: [...card.querySelectorAll("button")].some((b) => b.textContent.includes("更改位置")),
        clearLabel: clearButton ? clearButton.textContent.trim() : "",
        clearDisabled: clearButton ? clearButton.disabled : null,
        clearIsDanger: clearButton ? clearButton.classList.contains("danger") : null,
        historyToggleChecked: toggle ? toggle.checked : null,
        help: [...card.querySelectorAll(".field-help")].map((node) => node.textContent.trim()),
      };
    })();

    // 存储摘要 + 两个迁移入口。缓存为空或正在读取时迁移按钮应置灰 —— 这条在
    // checkCacheStates 里单独验证；这里先确认入口真的在页面上。
    const storage = (() => {
      const summary = document.querySelector(".storage-summary");
      const buttons = [...document.querySelectorAll("button")].map((button) => button.textContent.trim());
      return {
        hasSummary: !!summary,
        summaryText: summary?.textContent.trim() ?? "",
        hasChangeLocation: buttons.some((label) => label.includes("更改位置")),
        hasCapabilityButton: buttons.some((label) => label.includes("检测迁移条件")),
        hasUserDataNote: (document.body.textContent || "").includes("不随应用迁移"),
      };
    })();

    return { pathRowButtons, installLocationField, cache, storage };
  })()`);

  // 自动保留份数在「存储」标签的缓存卡片里，必须在切走之前量；切到「关于」之后
  // DOM 里已经没有这张卡片，量到的只会是 null。
  const keepCountValue = await run(`(() => {
    const card = [...document.querySelectorAll(".settings-card")].find((node) =>
      node.querySelector("summary")?.textContent.includes("安装包缓存"),
    );
    return card?.querySelector(".field-select")?.value ?? null;
  })()`);

  await clickTab("about");
  const appUpdate = await run(`(() => {
    // 「关于 → Codex Updater 更新」一块。版本号、检查按钮与状态行都必须真的在页面上：
    // 这是自更新唯一的入口，藏起来等于功能不存在。
    const block = document.querySelector(".about-update");
    if (!block) return null;
    const about = block.closest(".card") ?? document;
    const version = about.querySelector(".about-row .pill")?.textContent.trim() ?? "";
    return {
      version,
      status: block.parentElement?.querySelector(".about-update-status")?.textContent.trim() ?? "",
      buttons: [...block.querySelectorAll("button")].map((button) => ({
        label: button.textContent.trim(),
        disabled: button.disabled,
      })),
    };
  })()`);

  const extras = { ...general, ...appearance, keepCountValue };

  // 版本历史页：逐行量回退按钮。ctaLabel 在概览页的主按钮上，这里量不到，
  // 合并时从 overview 补上（回退途中文案断言用的就是它）。
  await go("history");
  const history = await run(`(() => {
    const text = (selector) => {
      const element = document.querySelector(selector);
      return element ? element.textContent.trim() : "";
    };
    const card = document.querySelector(".rollback-card");
    if (!card) return { rollback: null };
    const rows = [...card.querySelectorAll(".rollback-row")];
    const help = [...card.querySelectorAll(".field-help")].map((node) => node.textContent.trim());
    const scroller = document.querySelector(".app-scroll");
    const savedScrollTop = scroller ? scroller.scrollTop : 0;
    const modalOpen = !!document.querySelector(".modal-backdrop");
    const measured = rows.map((row) => {
      const button = row.querySelector(".rollback-action");
      if (button) button.scrollIntoView({ block: "center" });
      const rect = button ? button.getBoundingClientRect() : null;
      const hit =
        rect && !modalOpen
          ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          : null;
      let lineBoxes = 0;
      if (button) {
        const range = document.createRange();
        range.selectNodeContents(button);
        lineBoxes = new Set([...range.getClientRects()].map((entry) => Math.round(entry.top))).size;
      }
      return {
        version: row.querySelector(".health-labels strong")?.textContent.trim() ?? "",
        state: row.querySelector(".health-state")?.textContent.trim() ?? "",
        className: row.className,
        // 逐行的小动作（校验签名 / 固定 / 删除）。它们不占 .rollback-action 那颗主按钮，
        // 单独收一遍：少任何一颗都意味着「逐包管理」只做了一半。
        actions: [...row.querySelectorAll(".vh-actions .link-button")].map((node) =>
          node.textContent.trim(),
        ),
        pinned: !!row.querySelector(".vh-version .pill"),
        buttonLabel: button ? button.textContent.trim() : "",
        buttonDisabled: button ? button.disabled : null,
        buttonWidth: rect ? Math.round(rect.width) : 0,
        buttonHeight: rect ? Math.round(rect.height) : 0,
        buttonLineBoxes: lineBoxes,
        buttonCovered: rect && !modalOpen ? !(hit && (hit === button || button.contains(hit))) : false,
        overflowsRow: rect ? Math.round(rect.right) > Math.round(row.getBoundingClientRect().right) + 1 : false,
      };
    });
    if (scroller) scroller.scrollTop = savedScrollTop;

    return {
      rollback: {
        heading: text(".rollback-card h3"),
        rowCount: rows.length,
        emptyHelp: rows.length === 0 ? help.join(" | ") : "",
        deleteButtonCount: [...card.querySelectorAll("button")].filter((button) =>
          button.textContent.includes("删除"),
        ).length,
        rows: measured,
      },
    };
  })()`);

  await go("overview");
  return {
    ...overview,
    ...diagnostics,
    ...settings,
    extras,
    appUpdate,
    settingsTabs,
    rollback: history.rollback ? { ...history.rollback, ctaLabel: overview.ctaLabel } : null,
  };
}

/**
 * 采集「所有能触发命令的入口是否可点」。
 *
 * 逐个入口量，而不是只看主按钮：用户说的「点完检查更新还能继续点」正是从菜单和次按钮
 * 来的 —— 主按钮置灰而菜单不置灰，等于闸门只关了一半。
 */
async function readBusyState(window) {
  const run = (script) => window.webContents.executeJavaScript(script);
  const go = async (view) => {
    await run(
      `(() => { const item = document.querySelector('.nav-item[data-nav="${view}"]'); if (item) item.click(); return !!item; })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 260));
  };
  const collect = (selector) => `(() => {
    return [...document.querySelectorAll(${JSON.stringify(selector)})].map((button) => ({
      label: button.textContent.trim(),
      disabled: button.disabled,
      title: button.title || "",
    }));
  })()`;

  // 命令入口现在分散在三页：概览的主/次按钮、诊断的自检按钮、设置里的回退与清空。
  // 每页单独导航采集，最后回到概览 —— 场景后续的断言与截图都基于概览。
  await go("overview");
  const cta = await run(collect(".cta-row button"));
  await go("diagnostics");
  const health = await run(collect(".dash-actions button, .page-head .button"));
  await go("settings");
  // 设置拆成四个标签之后，「打开目录 / 复制诊断 / 清空缓存」都在「存储」标签里。
  // 不先切过去，下面两条采集只会拿到空数组。
  await run(`(() => { const el = document.getElementById("settings-tab-storage"); if (el) el.click(); return !!el; })()`);
  await new Promise((resolve) => setTimeout(resolve, 220));
  // 即时入口：打开缓存/日志目录、复制诊断。它们不跑命令，忙时也必须可点。
  const instant = await run(collect(".settings-links button"));
  const cacheClear = await run(`(() => {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("清空缓存"));
    return button
      ? { label: button.textContent.trim(), disabled: button.disabled, title: button.title || "" }
      : null;
  })()`);
  await go("overview");
  return { cta, health, instant, cacheClear };
}

async function main() {
  console.log(`校验目标：${targetLabel}`);
  if (!existsSync(indexPath)) {
    console.error(`✗ 找不到产物：${indexPath}`);
    console.error(packaged ? "  请先运行 npm run electron:build" : "  请先运行 npm run build");
    app.exit(1);
    return;
  }

  registerStubHandlers();
  if (darkMode) nativeTheme.themeSource = "dark";

  // 截图时窗口真的会显示出来。不显式清空的话，它带着 Electron 默认的
  // File / Edit 菜单栏，看起来像另一个应用 —— 真实主窗口没有这一套。
  Menu.setApplicationMenu(null);

  const window = new BrowserWindow({
    // 截图需要真实合成，隐藏窗口抓图不可靠。
    show: Boolean(screenshotDir),
    width: windowWidth,
    height: 780,
    // 与真实主窗口保持一致：应用是自绘标题栏的无边框窗口。验证窗口若用 Electron
    // 默认边框，截图里会多出一条写着「Electron」的系统标题栏 —— 那是验证工具的窗口，
    // 不是产品界面，留在截图里会让人误以为应用带着一条原生顶栏。
    title: "Codex Updater",
    frame: false,
    titleBarStyle: "hidden",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(desktopRoot, "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 这个窗口多数时候是隐藏的，而 Chromium 对隐藏/被遮挡的窗口会节流动画：
      // CSS 动画停在起始帧上不往前走。表现是入场动画的 `from`（opacity 0、
      // 上移 6px）被当成最终状态量到 —— 对话框「没居中」、截图里干脆是看不见的。
      // 校验窗口要的是确定性的渲染，不是省电。
      backgroundThrottling: false,
    },
  });

  window.webContents.on("did-fail-load", (_event, code, description, url) => {
    failedLoads.push(`${description} (${code}) → ${url}`);
  });
  window.webContents.on("console-message", recordConsoleMessage);

  await window.loadFile(indexPath);

  // --boot：故意**不**等它退出 checking 态，就停在这一段上量。它是自成一体的早期出口，
  // 不掺进下面那套「先跑完所有交互、最后统一断言」的流程里 —— 那些交互的前提都是启动已经就绪。
  if (bootHold) {
    const bootDeadline = Date.now() + 10_000;
    let bootReport = await inspect(window);
    while (Date.now() < bootDeadline && bootReport.phase !== "checking") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      bootReport = await inspect(window);
    }
    const bootProblems = [];
    if (bootReport.phase !== "checking") {
      bootProblems.push(`界面没停在「正在读取本机」那一段（phase=${bootReport.phase}）`);
    }
    // 主区大字必须自己说清在读本机 —— 以前这里写的是「正在检查 Codex 状态」，含糊到
    // 用户不知道它在读什么，也不知道后面还有一步。
    if (!bootReport.heading.includes("读取本机")) {
      bootProblems.push(`读取本机时主区标题没说清在读本机：${bootReport.heading}`);
    }
    // 「只读本机，不联网」这半句是重点：它交代了这只是第一段，后面还有一次网络往返。
    if (!bootReport.lede.includes("只读本机") || !bootReport.lede.includes("不联网")) {
      bootProblems.push(`读取本机时没说清这一步不联网、后面还有一步：${bootReport.lede}`);
    }
    // 小标题也要跟着阶段走。老写法在这时候掉到「One-click Setup」——标题说着在读取本机，
    // 小标题却在承诺一键安装，两句话互相拆台。
    if (bootReport.eyebrow !== "Local check") {
      bootProblems.push(`读取本机时小标题不正确（不该承诺一键安装）：${bootReport.eyebrow}`);
    }
    // 两段式最硬的证据：本机还没读完，网络那一步一个字节都不该发出去。
    if ((commandCalls.check_update || 0) !== 0) {
      bootProblems.push(`本机还没读完就发了更新检查，实际 ${commandCalls.check_update} 次`);
    }
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true });
      const image = await window.webContents.capturePage();
      writeFileSync(join(screenshotDir, "boot.png"), image.toPNG());
      console.log(`  截图：${join(screenshotDir, "boot.png")}`);
    }
    // 放行，让这条命令有个正常归宿（挂着的 Promise 不该带进进程退出）。
    releaseBoot();
    if (bootProblems.length > 0) {
      console.error("✗ 渲染冒烟测试失败：");
      for (const problem of bootProblems) console.error(`  - ${problem}`);
      console.log(`  实测主区：${bootReport.heading} / ${bootReport.lede}（小标题 ${bootReport.eyebrow}）`);
      app.exit(1);
      return;
    }
    console.log("✓ 渲染冒烟测试通过（启动第一段：正在读取本机场景）");
    console.log(`  主区标题：${bootReport.heading}`);
    console.log(`  主区副标题：${bootReport.lede}`);
    console.log(`  主区小标题：${bootReport.eyebrow}`);
    console.log(`  此刻发出的 check_update：${commandCalls.check_update || 0} 次（两段式：本机读完才联网）`);
    app.exit(0);
    return;
  }

  // 等 IPC 往返完成、界面退出 checking 态。轮询而不是固定等待，避免慢机器上误报。
  // 注意不能只等「标题非空」：checking 态本身就有标题，那样会立刻退出。
  const deadline = Date.now() + 10_000;
  let report = await inspect(window);
  while (Date.now() < deadline && (report.phase === "checking" || report.phase === null)) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    report = await inspect(window);
  }

  // 还要等启动时那次自动检查的结论落到顶栏。
  //
  // bootstrap 刻意不 await 它（界面就绪不该等一次网络往返），所以「phase 不再是 checking」
  // 只说明设置与状态到手了，不说明那次检查回来了。少了这段等待，下面所有关于主按钮文案和
  // 顶栏的断言都是在跟一次异步 IPC 赛跑 —— 快机器上绿、慢机器上红，而且红得没有规律。
  //
  // 两个场景不适用：未安装时不查（没有「是不是最新」可言），--checking 场景里桩把
  // 每一次 check_update 都挂住（那正是它要演的「命令一直在跑」）。
  const expectAutoCheck = !notInstalled && !checkingHold;
  let autoCheckLanded = !expectAutoCheck;
  // 这里还不能往 problems 里推 —— 它在后面才声明（本文件是「先把所有场景跑完、再统一
  // 断言」的写法）。先记下来，等 problems 就位再并进去，免得变成一颗定时炸弹：
  // 只有失败路径才会执行到，平时永远发现不了。
  let autoCheckProblem = null;
  if (expectAutoCheck) {
    const autoDeadline = Date.now() + 5000;
    while (Date.now() < autoDeadline) {
      // 结论落在主区大字上：「已是最新版 X」或「可更新到 Y」。等它出现，
      // 说明启动那次自动检查真的回来了，而不是只在网络里飞着。
      const heading = await window.webContents.executeJavaScript(
        `(() => { const node = document.querySelector(".hero-card h1"); return node ? node.textContent.trim() : ""; })()`,
      );
      if (heading.includes("已是最新版") || heading.includes("可更新到")) {
        autoCheckLanded = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    report = await inspect(window);
    if (!autoCheckLanded) {
      autoCheckProblem = `启动后 5 秒内主区既没有「已是最新版」也没有「可更新到」，自动检查的结论没有落到界面上：${report.heading || "(空)"}`;
    }
  }

  // 启动刚就绪、用户还没点过任何东西的那一刻。
  //
  // 后面几个场景会真的去点按钮、覆盖 report，而「自动检查不弹模态」这条断言说的恰恰是
  // 启动这一刻 —— 拿被覆盖后的 report 去断，等于说「手动点检查之后没有对话框」，
  // 那是另一件事（而且必然是错的）。
  const startupReport = report;

  // 设置页现在是独立视图，卡片只在导航过去之后才存在。点进去、把所有 <details>
  // 展开并计数 —— 必须在状态数据到位之后做：settings 未就绪时这些卡片渲染 null。
  // 计数为 0 时下面那些路径行/安装位置的测量全是空值，会一路「通过」，那种绿是假的。
  const openedSettingsCount = await window.webContents.executeJavaScript(`(async () => {
    const nav = document.querySelector('.nav-item[data-nav="settings"]');
    if (nav) nav.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    let total = 0;
    for (const tab of ["general", "appearance", "storage", "about"]) {
      const button = document.getElementById("settings-tab-" + tab);
      if (button) button.click();
      await new Promise((resolve) => setTimeout(resolve, 220));
      const cards = [...document.querySelectorAll(".settings-card")];
      cards.forEach((card) => { card.open = true; });
      total += cards.length;
    }
    return total;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await window.webContents.executeJavaScript(
    `(() => { const nav = document.querySelector('.nav-item[data-nav="overview"]'); if (nav) nav.click(); return true; })()`,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 自更新场景：进「设置 → 关于」，把检查 → 下载两步完整点一遍。
  //
  // 只断言「卡片上有按钮」是不够的：这颗按钮要真的把 store 走通（检查 → 找到新版本
  // → 点下载 → 拿到路径），界面上才可能从「发现新版本」走到「已下载」。安装那一步
  // 不点 —— 真实安装会启动安装器并退出应用。
  let appUpdateReport = null;
  let bellReport = null;
  if (appUpdateScenario) {
    const clickSettings = async () => {
      await window.webContents.executeJavaScript(
        `(() => { const item = document.querySelector('.nav-item[data-nav="settings"]'); if (item) item.click(); return !!item; })()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 260));
      // 「关于」是设置页的第四个标签，自更新入口在那里。
      await window.webContents.executeJavaScript(
        `(() => { const el = document.getElementById("settings-tab-about"); if (el) el.click(); return !!el; })()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 220));
    };
    const readAbout = () =>
      window.webContents.executeJavaScript(`(() => {
        const block = document.querySelector(".about-update");
        if (!block) return null;
        const about = block.closest(".card") ?? document;
        return {
          version: about.querySelector(".about-update-version .ver")?.textContent.trim() ?? "",
          badge: about.querySelector(".about-update-version .pill")?.textContent.trim() ?? "",
          status: about.querySelector(".about-update-status")?.textContent.trim() ?? "",
          buttons: [...block.querySelectorAll("button")].map((button) => ({
            label: button.textContent.trim(),
            disabled: button.disabled,
          })),
        };
      })()`);
    const clickAbout = (label) =>
      window.webContents.executeJavaScript(`(() => {
        const block = document.querySelector(".about-update");
        const button = block && [...block.querySelectorAll("button")].find((node) => node.textContent.includes(${JSON.stringify(label)}));
        if (button) button.click();
        return !!button;
      })()`);

    await clickSettings();
    const initial = await readAbout();

    await clickAbout("检查更新");
    // 检查要走一次 refreshGithub(true) 的 IPC 往返，给它一点时间落定。
    await new Promise((resolve) => setTimeout(resolve, 500));
    const checked = await readAbout();

    await clickAbout("下载并安装");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const downloaded = await readAbout();

    // 公告铃铛：点开量时间线。0.6.0 来自远端桩，0.1.0 ~ 0.5.0 来自 CHANGELOG。
    const bell = await window.webContents.executeJavaScript(`(async () => {
      const button = document.querySelector(".bell-button");
      if (button) button.click();
      await new Promise((resolve) => setTimeout(resolve, 260));
      const panel = document.querySelector(".bell-panel");
      if (!panel) return null;
      const entries = [...panel.querySelectorAll(".timeline-item")].map((item) => ({
        title: item.querySelector(".timeline-head strong")?.textContent.trim() ?? "",
        // 公告正文现在是逐条列表；兼容兜底段落，断言读的是「这一版说了什么」。
        body: [
          ...item.querySelectorAll(".timeline-notes li"),
        ].map((node) => node.textContent.trim()).join(" ") ||
          item.querySelector(".timeline-body p")?.textContent.trim() ||
          "",
      }));
      const hasReleaseWording = /Release/i.test(panel.textContent);
      const closeButton = panel.querySelector(".bell-close");
      // 截图模式故意不关：要截的就是这块时间线。断言本身不受影响 —— 面板开着
      // 也不改任何按钮的可点状态，后面的场景会自己切回概览。
      ${screenshotDir ? "" : "if (closeButton) closeButton.click();"}
      return { entries, empty: !!panel.querySelector(".bell-empty"), hasReleaseWording };
    })()`);
    bellReport = bell;
    appUpdateReport = { initial, checked, downloaded };

    await window.webContents.executeJavaScript(
      `(() => { const item = document.querySelector('.nav-item[data-nav="overview"]'); if (item) item.click(); return true; })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // 进度流场景：先推下载阶段（验证不确定进度条），再推安装阶段（验证百分比推进）。
  let downloadReport = null;
  if (installing) {
    window.webContents.send("desktop:progress", {
      kind: "phase",
      id: "download",
      phase: "querying",
      label: "正在查询官方分发源",
      percent: 0,
    });
    window.webContents.send("desktop:progress", { kind: "download-bytes", bytes: 41943040, elapsedMs: 12000 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    downloadReport = await inspect(window);

    for (const event of PROGRESS_STREAM) {
      window.webContents.send("desktop:progress", event);
      // 让 React 有机会渲染中间态，这样百分比推进是真的被观察到的。
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    report = await inspect(window);
  }

  // 「打开 Codex」场景：从菜单触发真实的动作链路（菜单 → runAction → store.launch
  // → IPC → 桩），而不是直接改 state。这条链路正是用户点的地方。
  if (launchNoWindow || launchUnknown) {
    window.webContents.send("desktop:menu-action", "launch");
    await new Promise((resolve) => setTimeout(resolve, 400));
    report = await inspect(window);
  }

  // 等对话框的入场动画走完再量几何。动画期间 getBoundingClientRect() 会把
  // translateY 算进去，于是「偏了 6px」量到的其实是动画的起始帧、不是布局问题 ——
  // 拿这个去断言居中，就会得到一个只在慢机器上出现的假失败。
  //
  // 判据是 transform 落定，而不是 getAnimations() 报 finished：元素刚插入的那一瞬
  // 动画还没被登记，getAnimations() 返回空数组，而 every() 对空数组恒为 true ——
  // 「等动画结束」会在动画开始之前就返回。这个坑在调试里真的踩到了（一次 0px 通过、
  // 一次 6px 失败，差别只在插入与首次轮询的先后）。
  const settleDialog = async () => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const settled = await window.webContents.executeJavaScript(
        `(() => {
          const dialog = document.querySelector(".modal-dialog");
          if (!dialog) return false;
          const transform = getComputedStyle(dialog).transform;
          if (transform === "none") return true;
          // matrix(a, b, c, d, tx, ty) —— 末位就是 translateY。
          const match = transform.match(/matrix\\(.*,\\s*([-\\d.]+)\\)$/);
          return match ? Math.abs(parseFloat(match[1])) < 0.5 : false;
        })()`,
      );
      if (settled) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  // 「检查更新」的结论场景：走真实的菜单链路（菜单 → runAction → store.checkUpdate
  // → IPC），桩返回「有新版本」，于是结论变成「发现新版本 26.902.100.0」。
  //
  // 这里同时也是「自动检查不弹模态」的对照面：启动那次检查跑完时页面上**没有**对话框
  // （断言在下面那个分支里），而手动点这一次必须弹。两条放在一起才说明差别是「谁触发的」
  // 而不是「弹框坏了」。
  let noticeAfterClose = null;
  if (noticeOpen) {
    window.webContents.send("desktop:menu-action", "check");
    await new Promise((resolve) => setTimeout(resolve, 400));
    await settleDialog();
    report = await inspect(window);

    // 光弹出来不算完：关不掉就成了挡路的浮层。点确认按钮，量它是不是真的消失了。
    await window.webContents.executeJavaScript(
      `(() => {
        const button = document.querySelector(".modal-dialog button");
        if (button) button.click();
        return true;
      })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    noticeAfterClose = await inspect(window);
    // 关掉之后把对话框再叫回来，好让截图里留下它的样子。
    window.webContents.send("desktop:menu-action", "check");
    await new Promise((resolve) => setTimeout(resolve, 400));
    await settleDialog();
    report = await inspect(window);
  }

  // 「命令跑着的时候点不动」场景。步骤与要证明的事一一对应：
  //   1. **启动时那次自动检查**被桩挂住 —— 用户什么都没点，界面已经处于「命令跑着」；
  //   2. 再发四次菜单动作 → 若闸门有效，IPC 不该增加（连点不叠加）；
  //   3. 量界面：主按钮、次按钮、诊断按钮、五个命令菜单项都必须 disabled，
  //      而「打开日志目录 / 打开缓存目录」必须仍然可点（它们秒回，且正是跑着时最有用的）；
  //   4. 放行 → 界面必须重新可点（标志位漏清就是永久锁死，用户只能重启应用）。
  //
  // 第 1 步以前是「先发一次检查」：那时启动不查更新，界面上没有任何命令在跑。现在启动
  // 自己就会发起一次检查，所以那条命令**就是**自动检查。这一步不是换个写法而已 ——
  // 如果照旧先发一次再连点，计数仍然是 1，但证明的已经变成「用户点出来的那次的闸门」，
  // 自动检查那次的闸门没人验，属于假绿。
  let busyReport = null;
  let idleReport = null;
  if (checkingHold) {
    // 等界面进入「忙」。轮询而不是固定 sleep：慢机器上固定等待会把「还没开始」量成
    // 「没有置灰」，又快机器上白等。判据是主按钮 disabled —— 那是 busy 的直接投影。
    const busyDeadline = Date.now() + 5000;
    let busy = false;
    while (Date.now() < busyDeadline) {
      busy = await window.webContents.executeJavaScript(
        `(() => { const b = document.querySelector(".cta-row .button.primary"); return !!(b && b.disabled); })()`,
      );
      if (busy) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // 启动就应该在查：这条断言正是「自动检查会置忙」的证据，也是本次改动的回归点。
    if (!busy) problems.push("启动自动检查没有让界面进入「命令跑着」态（主按钮仍然可点）");
    // 记下连点之前的基线，后面按增量断言。用绝对值 1 会把「自动检查压根没发生」
    // 也算成通过 —— 而那种情况下这一整段什么都没证明。
    const beforeFlood = commandCalls.check_update || 0;

    // 连点四次：菜单动作（runAction）是渲染进程里所有入口的汇合点，这里走的就是真实链路。
    for (let attempt = 0; attempt < 4; attempt++) {
      window.webContents.send("desktop:menu-action", "check");
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    report = await inspect(window);
    busyReport = await readBusyState(window);
    busyReport.checkUpdateCalls = commandCalls.check_update || 0;
    busyReport.callsBeforeFlood = beforeFlood;
    busyReport.ctaLabel = report.ctaLabel;
    busyReport.phase = report.phase;

    releaseUpdate();
    await new Promise((resolve) => setTimeout(resolve, 300));
    idleReport = await readBusyState(window);
    // 放行之后再点一次：此时应当又跑得动（再挂一次，顺便给截图留下「跑着」的样子）。
    window.webContents.send("desktop:menu-action", "check");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // 「版本历史 / 回退」场景：点一次真实的回退按钮，观察命令跑着与跑完两个状态。
  let rollbackBusy = null;
  let rollbackAfter = null;
  if (rollbackScenario) {
    // 版本历史是独立视图：先导航过去，再点那一行的回退按钮。
    const clicked = await window.webContents.executeJavaScript(`(async () => {
      const nav = document.querySelector('.nav-item[data-nav="history"]');
      if (nav) nav.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const button = document.querySelector(".rollback-row.older .rollback-action");
      if (button) button.click();
      return !!button;
    })()`);
    if (!clicked) problems.push("版本历史里找不到可回退那一行的按钮，回退流程无从触发");
    await new Promise((resolve) => setTimeout(resolve, 400));
    rollbackBusy = await inspect(window);
    releaseInstall();
    await new Promise((resolve) => setTimeout(resolve, 500));
    rollbackAfter = await inspect(window);
  }

  // 顶栏必须固定：它承载窗口按钮，滚动能被内容顶走的话，滚到底部就关不掉窗口了。
  // 直接把内容区滚到底，再量窗口按钮是否仍在视口内 —— 这条断言正是那个 bug 的复现。
  const stickyTitleBar = await window.webContents.executeJavaScript(`(() => {
    const scroll = document.querySelector(".app-scroll");
    const controls = document.querySelector(".window-controls");
    if (!scroll || !controls) return null;
    scroll.scrollTop = scroll.scrollHeight;
    const rect = controls.getBoundingClientRect();
    const bar = document.querySelector(".topbar")?.getBoundingClientRect();
    const measured = {
      scrolled: Math.round(scroll.scrollTop),
      visible: rect.top >= -1 && rect.bottom <= window.innerHeight + 1 && rect.width > 0,
      barTop: bar ? Math.round(bar.top) : null,
      controlsTop: Math.round(rect.top),
    };
    // 量完滚回顶部：断言已经拿到，留着滚到底的视口只会让截图丢掉页面上半部分
    // （结论卡片、主操作按钮都在上面），看不出界面到底长什么样。
    scroll.scrollTop = 0;
    return measured;
  })()`);

  // 侧栏导航：逐页点进去，确认每一页真的渲染出来，同时量导航项本身有没有
  // 被裁切或被内容盖住。用 elementFromPoint 而不是只看 getBoundingClientRect ——
  // 坐标可以完全正确，同时被上面一层盖住，「量得到、点不到」只有命中测试能发现。
  let navReport = null;
  if (menuOpen) {
    const run = (script) => window.webContents.executeJavaScript(script);
    const navIds = ["overview", "diagnostics", "history", "settings"];
    const pages = [];
    for (const id of navIds) {
      await run(
        `(() => { const item = document.querySelector('.nav-item[data-nav="${id}"]'); if (item) item.click(); return !!item; })()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 320));
      pages.push(
        await run(`(() => {
          const page = document.querySelector(".page");
          const heading =
            document.querySelector(".page-head h1")?.textContent.trim() ??
            document.querySelector(".hero-card h1")?.textContent.trim() ??
            "";
          return { id: ${JSON.stringify(id)}, heading, hasPage: !!page };
        })()`),
      );
    }
    // 桌面端滚动：切页要回顶部；PageUp/PageDown/Home/End 要能滚内容区。
    // 在「设置 → 存储」上量 —— 四个标签里它内容最长，默认的「通用」一屏就放得下，
    // 拿它量滚动会得到 max=0，下面的滚动断言就成了恒真的空断言。
    const clickNav = (id) =>
      run(`(() => { const item = document.querySelector('.nav-item[data-nav="${id}"]'); if (item) item.click(); return !!item; })()`);
    const clickSettingsStorage = () =>
      run(`(() => { const tab = document.getElementById("settings-tab-storage"); if (tab) tab.click(); return !!tab; })()`);
    await clickNav("settings");
    await new Promise((resolve) => setTimeout(resolve, 320));
    await clickSettingsStorage();
    await new Promise((resolve) => setTimeout(resolve, 220));
    const scrolledTo = await run(`(() => {
      const scroll = document.querySelector(".app-scroll");
      scroll.scrollTop = scroll.scrollHeight;
      return { top: Math.round(scroll.scrollTop), max: Math.round(scroll.scrollHeight - scroll.clientHeight) };
    })()`);
    await clickNav("overview");
    await new Promise((resolve) => setTimeout(resolve, 320));
    const resetTop = await run(`(() => Math.round(document.querySelector(".app-scroll").scrollTop))()`);
    await clickNav("settings");
    await new Promise((resolve) => setTimeout(resolve, 320));
    await clickSettingsStorage();
    await new Promise((resolve) => setTimeout(resolve, 220));
    const keyboardScroll = await run(`(() => {
      const scroll = document.querySelector(".app-scroll");
      scroll.scrollTop = 0;
      const press = (key) => window.dispatchEvent(new KeyboardEvent("keydown", { key }));
      press("PageDown");
      const afterPageDown = Math.round(scroll.scrollTop);
      press("End");
      const afterEnd = Math.round(scroll.scrollTop);
      press("Home");
      const afterHome = Math.round(scroll.scrollTop);
      return { afterPageDown, afterEnd, afterHome, max: Math.round(scroll.scrollHeight - scroll.clientHeight) };
    })()`);

    navReport = {
      pages,
      scroll: { scrolledTo, resetTop, keyboardScroll },
      items: await run(`(() => {
        return [...document.querySelectorAll(".nav-item")].map((item) => {
          const rect = item.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return {
            id: item.dataset.nav || "",
            label: item.querySelector("span:not(.nav-badge)")?.textContent.trim() ?? item.textContent.trim(),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            zeroSize: rect.width === 0 || rect.height === 0,
            covered: !(hit && (hit === item || item.contains(hit))),
            hitTag: hit ? (hit.className || hit.tagName) : "(空)",
          };
        });
      })()`),
    };
    await run(
      `(() => { const item = document.querySelector('.nav-item[data-nav="overview"]'); if (item) item.click(); return true; })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // 「设置 → 目录与诊断 → 复制诊断信息」走一遍完整链路，再从主进程读回剪贴板。
  //
  // 这条链路横跨渲染进程与主进程（按钮 → store 拼文本 → IPC → 剪贴板），
  // 只看源码文本证明不了它真的通 —— 少接一根线的话，界面会弹一句「已复制」而剪贴板
  // 里什么都没有，正是那种「看起来成功了」的坏法。
  let diagnosticsCopied = "";
  if (menuOpen) {
    clipboard.writeText("");
    await window.webContents.executeJavaScript(
      `(() => { const item = document.querySelector('.nav-item[data-nav="settings"]'); if (item) item.click(); return !!item; })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    // 「复制诊断信息」在设置 → 存储 → 目录与诊断 里。
    await window.webContents.executeJavaScript(
      `(() => { const el = document.getElementById("settings-tab-storage"); if (el) el.click(); return !!el; })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 220));
    await window.webContents.executeJavaScript(`(() => {
      const item = [...document.querySelectorAll(".settings-links button")].find((button) =>
        button.textContent.includes("复制诊断信息"),
      );
      if (item) item.click();
      return !!item;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    diagnosticsCopied = clipboard.readText();
    // 复制成功会弹一句回执（剪贴板是看不见的，不给回执用户会以为没点着）。收掉它，
    // 否则后面每一处「页面上没有对话框」的断言都会因为这一次点击而失效。
    await window.webContents.executeJavaScript(`(() => {
      const button = document.querySelector(".modal-actions button");
      if (button) button.click();
      return !!button;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await window.webContents.executeJavaScript(
      `(() => { const item = document.querySelector('.nav-item[data-nav="overview"]'); if (item) item.click(); return true; })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const problems = [];
  if (autoCheckProblem) problems.push(autoCheckProblem);

  // 存储场景：主题即时切换 + 缓存迁移确认 + 应用本体迁移检测。
  //
  // 三条都走真实组件与 store，只是主进程换成桩。最要紧的断言是「确认之前不动」：
  // 预检返回之后，migrate_cache 的调用次数必须仍然是 0。
  let storageReport = null;
  if (storageScenario) {
    const run = (script) => window.webContents.executeJavaScript(script);
    const clickTab = async (tab) => {
      await run(`(() => { const el = document.getElementById("settings-tab-${tab}"); if (el) el.click(); return !!el; })()`);
      await new Promise((resolve) => setTimeout(resolve, 240));
    };
    const clickButton = (label, scope = "document") =>
      run(`(() => {
        const root = ${scope === "document" ? "document" : `document.querySelector(${JSON.stringify(scope)})`};
        if (!root) return false;
        const button = [...root.querySelectorAll("button")].find((node) => node.textContent.trim().includes(${JSON.stringify(label)}));
        if (button) button.click();
        return !!button;
      })()`);
    const openSettings = async () => {
      await run(`(() => { const item = document.querySelector('.nav-item[data-nav="settings"]'); if (item) item.click(); return !!item; })()`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    };

    await openSettings();

    // 1) 主题：三档即时切换，根节点 data-theme 必须真的跟着变。
    await clickTab("appearance");
    // 必须按 id 点：第一张卡片的说明文字里也写着「切深色时一起变」，
    // 按文本包含去找会点到「跟随系统」—— 那样量到的永远是初始态，断言会假绿。
    const clickedDark = await run(`(() => { const el = document.getElementById("theme-option-dark"); if (el) el.click(); return !!el; })()`);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const darkTheme = await run(
      `(() => ({ theme: document.documentElement.dataset.theme, preference: document.documentElement.dataset.themePreference }))()`,
    );
    await run(`(() => { const el = document.getElementById("theme-option-light"); if (el) el.click(); return !!el; })()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const lightTheme = await run(
      `(() => ({ theme: document.documentElement.dataset.theme, preference: document.documentElement.dataset.themePreference }))()`,
    );
    await run(`(() => { const el = document.getElementById("theme-option-system"); if (el) el.click(); return !!el; })()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const systemTheme = await run(
      `(() => ({ theme: document.documentElement.dataset.theme, preference: document.documentElement.dataset.themePreference }))()`,
    );
    if (darkTheme.theme !== "dark" || darkTheme.preference !== "dark") {
      problems.push(`选「深色」后根节点没有切到深色：theme=${darkTheme.theme} preference=${darkTheme.preference}`);
    }
    if (lightTheme.theme !== "light" || lightTheme.preference !== "light") {
      problems.push(`选「浅色」后根节点没有切到浅色：theme=${lightTheme.theme} preference=${lightTheme.preference}`);
    }
    if (systemTheme.preference !== "system" || (systemTheme.theme !== "dark" && systemTheme.theme !== "light")) {
      problems.push(`选「跟随系统」后偏好没有回到 system：${JSON.stringify(systemTheme)}`);
    }

    // 2) 缓存换目录：选一个普通文件夹 → 直接使用所选路径 →
    //    确认块（默认勾选「一起搬旧安装包」）→ 先取消，确认什么也没改；
    //    再选一次、取消勾选 → 「只切换目录」真的只写设置，migrate_cache 一次都不发。
    await clickTab("storage");
    const clickedChange = await clickButton("更改位置");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const confirm = await run(`(() => {
      const block = document.querySelector(".confirm-block");
      if (!block) return null;
      const check = block.querySelector(".confirm-check input[type=checkbox]");
      return {
        title: block.querySelector("strong")?.textContent.trim() ?? "",
        text: block.textContent.trim(),
        groupLabel: block.getAttribute("aria-label"),
        focusedLabel: document.activeElement?.textContent?.trim() ?? "",
        focusInside: block.contains(document.activeElement),
        buttons: [...block.querySelectorAll("button")].map((button) => button.textContent.trim()),
        carryChecked: check ? check.checked : null,
      };
    })()`);
    const migrateCallsAfterPrecheck = commandCalls.migrate_cache || 0;

    if (!clickedChange) problems.push("存储页找不到「更改位置」按钮");
    if (!confirm) {
      problems.push("点了「更改位置」之后没有出现确认块");
    } else {
      // 目标必须完全等于所选文件夹，不能偷偷拼接后缀。
      if (confirm.title !== `缓存目录改为 ${MIGRATION_TARGET}`) {
        problems.push(`确认块没有说清缓存会落在哪里：${confirm.title}`);
      }
      if (confirm.groupLabel !== "确认迁移缓存") problems.push(`确认块缺少无障碍分组名：${confirm.groupLabel}`);
      // 迁移会搬几 GB 文件，回车键不该直接开始。
      if (!confirm.focusInside || confirm.focusedLabel !== "取消") {
        problems.push(`确认块出现后焦点应落在「取消」上，实际：${confirm.focusedLabel || "(没有焦点)"}`);
      }
      if (confirm.carryChecked !== true) problems.push("确认块里「一起搬旧安装包」默认应当是勾选的");
      if (!confirm.buttons.includes("迁移并切换")) problems.push(`确认块缺少「迁移并切换」：${confirm.buttons.join(" / ")}`);
    }
    if (migrateCallsAfterPrecheck !== 0) {
      problems.push(`确认之前就发出了 ${migrateCallsAfterPrecheck} 次 migrate_cache —— 预检结果被当成授权了`);
    }
    if (screenshotDir && confirm) {
      // 迁移确认块是这次改版最需要人工核对的一屏，单独留一张。确认块在折叠线以下，
      // 先按内容高度把窗口撑开再抓图 —— 否则截到的是半截，按钮还压在视口外。
      mkdirSync(screenshotDir, { recursive: true });
      const fullHeight = await run(`(() => {
        const scroll = document.querySelector(".app-scroll");
        const bar = document.querySelector(".topbar");
        const barHeight = bar ? bar.getBoundingClientRect().height : 0;
        const content = scroll ? scroll.scrollHeight : document.documentElement.scrollHeight;
        return Math.min(Math.round(barHeight + content + 20), 2400);
      })()`);
      window.setContentSize(windowWidth, Math.max(780, Math.round(fullHeight)));
      await new Promise((resolve) => setTimeout(resolve, 400));
      const image = await window.webContents.capturePage();
      writeFileSync(join(screenshotDir, "storage-migration-confirm.png"), image.toPNG());
      console.log(`  截图：${join(screenshotDir, "storage-migration-confirm.png")}`);
    }
    await clickButton("取消", ".confirm-block");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const confirmGone = await run(`(() => !document.querySelector(".confirm-block"))()`);
    if (!confirmGone) problems.push("点「取消」之后确认块没有消失");
    if ((commandCalls.migrate_cache || 0) !== 0) problems.push("取消之后仍然发出了 migrate_cache");
    if (String(commandArgs.save_settings?.downloadDirectory ?? "") === MIGRATION_TARGET) {
      problems.push("确认块阶段就把缓存目录切到了目标目录");
    }

    // 2b) 不搬旧安装包：取消勾选后主按钮变成「只切换目录」。
    await clickButton("更改位置");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const unchecked = await run(`(() => {
      const box = document.querySelector(".confirm-block .confirm-check input[type=checkbox]");
      if (!box) return null;
      box.click();
      return {
        checked: box.checked,
        button: document.querySelector(".confirm-block .button.primary")?.textContent.trim() ?? "",
      };
    })()`);
    if (!unchecked || unchecked.checked !== false) {
      problems.push("确认块里取消勾选「一起搬旧安装包」没有生效");
    } else if (unchecked.button !== "只切换目录") {
      problems.push(`取消勾选后主按钮应变成「只切换目录」，实际：${unchecked.button || "(没有按钮)"}`);
    }
    await clickButton("只切换目录", ".confirm-block");
    await new Promise((resolve) => setTimeout(resolve, 700));
    const switched = await run(`(() => ({
      confirmGone: !document.querySelector(".confirm-block"),
      input: document.getElementById("download-directory")?.value ?? "",
    }))()`);
    if (String(commandArgs.save_settings?.downloadDirectory ?? "") !== MIGRATION_TARGET) {
      problems.push(
        `「只切换目录」没有把缓存目录写到 ${MIGRATION_TARGET}：${
          String(commandArgs.save_settings?.downloadDirectory ?? "") || "(未写入)"
        }`,
      );
    }
    if ((commandCalls.migrate_cache || 0) !== 0) {
      problems.push("「只切换目录」不该发出 migrate_cache —— 用户没同意搬文件");
    }
    if (!switched.confirmGone) problems.push("切换目录之后确认块没有收起");
    if (switched.input !== MIGRATION_TARGET) {
      problems.push(`切换目录后输入框没有显示新目录：${switched.input || "(空)"}`);
    }

    // 2c) 空缓存也必须先确认；取消原生文件夹选择不能改目录。
    await run(`document.querySelector(".modal-dialog button")?.click()`);
    cachePickerPath = "E:\\团队工具\\空缓存";
    emptyMigration = true;
    await clickButton("更改位置");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const emptyConfirm = await run(`(() => ({
      title: document.querySelector('.confirm-block strong')?.textContent,
      button: document.querySelector('.confirm-block .button.primary')?.textContent.trim(),
      checkbox: !!document.querySelector('.confirm-check'),
    }))()`);
    if (emptyConfirm.title !== `缓存目录改为 ${cachePickerPath}` || emptyConfirm.button !== "只切换目录" || emptyConfirm.checkbox) {
      problems.push(`空缓存确认状态不正确：${JSON.stringify(emptyConfirm)}`);
    }
    if (commandArgs.save_settings?.downloadDirectory !== MIGRATION_TARGET) problems.push("空缓存未经确认就切换目录");
    await clickButton("只切换目录", ".confirm-block");
    await new Promise((resolve) => setTimeout(resolve, 450));
    if (commandArgs.save_settings?.downloadDirectory !== cachePickerPath) problems.push("空缓存确认后未保存所选文件夹");
    if ((commandCalls.migrate_cache || 0) !== 0) problems.push("空缓存不应该发起文件迁移");
    await run(`document.querySelector(".modal-dialog button")?.click()`);
    cancelCachePick = true;
    const savesBeforeCancel = commandCalls.save_settings || 0;
    await clickButton("更改位置");
    await new Promise((resolve) => setTimeout(resolve, 300));
    if ((commandCalls.save_settings || 0) !== savesBeforeCancel) problems.push("取消选目录后仍保存了设置");
    if (await run(`!!document.querySelector('.confirm-block')`)) problems.push("取消选目录后不应出现迁移确认");

    // 3) 应用本体：只读检测 → 选择文件夹 → 执行。桩回「已取消」，界面必须是提示而非错误。
    const stateBeforeDetect = await run(
      `(() => document.querySelector(".detect-state")?.textContent.trim() ?? "")()`,
    );
    if (stateBeforeDetect !== "尚未检测") {
      problems.push(`检测之前的状态行应当是「尚未检测」，实际：${stateBeforeDetect || "(没有状态行)"}`);
    }
    const clickedDetect = await clickButton("检测迁移条件");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const capability = await run(`(() => {
      const block = document.querySelector(".capability-block");
      const picker = document.getElementById("pick-app-directory");
      return {
        present: !!block,
        text: block?.textContent.trim() ?? "",
        state: document.querySelector(".detect-state")?.textContent.trim() ?? "",
        hasPicker: !!picker,
        hasMoveButton: [...document.querySelectorAll("button")].some((button) =>
          button.textContent.includes("确认迁移应用"),
        ),
      };
    })()`);
    if (!clickedDetect) problems.push("应用本体卡片找不到「检测迁移条件」按钮");
    if (!capability.present) problems.push("检测之后没有显示迁移能力结论");
    if (!capability.text.includes("可以尝试迁移")) {
      problems.push(`检测结论不对：${capability.text.slice(0, 80)}`);
    }
    if (!capability.state.includes("检测完成")) {
      problems.push(`检测之后状态行没有更新：${capability.state || "(没有状态行)"}`);
    }
    if (!capability.hasPicker) problems.push("检测后没有出现目标文件夹选择入口");
    if (!capability.hasMoveButton) problems.push("检测通过后没有出现「确认迁移应用」按钮");

    // 通过目录选择器指定目标，同时展示系统真实应用存储位置。
    await clickButton("选择目标文件夹");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const selectedVolume = await run(`(() => {
      return {
        folder: document.getElementById("app-selected-directory")?.textContent,
        volume: document.getElementById("app-target-volume")?.textContent,
      };
    })()`);
    if (selectedVolume.volume !== "F:\\WindowsApps" || selectedVolume.folder !== "F:\\团队工具\\Codex") {
      problems.push(`文件夹与实际安装位置展示不正确：${JSON.stringify(selectedVolume)}`);
    }
    if ((commandCalls.move_codex_app || 0) !== 0) problems.push("选择文件夹后未经确认就迁移了应用");

    await clickButton("确认迁移应用");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const moveCalls = commandCalls.move_codex_app || 0;
    const moveVolume = String(commandArgs.move_codex_app?.volume ?? "");
    const moveState = await run(`(() => ({
      dialog: document.querySelector(".modal-dialog")?.textContent.trim() ?? "",
      error: document.querySelector(".error-text:not(.soft)")?.textContent.trim() ?? "",
    }))()`);
    if (moveCalls !== 1) problems.push(`「确认迁移应用」应发出 1 次 move_codex_app，实际 ${moveCalls} 次`);
    if (moveVolume !== "F:\\WindowsApps") problems.push(`迁移目标卷没有按所选值传下去：${moveVolume || "(空)"}`);
    if (commandArgs.move_codex_app?.selectedDirectory !== "F:\\团队工具\\Codex") {
      problems.push("执行迁移未传递所选文件夹，主进程无法重新验证映射");
    }
    if (!moveState.dialog.includes("已取消迁移")) {
      problems.push(`取消迁移后应给出提示对话框，实际：${moveState.dialog || "(没有对话框)"}`);
    }
    if (moveState.error) problems.push(`取消迁移被当成了错误：${moveState.error}`);
    // 关掉提示，让最后的截图停在存储页本身。
    await run(`(() => { const button = document.querySelector(".modal-dialog button"); if (button) button.click(); return true; })()`);
    await new Promise((resolve) => setTimeout(resolve, 250));

    storageReport = { darkTheme, lightTheme, systemTheme, confirm, migrateCallsAfterPrecheck, capability, moveCalls, moveVolume };
    console.log(
      `  存储场景：主题 dark=${darkTheme.theme}/light=${lightTheme.theme}/system=${systemTheme.preference}；` +
        `预检后 migrate_cache=${migrateCallsAfterPrecheck} 次；move_codex_app=${moveCalls} 次（${moveVolume}）`,
    );
  }


  // 设置卡片一张都没展开时，下面那些路径行/安装位置的测量全是空值，会一路「通过」——
  // 那种绿是假的：什么都没量到，当然挑不出毛病。
  if (!openedSettingsCount) {
    problems.push("没有找到任何设置卡片：路径行与安装位置的测量全部落空");
  }
  if (failedLoads.length > 0) problems.push(`资源加载失败：\n    ${failedLoads.join("\n    ")}`);
  if (packaged) {
    const missingScripts = PACKAGED_SCRIPTS.filter((name) => !existsSync(join(packagedScriptsDir, name)));
    if (missingScripts.length > 0) {
      problems.push(
        `extraResources 未把脚本放到 asar 之外（${packagedScriptsDir}），缺失：${missingScripts.join(", ")}`,
      );
    }
  }
  if (report.phase === "checking") problems.push("界面一直停在 checking 态，IPC 未返回");
  if (report.phase === "failed") problems.push(`界面进入 failed 态：${report.errorText}`);
  if (report.rootChildren <= 0) problems.push("#root 没有渲染出任何节点（白屏）");
  if (!report.hasAppShell) problems.push("缺少 .app-shell，React 应用未挂载");
  if (report.styleSheetCount < 1) problems.push("样式表未加载");
  if (report.errorText) problems.push(`界面显示了错误：${report.errorText}`);
  if (!report.heading) problems.push("主区没有渲染出标题");
  if (!report.ctaLabel) problems.push("没有渲染出主操作按钮");

  // 自更新场景：检查 → 下载两步必须真的把界面从「已是最新」推到「可以安装」。
  if (appUpdateScenario) {
    if (!appUpdateReport) {
      problems.push("没有采集到「关于」里的自更新状态");
    } else {
      const { initial, checked, downloaded } = appUpdateReport;
      if (!initial) {
        problems.push("设置页「关于」里没有自更新卡片（.about-update）");
      } else {
        if (!initial.version.startsWith("v")) {
          problems.push(`「关于」没有显示版本号：${initial.version || "(空)"}`);
        }
        if (!initial.buttons.some((button) => button.label.includes("检查更新"))) {
          problems.push(`「关于」没有「检查更新」按钮：${initial.buttons.map((b) => b.label).join(", ")}`);
        }
        if (initial.status.includes("发现新版本")) {
          problems.push("还没点检查就出现了新版本，状态是猜出来的");
        }
        if (initial.badge !== "尚未检查") {
          problems.push(`还没检查时徽章应是「尚未检查」，实际是「${initial.badge || "(空)"}」`);
        }

        // 点完检查：桩里的 desktop-v0.6.0 必须被认出来，按钮换成「下载并安装」。
        if (!checked?.status.includes("发现新版本 v0.6.0")) {
          problems.push(`点「检查更新」后没有显示新版本：${checked?.status || "(空)"}`);
        }
        if (!checked?.badge.includes("v0.6.0")) {
          problems.push(`发现新版本后徽章没有跟上版本号：${checked?.badge || "(空)"}`);
        }
        if (!checked?.buttons.some((button) => button.label.includes("下载并安装"))) {
          problems.push(`发现新版本后按钮不是「下载并安装」：${checked?.buttons.map((b) => b.label).join(", ")}`);
        }

        // 点完下载：路径落到 store 之后，状态换成「已下载…可以安装」。
        if (!downloaded?.status.includes("已下载")) {
          problems.push(`点「下载并安装」后没有进入可安装态：${downloaded?.status || "(空)"}`);
        }
        if (!downloaded?.buttons.some((button) => button.label.includes("安装并重启"))) {
          problems.push(`下载完成后按钮不是「安装并重启」：${downloaded?.buttons.map((b) => b.label).join(", ")}`);
        }
        if (downloaded?.badge !== "待安装") {
          problems.push(`下载完成后徽章应是「待安装」，实际是「${downloaded?.badge || "(空)"}」`);
        }
        if (downloaded?.status.includes("v0.6.0") === false) {
          problems.push(`下载完成后的状态没带上版本号：${downloaded?.status || "(空)"}`);
        }
      }
    }

    // 公告两个来源合并：远端 0.6.0 在前，CHANGELOG 历史在后，
    // 且每个版本只出现一次（本地与远端同 tag 时以本地为准）。
    if (!bellReport) {
      problems.push("顶栏公告铃铛点开后没有面板");
    } else if (bellReport.empty) {
      problems.push("公告时间线是空的：CHANGELOG 历史没有进来");
    } else {
      const titles = bellReport.entries.map((entry) => entry.title);
      for (const version of ["v0.6.0", "v0.5.0", "v0.4.0", "v0.3.0", "v0.2.0", "v0.1.0"]) {
        if (!titles.includes(version)) problems.push(`公告里缺少 ${version}：${titles.join(" / ")}`);
      }
      const duplicates = titles.filter((title, index) => titles.indexOf(title) !== index);
      if (duplicates.length > 0) problems.push(`公告里有重复条目：${duplicates.join(", ")}`);
      if (titles[0] !== "v0.6.0") {
        problems.push(`公告应按发布时间倒序，第一条却是：${titles[0]}`);
      }
      // 正文必须是剥好的纯文本：Markdown 标记铺到界面上就是一排 `##` 和 `-`。
      const dirty = bellReport.entries.filter((entry) => /(^|\s)#{1,6}\s|`/.test(entry.body));
      if (dirty.length > 0) problems.push(`公告正文没有剥掉 Markdown 标记：${dirty[0].body}`);
      // 公告讲的是「这次改了什么」，不出现发布平台的术语（Release / GitHub），也不放外链。
      if (bellReport.hasReleaseWording) problems.push("公告面板里出现了 Release 字样");
      if (bellReport.entries.some((entry) => !entry.body)) problems.push("公告条目没有正文");
    }
  }
  // --checking 场景的主按钮本来就该是灰的（命令正在跑），这里按「就绪即可点」断言会误报。
  if (!checkingHold && report.ctaDisabled !== false) problems.push("主操作按钮在就绪状态下应当可点击");

  // 高级设置的路径行：输入框 width:100% + flex 默认 min-width:auto 会把「更改位置…」
  // 挤到裁切或溢出容器。这两条断言把那个布局 bug 钉住。
  const pathButtons = report.pathRowButtons;
  if (!pathButtons || pathButtons.length === 0) {
    problems.push("高级设置里没有渲染出路径行按钮");
  } else {
    for (const button of pathButtons) {
      if (button.lineBoxes > 1) {
        problems.push(`路径行按钮文字折行（被挤压到放不下）：${button.label}（宽 ${button.width}px，${button.lineBoxes} 行）`);
      } else if (button.clipped) {
        problems.push(`路径行按钮文字被裁切：${button.label}（宽 ${button.width}px）`);
      }
      if (button.overflowsRow) problems.push(`路径行按钮溢出容器：${button.label}`);
      if (button.height < 36) problems.push(`路径行按钮高度过小：${button.label}（${button.height}px）`);
    }
    const browse = pathButtons.find((button) => button.label.includes("更改位置"));
    if (!browse) problems.push(`路径行缺少「更改位置」按钮：${pathButtons.map((b) => b.label).join(", ")}`);
  }

  // 「Codex 安装位置」必须原样显示包自己报的路径。桩数据用的是 **D 盘** 路径，
  // 所以任何「按系统盘拼一遍」的做法都会在这里露出来 —— 用户完全可能把应用装在
  // 别的盘，显示错了比不显示更糟：他会以为 C 盘被占了而去删不该删的东西。
  // 未安装时没有包可报，必须给一句人话，而不是空白输入框或 "null"。
  if (notInstalled) {
    if (report.installLocationField !== "尚未检测到已安装的 Codex") {
      problems.push(`未安装时安装位置占位文案不正确：${report.installLocationField}`);
    }
  } else if (report.installLocationField !== "D:\\WindowsApps\\OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0") {
    problems.push(`安装位置没有原样显示包报的路径：${report.installLocationField}`);
  }

  // 窗口控制按钮：既是美观问题也是可点区域问题。14px 的圆点远小于可用的点击目标。
  if (report.windowControls.length !== 3) {
    problems.push(`窗口控制按钮应为 3 个，实际 ${report.windowControls.length} 个`);
  }
  for (const control of report.windowControls) {
    if (control.width < 32 || control.height < 28) {
      problems.push(`窗口控制按钮可点区域过小：${control.label}（${control.width}×${control.height}）`);
    }
  }

  // 顶栏固定性：内容区滚到底后，窗口按钮仍必须留在视口内。
  if (!stickyTitleBar) {
    problems.push("找不到 .app-scroll 或 .window-controls，无法校验顶栏固定性");
  } else if (!stickyTitleBar.visible) {
    problems.push(
      `顶栏随内容滚走了：内容区滚到 ${stickyTitleBar.scrolled}px 后，窗口按钮顶部到了 ${stickyTitleBar.controlsTop}px`,
    );
  }

  // 侧栏导航必须真的能看到、点到，且每一页都渲染得出来：应用没有菜单栏，
  // 侧栏是四个页面唯一的可见入口；窄窗口下把它藏起来，等于用户拖小窗口之后
  // 再也去不了诊断与设置。
  if (menuOpen) {
    if (!navReport) {
      problems.push("导航探测没有返回结果");
    } else {
      const expectedNav = [
        ["overview", "概览"],
        ["diagnostics", "诊断"],
        ["history", "版本与缓存"],
        ["settings", "设置"],
      ];
      if (navReport.items.length !== expectedNav.length) {
        problems.push(`侧栏应有 ${expectedNav.length} 个入口，实际 ${navReport.items.length} 个`);
      }
      for (const [id, label] of expectedNav) {
        const item = navReport.items.find((entry) => entry.id === id);
        if (!item) {
          problems.push(`侧栏缺少「${label}」入口`);
          continue;
        }
        if (!item.label.includes(label)) problems.push(`侧栏「${label}」入口文案不正确：${item.label}`);
        if (item.zeroSize) problems.push(`侧栏入口没有参与布局（尺寸为 0）：${item.label}`);
        else if (item.covered) problems.push(`侧栏入口被盖住（点不到）：${item.label}，命中到 ${item.hitTag}`);

        const page = navReport.pages.find((entry) => entry.id === id);
        if (!page?.hasPage) problems.push(`导航到「${label}」后没有渲染出页面`);
        else if (!page.heading) problems.push(`「${label}」页没有渲染出标题`);
      }

      // 桌面端滚动契约。设置页必须真的能滚，否则后两条是恒真的空断言。
      const scroll = navReport.scroll;
      if (scroll.scrolledTo.max <= 0 || scroll.scrolledTo.top <= 0) {
        problems.push("设置页没有可滚动的内容，切页回顶与键盘滚动都无法验证");
      }
      if (scroll.resetTop !== 0) {
        problems.push(`切回概览后内容区没有回到顶部（scrollTop=${scroll.resetTop}）`);
      }
      if (scroll.keyboardScroll.afterPageDown <= 0) {
        problems.push("PageDown 没有滚动内容区");
      }
      if (scroll.keyboardScroll.afterEnd < scroll.keyboardScroll.max - 2) {
        problems.push(`End 没有滚到底（${scroll.keyboardScroll.afterEnd}/${scroll.keyboardScroll.max}）`);
      }
      if (scroll.keyboardScroll.afterHome !== 0) {
        problems.push(`Home 没有回到顶部（scrollTop=${scroll.keyboardScroll.afterHome}）`);
      }
    }

    // 复制出的文本必须能脱离界面单独读懂：报障的人只会粘这一段，没有截图。
    if (!diagnosticsCopied) {
      problems.push("「诊断 → 复制诊断信息」没有往剪贴板写任何东西");
    } else {
      for (const expected of ["Codex Updater 诊断信息", "已安装", "更新结论", "健康结论", "缓存目录"]) {
        if (!diagnosticsCopied.includes(expected)) {
          problems.push(`复制的诊断信息里缺少「${expected}」：\n${diagnosticsCopied}`);
        }
      }
      // 只写结论不写依据是最要命的：说「健康：degraded」而不说是哪个组件，对方还得再问一遍。
      if (!diagnosticsCopied.includes("WSL 命令行工具")) {
        problems.push(`诊断信息没有逐项列出资源副本状态：\n${diagnosticsCopied}`);
      }
    }
  }

  if (installing) {
    const download = downloadReport?.activity;
    if (!download) {
      problems.push("下载阶段没有渲染出活动面板");
    } else {
      // 下载总字节数无从得知（curl -sS / Invoke-WebRequest 都不给百分比），
      // 所以界面必须走不确定进度条，不能编造百分比。
      if (!download.indeterminate) problems.push("下载阶段应使用不确定进度条");
      if (download.percent !== "进行中") problems.push(`下载阶段不应显示百分比：${download.percent}`);
      if (!download.subline.includes("已下载")) problems.push(`下载阶段未显示已下载量：${download.subline}`);
    }

    const activity = report.activity;
    if (activity.percent !== "100%") problems.push(`安装完成后进度应为 100%：${activity.percent}`);
    if (activity.fillWidth !== "100%") problems.push(`进度条填充宽度应为 100%：${activity.fillWidth}`);
    if (activity.label !== "安装完成，Codex 已启动") problems.push(`安装完成后阶段文案不正确：${activity.label}`);
    if (activity.indeterminate) problems.push("安装阶段不应处于不确定态");
    if (!activity.warning.includes("安装包未删除")) problems.push(`软告警未显示：${activity.warning}`);
    if (!activity.logSummary.includes("2 行")) problems.push(`日志行数不正确：${activity.logSummary}`);
    if (!activity.logText.includes("Worker started for package")) problems.push("日志区缺少 worker 启动行");
    if (!activity.logText.includes("06:20:41")) problems.push("日志区缺少带时间戳的清理告警行");
  } else if (notInstalled) {
    // 这个 exe 的主用途：新机器上把 Codex 装起来。此时按钮就该是「一键安装 Codex」。
    if (!report.heading.includes("一键安装")) problems.push(`未安装时主区标题不正确：${report.heading}`);
    if (report.ctaLabel !== "一键安装 Codex") problems.push(`未安装时主操作按钮文案不正确：${report.ctaLabel}`);
    if (report.verdict !== "未安装") problems.push(`未安装时健康结论不正确：${report.verdict}`);
    if (report.healthRows !== 0) problems.push(`未安装时不应渲染资源组件行，实际 ${report.healthRows} 个`);
    if (!report.fieldHelp.includes("尚未检测到已安装")) problems.push("未安装时缺少说明文案");
    // 新机器上没有插件可物化，这条提示不该出现。
    if (report.fieldHelp.includes("插件资源尚未物化")) problems.push("未安装时不应提示插件未物化");
    // 没装就没有「是不是最新」可言，启动那次自动检查必须一个字节都不发 ——
    // 它是一次真实网络往返，不该在用户还没装任何东西的时候就跑起来。
    if ((commandCalls.check_update || 0) !== 0) {
      problems.push(`未安装时不该发起更新检查，check_update 实际发出 ${commandCalls.check_update} 次`);
    }
    if (report.instrument?.nodes?.[0]?.value !== "未安装") {
      problems.push(`未安装时版本状态仪表里的当前版本不正确：${report.instrument?.nodes?.[0]?.value}`);
    }
  } else {
    // 启动会自动查一次，所以界面**开机就知道**有没有新版本 —— 这正是本次改动本身。
    // 断言分两种形状：默认桩说「有 26.902.100.0 可更新」，--up-to-date 桩说「已是最新」。
    //
    // --checking 场景例外：它量的是「命令还跑着」那一刻，结论当然还没回来，顶栏与按钮
    // 仍是旧样子。那一条路由 busyReport 单独证明「启动确实发起了检查」，这里跳过 ——
    // 否则就是把「还没查完」当成「没查」。
    if (expectAutoCheck && upToDateScenario) {
      // 用户抱怨的原话就是这一条：以前启动只读版本，必须点一下「检查版本号」才知道已经在
      // 最新版上。现在什么都不点，界面就必须给出「已是最新」。
      const nodes = report.instrument?.nodes ?? [];
      if (nodes[0]?.value !== "26.901.6511.0") {
        problems.push(`版本状态仪表缺少已安装版本：${nodes[0]?.value}`);
      }
      if (nodes[1]?.value !== "已是最新") {
        problems.push(`已是最新时版本状态仪表没有说出来（用户仍要点一下才知道）：${nodes[1]?.value || "(空)"}`);
      }
      if (JSON.stringify(report.instrument ?? {}).includes("可更新到")) {
        problems.push(`已是最新时不该同时出现「可更新到」：${JSON.stringify(report.instrument)}`);
      }
      if (report.heading.includes("可更新到")) {
        problems.push(`已是最新时主区大字仍写着「可更新到」：${report.heading}`);
      }
      // 结论落到按钮上：既然是最新，主按钮就是「打开 Codex」，「仅检查更新」没有存在意义
      //（它只会重复一遍已经知道的结论，还多弹一个对话框）。
      if (report.ctaLabel !== "打开 Codex") problems.push(`已是最新时主操作按钮应为「打开 Codex」：${report.ctaLabel}`);
      if (report.ctaCount !== 1) {
        problems.push(`已是最新时主区应只剩 1 颗按钮（「仅检查更新」应隐去），实际 ${report.ctaCount} 颗`);
      }
      // 自动检查必须是静默的：用户什么都没点，页面上不该冒出任何对话框。
      // 看的是 startupReport（用户还没点过任何东西的那一刻）—— --notice 场景后面会
      // 手动点一次检查、故意弹出对话框，拿那时的 report 来断「没有对话框」就是张冠李戴。
      if (startupReport.notice?.present) {
        problems.push(`启动自动检查弹出了模态对话框：${startupReport.notice.message || startupReport.notice.heading}`);
      }
    } else if (expectAutoCheck) {
      // 默认桩说「有新版可更新」，所以启动后主按钮应当是「一键更新到 X」——
      // 这条同时是「自动检查真的跑了、结论真的到了界面」的端到端证据。
      if (report.ctaLabel !== "一键更新到 26.902.100.0") {
        problems.push(`启动自动检查的结论没有落到主按钮上：${report.ctaLabel}`);
      }
      // 结论的落点现在只有主区一处（顶栏状态胶囊已删）：大字说结论、仪表说「当前 → 分发源」。
      if (!report.heading.includes("可更新到 26.902.100.0")) {
        problems.push(`主区没有写出可更新到的版本（用户仍要点一下才知道）：${report.heading || "(空)"}`);
      }
      const nodes = report.instrument?.nodes ?? [];
      if (nodes[0]?.value !== "26.901.6511.0") {
        problems.push(`版本状态仪表里的当前版本不对：${nodes[0]?.value}`);
      }
      // 「上次检查 HH:MM」。结论已经出来了，就必须能说出它是什么时候问到的 ——
      // 一个没有时间戳的「可更新到 X」无法判断是不是上周的残留。
      if (!/上次检查 \d{2}:\d{2}/.test(report.lastCheck)) {
        problems.push(`主区没有写出「上次检查 HH:MM」：${report.lastCheck || "(空)"}`);
      }
      // 有新版可更新 ≠ 该弹对话框。用户什么都没点 —— 弹框是手动检查的表达方式。
      if (startupReport.notice?.present) {
        problems.push(`启动自动检查弹出了模态对话框：${startupReport.notice.message || startupReport.notice.heading}`);
      }
    }
    // 主区那行大字承载的是**更新结论**，不是「装没装」。用户原话：「第一次检测后显示的
    // 已安装 26.930.2377.0 启动所需资源完整 不太对吧，应该显示已是最新版：xxx」——
    // 它以前只写「已安装 X」+ 一句资源自检结论，最显眼的两行字里一个更新结论都没有。
    // 「装没装」由顶栏那行负责（上面已经逐字断过），这里要能一眼看出「要不要点那颗按钮」。
    if (upToDateScenario) {
      if (!report.heading.includes("已是最新版")) {
        problems.push(`已是最新时主区标题没有说出来：${report.heading}`);
      }
      // 版本号必须在标题里：只写「已是最新版」用户无从核对，而这行字本来就是他来核对的地方。
      if (!report.heading.includes("26.901.6511.0")) {
        problems.push(`已是最新时主区标题应带上版本号：${report.heading}`);
      }
    } else if (expectAutoCheck) {
      // 默认桩说「有 26.902.100.0 可更新」，标题就该写出可更新到哪一版。
      if (!report.heading.includes("可更新到 26.902.100.0")) {
        problems.push(`有新版时主区标题没有写出可更新到哪个版本：${report.heading}`);
      }
    } else if (!report.heading.includes("已安装")) {
      // --checking 场景：命令还跑着，结论当然还没回来，此时退回「已安装 X」才是诚实的
      // ——编一个「已是最新」比什么都不说更糟。
      problems.push(`结论未回来时主区标题未反映已安装状态：${report.heading}`);
    }
    // --checking 是唯一能看到「本机读完了、结论还在网络上飞」这个中间态的场景：它把每一次
    // check_update 都挂住了。用户原话：「读取本机的时候应该给一下更好的提示吧，不然不知道」
    // —— 这几秒里主区只写「已安装 X」，一个看起来已经定稿的答案，用户会以为查完了、只是没
    // 查到最新版。副标题必须自己声明还有一步在跑。
    if (checkingHold) {
      if (!report.lede.includes("正在向") || !report.lede.includes("查询最新版本")) {
        problems.push(`结论还在路上时主区没说自己还在查（用户无从知道它没查完）：${report.lede}`);
      }
    } else if (report.lede.includes("正在向")) {
      // 反过来：结论已经落地了还挂着「正在查询」，就是一句过期的谎话。
      problems.push(`结论已经回来了，主区还挂着「正在查询」：${report.lede}`);
    }
    if (report.healthRows !== 5) problems.push(`健康诊断应渲染 5 个组件行，实际 ${report.healthRows} 个`);
    // 夹具照抄真机形状，五项里 wsl-cli 是 missing，所以结论就该是「部分资源缺失」。
    // 这条只是把夹具本身钉住（脚本对任何非 ok 组件都判 degraded）——
    // 真正要证明的是下面那条：**同一个 degraded 不该弹出任何告警横幅**。
    //
    // 启动失败那两条场景例外：它们把组件覆盖成全 ok 了（见 launch_codex 桩），
    // 结论自然回到「资源完整」，而页面上那张卡片正是它们要断言的对象。
    const launchScenario = launchNoWindow || launchUnknown;
    if (!launchScenario && report.verdict !== "部分资源缺失") {
      problems.push(`健康结论不正确：${report.verdict}`);
    }

    // 本次修复的核心否定断言：组件不在 ≠ 启动会坏。
    //
    // 2026-10-02 用户那台机器就是这个形状（wsl-cli missing、OVERALL=degraded），
    // Codex 打开完全正常，界面上却常驻一张「Codex 可能无法正常打开窗口」的横幅。
    // 旧判据是 `state !== "ok"`，任何一项不在就算数；现在只认「有未完成的物化残留」。
    //
    // 用「页面上有没有告警卡」而不是「修复横幅读取器返回没返回 null」：后者在标题被
    // 改回旧文案时同样是 null，误报会从这条断言底下溜过去。
    // --health-partial 与启动失败那两条场景例外：它们的卡片断言在下面各自的一组里。
    if (!healthPartial && !launchScenario && report.warnCardHeadings.length > 0) {
      problems.push(
        `组件缺失不该弹出告警卡片（真机形状：wsl-cli 只是 missing、没有残留），实际渲染了：` +
          report.warnCardHeadings.join("、"),
      );
    }
  }

  // --health-partial：唯一该弹出资源修复横幅的形状（有 .staging/.repair 残留）。
  if (healthPartial) {
    const card = report.repairCard;
    if (!card) {
      problems.push("有未完成的物化残留（[PART ]）却没有给出资源修复横幅");
    } else {
      if (!card.heading.includes("资源副本")) problems.push(`资源修复横幅标题不正确：${card.heading}`);
      // 点名到具体组件：只说「有残留」用户不知道该看哪一项。名字走 healthComponentText，
      // 所以这里断言的必须是中文名而不是 wsl-cli 这个内部 id。
      // 连着后半句一起断言：JSX 会把源码里的换行折成一个空格，中文句子里就会冒出
      // 「WSL 命令行工具 的目标目录不存在」这种空档。只查组件名的话，那个空格
      // 正好卡在断言之外，谁也发现不了。
      if (!card.text.includes("WSL 命令行工具的目标目录不存在")) {
        problems.push(`资源修复横幅没有点名是哪个资源（或句子被 JSX 折行插了空格）：${card.text}`);
      }
      // 给下一步。卡片本身不放按钮（健康面板里那颗常驻），但必须指过去。
      if (!card.text.includes("修复资源副本")) problems.push(`资源修复横幅没有给出下一步：${card.text}`);
      // 措辞不得断言因果。组件状态预测不了窗口能不能开，两个方向都不行
      // （2026-09-07 的真实搬迁 bug 里 win-cli 反倒物化成功；2026-10-02 正常的机器上
      // wsl-cli 就是 missing）。这三句都是那次误诊的原文。
      for (const claim of ["可能无法正常打开", "无法正常启动", "主窗口没有出现"]) {
        if (card.text.includes(claim)) {
          problems.push(`资源修复横幅不该出现因果断言「${claim}」：${card.text}`);
        }
      }
    }
  }

  // 「打开 Codex」：结论必须可见、且下一步必须可点。这两个缺一个，用户看到的就是
  // 「点了没反应」—— 前一个项目 bug 正是两句都缺：只提示「已请求启动」，而进程在跑、
  // 窗口没出现的失败没有任何呈现。
  //
  // 但「下一步可点」不等于「永远给修复按钮」：只有判定为 relocation-bug 才给。
  // 判定不出来时给修复按钮，就是 2026-10-01 那次误诊的界面版本 —— 用户拿着一条
  // 没用的建议白跑一趟，所以那种情况必须没有按钮、并且如实说判不出来。
  if (launchNoWindow || launchUnknown) {
    const card = report.launchCard;
    if (!card) {
      problems.push("「打开 Codex」既没有给出窗口缺失结论，也没有报错：点击后界面没有任何反馈");
    } else if (launchUnknown) {
      if (!card.heading.includes("主窗口没有出现")) problems.push(`窗口缺失横幅标题不正确：${card.heading}`);
      if (!card.text.includes("未能判定")) problems.push(`判定不出来时横幅必须如实说明，实际：${card.text}`);
      if (card.text.includes("修复资源副本并重新启动")) {
        problems.push("判定不出来时不该出现「修复资源副本」按钮：拿不出证据就不能把人推去修");
      }
      if (!card.text.includes("OpenAI\\Codex")) problems.push("判定不出来时要给出下一步排查方向（应用日志位置）");
    } else if (card.missingButton) {
      problems.push("窗口缺失横幅里没有修复按钮，用户拿不到下一步");
    } else {
      if (!card.heading.includes("主窗口没有出现")) problems.push(`窗口缺失横幅标题不正确：${card.heading}`);
      if (card.buttonLabel !== "修复资源副本并重新启动") {
        problems.push(`判定为搬迁 bug 时横幅里的第一颗按钮应当是修复入口，实际：${card.buttonLabel}`);
      }
      if (card.buttonDisabled) problems.push("修复按钮不可点击（流程已经结束了）");
      if (card.buttonCovered) {
        problems.push(`修复按钮被盖住（点不到）：顶部 ${card.buttonTop}px，命中到 ${card.hitTag}`);
      }
      if (card.buttonWidth < 120 || card.buttonHeight < 36) {
        problems.push(`修复按钮可点区域过小：${card.buttonWidth}×${card.buttonHeight}`);
      }
    }
    // 结论之外还要有依据：健康面板里必须能看到窗口探测的原始输出。
    if (!report.rawOutputs.some((raw) => raw.includes("NO main window appeared"))) {
      problems.push("页面上没有展示窗口探测的原始诊断输出");
    }
    // 「判不出来」必须是软提示而不是硬错误：它说明的是一种状态，不是这个应用坏了。
    // 硬错误色（.error-text:not(.soft)）留给真正的意外失败，冒烟测试在别的场景钉着它为空。
    if (report.errorText) problems.push(`窗口没出现不该渲染成硬错误：${report.errorText}`);
  }

  // 安装包缓存卡片。缓存不再自动清理之后，它承担了原来「剪枝策略」替用户做的事：
  // 说明占了多少、并给一个能清空的入口。所以这三样缺一不可 —— 卡片在、标题带占用、
  // 清空按钮是一颗点到就能用的危险色按钮。
  if (!report.cache) {
    problems.push("页面上没有渲染出「安装包缓存」卡片");
  } else {
    const cache = report.cache;
    const expectedCount = notInstalled ? 0 : 3;
    // 标题里的数字是用户唯一的「占了多少」来源，格式错了他就得不到答案。
    // 不断言具体 GB 数（那取决于夹具的 sizeBytes），只钉住形状与个数。
    const summaryPattern = new RegExp(`^安装包缓存 · ${expectedCount} 个 · `);
    if (!summaryPattern.test(cache.summary)) {
      problems.push(`安装包缓存卡片的标题不对：${cache.summary}（应形如「安装包缓存 · ${expectedCount} 个 · 1.23 GB」）`);
    }
    if (cache.summary.includes("占用未知")) {
      problems.push("缓存清单已经桩好却报「占用未知」：读不到的判定条件写反了");
    }
    if (!cache.hasBrowse) problems.push("安装包缓存卡片里没有换目录的入口：「占了多少」之后的下一个问题就是「能不能挪走」");
    if (!cache.clearLabel.includes("清空缓存")) problems.push(`清空按钮的文案不对：${cache.clearLabel}`);
    if (cache.clearIsDanger !== true) {
      problems.push("清空缓存是唯一会删掉用户数据的按钮，必须用危险色和旁边的「打开目录」区分开");
    }
    if (cache.historyToggleChecked !== true) {
      problems.push("「显示版本历史」默认必须是勾上的：老配置文件里没有这个键，读出来是 undefined");
    }
    // 「会不会把 Codex 卸了」是用户看到「删除」时的第一反应，必须当场回答。
    if (!cache.help.join(" ").includes("已安装的 Codex 不受影响")) {
      problems.push("清空缓存的说明里没有写「已安装的 Codex 不受影响」——那正是用户最担心的");
    }
    // 忙的时候不能清：正跑着的下载或安装就站在这个目录里。
    if (checkingHold && cache.clearDisabled !== true) {
      problems.push("检查更新跑着的时候「清空缓存」仍然可点");
    }
  }

  // 主题、更新与通知、网络诊断、自动保留份数：新增的设置入口必须真的渲染出来。
  const extras = report.extras;
  if (!extras) {
    problems.push("设置页没有采集到新增设置卡片");
  } else {
    if (!extras.hasThemeCard) problems.push("设置页没有「外观」卡片：主题切换必须在设置里");
    if (extras.themeActive !== "跟随系统") {
      problems.push(`默认主题应为「跟随系统」，实际选中：${extras.themeActive || "(没有选中项)"}`);
    }
    if (extras.themeOptionCount !== 3) problems.push(`主题选项应有 3 档，实际 ${extras.themeOptionCount} 档`);
    if (!extras.hasUpdateCard) problems.push("设置页没有「更新与通知」卡片");
    if (!extras.hasNetworkCard || !extras.hasNetworkButton) {
      problems.push("设置页没有「网络诊断」卡片或它的诊断按钮");
    }
    if (extras.intervalValue !== "6") {
      problems.push(`后台复查间隔的默认值应为 6 小时，实际 ${extras.intervalValue}`);
    }
    if (extras.keepCountValue !== "0") {
      problems.push(`自动保留份数的默认值应为 0（不自动清理），实际 ${extras.keepCountValue}`);
    }
  }

  // 版本历史 / 回退。卡片在每个场景都在页面上，所以这组断言不绑 --rollback：
  // 布局被挤坏、徽章写错、有人加回一颗删除按钮，这些在默认场景就该被发现。
  const rollbackCard = report.rollback;
  if (!rollbackCard) {
    problems.push("页面上没有渲染出「版本历史」卡片（.rollback-card）");
  } else {
    if (rollbackCard.heading !== "版本历史") problems.push(`版本历史卡片标题不正确：${rollbackCard.heading}`);
    // 逐包管理是这批改动的一部分：每一行都该有「校验签名 / 固定 / 删除」三颗小动作。
    // 删除现在有了第二道防线（主进程原生确认框 + 只认缓存目录里的 Codex 包），
    // 所以这里数的不是「有没有删除」，而是「每行是不是都齐了」。
    if (rollbackCard.deleteButtonCount !== rollbackCard.rowCount) {
      problems.push(
        `版本历史每行应有一颗删除按钮：${rollbackCard.rowCount} 行、${rollbackCard.deleteButtonCount} 颗`,
      );
    }
    for (const row of rollbackCard.rows ?? []) {
      for (const label of ["校验签名", "删除"]) {
        if (!(row.actions ?? []).some((action) => action.includes(label))) {
          problems.push(`版本历史 ${row.version} 这一行缺少「${label}」动作`);
        }
      }
      if (!(row.actions ?? []).some((action) => action.includes("固定"))) {
        problems.push(`版本历史 ${row.version} 这一行缺少「固定」动作`);
      }
    }
    if (notInstalled) {
      if (rollbackCard.rowCount !== 0) {
        problems.push(`未安装时不该列出安装包，实际 ${rollbackCard.rowCount} 行`);
      }
      // 空列表必须是解释，不是一个空盒子：这个功能有「必须先带新策略更新过一次」
      // 的前提，用户第一次打开时看到的就是空列表。
      if (!rollbackCard.emptyHelp.includes("安装完成后")) {
        problems.push(`未安装时版本历史缺少说明文案：${rollbackCard.emptyHelp || "(没有)"}`);
      }
    } else {
      const expectedRows = [
        ["26.902.100.0", "比当前新"],
        ["26.901.6511.0", "当前已安装"],
        ["26.896.100.0", "可回退"],
      ];
      if (rollbackCard.rowCount !== expectedRows.length) {
        problems.push(`版本历史应有 ${expectedRows.length} 行安装包，实际 ${rollbackCard.rowCount} 行`);
      }
      for (const [version, state] of expectedRows) {
        const row = rollbackCard.rows.find((entry) => entry.version === version);
        if (!row) problems.push(`版本历史里缺少 ${version} 这一行`);
        else if (row.state !== state) problems.push(`${version} 的状态徽章不正确：${row.state}（应为 ${state}）`);
      }
      // 能回退的那一版、以及当前这一版（重装）各给一颗按钮；已下载未安装的那一版
      // 没有动作，不该有按钮。
      const actionable = rollbackCard.rows.filter((row) => row.buttonLabel);
      if (actionable.length !== 2) problems.push(`版本历史应有 2 行带操作按钮，实际 ${actionable.length} 行`);
      const olderRow = rollbackCard.rows.find((row) => row.className.includes("older"));
      if (olderRow?.buttonLabel !== "回退到此版本") {
        problems.push(`可回退那一行的按钮文案不正确：${olderRow?.buttonLabel || "(没有按钮)"}`);
      }
      const newerRow = rollbackCard.rows.find((row) => row.className.includes("newer"));
      if (newerRow?.buttonLabel) problems.push(`比当前新的那一行不该有操作按钮：${newerRow.buttonLabel}`);
      for (const row of actionable) {
        if (row.buttonLineBoxes > 1) {
          problems.push(`回退按钮文字折行（被挤压到放不下）：${row.buttonLabel}（宽 ${row.buttonWidth}px，${row.buttonLineBoxes} 行）`);
        }
        if (row.buttonHeight < 32) {
          problems.push(`回退按钮可点区域过小：${row.buttonLabel}（${row.buttonWidth}×${row.buttonHeight}）`);
        }
        if (row.buttonCovered) problems.push(`回退按钮被盖住（点不到）：${row.buttonLabel}`);
        if (row.overflowsRow) problems.push(`回退按钮溢出所在行：${row.buttonLabel}`);
        // --checking 场景里命令正跑着，按钮本来就该是灰的。
        if (!checkingHold && row.buttonDisabled) problems.push(`就绪状态下回退按钮不该置灰：${row.buttonLabel}`);
      }
    }
  }

  // --rollback：点下去之后，命令真的走了回退链路，而且带着允许降级的开关。
  // 少了 allowDowngrade，Windows 会拒绝安装更低的版本，界面却一路显示成功 ——
  // 这条断言正是防这个「静默什么都没发生」。
  if (rollbackScenario) {
    const olderPackage = STUB_CACHED_PACKAGES.packages.find((pkg) => pkg.relation === "older");
    if (commandCalls.verify_download_signature !== 1) {
      problems.push(
        `回退没有先校验签名：verify_download_signature 发出 ${commandCalls.verify_download_signature || 0} 次（应为 1 次）`,
      );
    }
    if (commandCalls.install_codex !== 1) {
      problems.push(`回退没有恰好发出一次安装命令：install_codex 发出 ${commandCalls.install_codex || 0} 次`);
    }
    if (commandArgs.install_codex?.allowDowngrade !== true) {
      problems.push("回退没有带上 allowDowngrade：Windows 会拒绝降级，而界面看起来一切正常");
    }
    if (commandArgs.install_codex?.path !== olderPackage.path) {
      problems.push(`回退用的安装包不对：${commandArgs.install_codex?.path}`);
    }

    const busyCard = rollbackBusy?.rollback;
    if (!busyCard) {
      problems.push("回退过程中版本历史卡片消失了");
    } else {
      // 回退和安装共用 install 这条链路，文案必须区分开，否则用户以为点错了。
      if (busyCard.ctaLabel !== "正在回退…") {
        problems.push(`回退过程中主按钮文案不正确：${busyCard.ctaLabel}`);
      }
      for (const row of busyCard.rows.filter((entry) => entry.buttonLabel)) {
        if (!row.buttonDisabled) problems.push(`回退过程中按钮仍可点击：${row.buttonLabel}`);
      }
    }

    const afterCard = rollbackAfter?.rollback;
    if (rollbackAfter?.phase !== "done") {
      problems.push(`回退结束后界面没有回到 done 态：${rollbackAfter?.phase}`);
    }
    if (!afterCard) {
      problems.push("回退结束后版本历史卡片消失了");
    } else {
      // 标志位漏清 = 界面永久锁死，用户只能重启应用。
      for (const row of afterCard.rows.filter((entry) => entry.buttonLabel)) {
        if (row.buttonDisabled) problems.push(`回退结束后按钮没有恢复可点：${row.buttonLabel}`);
        if (row.buttonLabel === "正在回退…") problems.push("回退结束后按钮文案仍停在「正在回退…」");
      }
    }
  }

  // 「检查更新」的结论：必须是看得见的模态，且必须关得掉。
  if (noticeOpen) {
    // 对照面：手动点之前（启动自动检查已经跑完了）页面上不该有任何对话框。
    // 与下面那条「点了之后必须弹」合起来，说明弹不弹取决于**谁触发的**，不是弹框坏了。
    if (startupReport.notice?.present) {
      problems.push("启动自动检查弹出了模态对话框：用户什么都没点，不该有对话框挡在面前");
    }
    const dialog = report.notice;
    if (dialog?.toast) problems.push("页面上仍有 .toast 浮层（右下角提示已废弃）");
    if (!dialog?.present) {
      problems.push("检查更新后没有任何结论呈现：这一次命令等于没反馈");
    } else {
      if (dialog.heading !== "提示") problems.push(`对话框标题不正确：${dialog.heading}`);
      if (!dialog.message.includes("发现新版本")) problems.push(`对话框内容不正确：${dialog.message}`);
      if (!dialog.buttonLabel) problems.push("对话框没有确认按钮，用户无法关闭");
      // 居中：允许 2px 的取整误差。
      if (Math.abs(dialog.offsetX) > 2) problems.push(`对话框没有水平居中，偏了 ${dialog.offsetX}px`);
      if (Math.abs(dialog.offsetY) > 2) problems.push(`对话框没有垂直居中，偏了 ${dialog.offsetY}px`);
      if (!dialog.inViewport) problems.push("对话框超出了视口（用户可能只看到一半或完全看不到）");
      if (!dialog.buttonHittable) problems.push("对话框的确认按钮点不到（被别的层盖住）");
      if (!dialog.buttonFocused) problems.push("对话框打开后焦点不在确认按钮上，回车关不掉");
      if (dialog.backdropZ <= 30) problems.push(`对话框遮罩 z-index=${dialog.backdropZ}，压不过顶栏（30）`);
      // 关不掉就等于挡路：断言点完之后它真的从页面上消失。
      if (noticeAfterClose?.notice?.present) problems.push("点击确认按钮后对话框没有关闭");
      // 对话框之外，检查的结果也要落到界面上：只弹一句提示、按钮还写着「检查并更新」，
      // 用户关掉对话框就再也看不到「有新版本」这件事了。
      if (report.ctaLabel !== "一键更新到 26.902.100.0") {
        problems.push(`检查出有新版本后主操作按钮没有跟着变：${report.ctaLabel}`);
      }
    }
  }

  // 命令跑着时，所有能再触发命令的入口都必须点不动 —— 而且跑完必须重新点得动。
  // 这两面缺一不可：只顾置灰会永久锁死，只顾解锁等于没拦，用户连点几次就并发跑几条命令。
  if (checkingHold) {
    if (!busyReport) {
      problems.push("没有采集到命令执行中的界面状态");
    } else {
      const cta = busyReport.cta ?? [];
      if (cta.length !== 2) problems.push(`主区应有 2 个按钮（主/次），实际 ${cta.length} 个`);
      for (const button of cta) {
        if (!button.disabled) problems.push(`命令执行中按钮仍可点击：${button.label}`);
      }
      // 置灰必须带一句解释，否则就是用户抱怨的「点了没反应」。
      const secondary = cta.find((button) => button.label === "正在检查…");
      if (!secondary) problems.push(`检查更新期间次按钮文案未反映进行中：${cta.map((b) => b.label).join(" / ")}`);

      for (const button of busyReport.health ?? []) {
        if (!button.disabled) problems.push(`命令执行中诊断按钮仍可点击：${button.label}`);
      }

      // 「复制诊断信息」归在这一档：它不跑命令、瞬间返回，而且最需要它的时刻恰恰是
      // 安装刚失败、界面还忙着的那个时候 —— 忙时把它一起禁掉就是帮倒忙。
      const instantItems = ["复制诊断信息", "打开日志目录", "打开缓存目录"];
      const byLabel = new Map((busyReport.instant ?? []).map((item) => [item.label, item]));
      if (byLabel.size === 0) problems.push("命令执行中没有采集到设置页的即时入口");
      // 打开目录/复制诊断是每条命令链路之外的动作，秒回，而且跑着的时候正是用户最想点它。
      for (const label of instantItems) {
        const item = byLabel.get(label);
        if (!item) problems.push(`设置页里找不到即时入口：${label}`);
        else if (item.disabled) problems.push(`命令执行中不该禁用即时入口：${label}`);
      }

      // 连点不叠加：上面又发了 4 次「检查更新」（此前还发过 3 次），真跑到的只该是
      // **启动时那一次**自动检查。按增量断言而不是绝对值 1：绝对值在「自动检查压根没
      // 发生」时同样成立（0 之后还是 0 也不算增加），那这一整段就什么都没证明。
      if (busyReport.checkUpdateCalls !== busyReport.callsBeforeFlood) {
        problems.push(
          `命令执行中重复点击叠加了命令：check_update 从 ${busyReport.callsBeforeFlood} 次变成 ` +
            `${busyReport.checkUpdateCalls} 次（连点不该产生新的 IPC）`,
        );
      }
      if (busyReport.callsBeforeFlood !== 1) {
        problems.push(`启动自动检查应当恰好发出一次 check_update，实际 ${busyReport.callsBeforeFlood} 次`);
      }
      if (busyReport.phase !== "ready") {
        problems.push(`检查更新不应改动安装状态，phase 变成了 ${busyReport.phase}`);
      }

      // 放行之后必须重新点得动。标志位若漏清，界面就永久锁死，用户只能重启应用。
      if (!idleReport) {
        problems.push("没有采集到命令结束后的界面状态");
      } else {
        for (const button of idleReport.cta ?? []) {
          if (button.disabled) problems.push(`命令结束后按钮没有恢复可点：${button.label}`);
        }
        for (const button of idleReport.health ?? []) {
          if (button.disabled) problems.push(`命令结束后诊断按钮没有恢复可点：${button.label}`);
        }
        for (const button of idleReport.instant ?? []) {
          if (button.disabled) problems.push(`命令结束后即时入口没有恢复可点：${button.label}`);
        }
      }
    }
  }

  // 截图放在断言之前：失败时也要留下现场，否则只能靠猜。
  if (screenshotDir) {
    mkdirSync(screenshotDir, { recursive: true });
    const name = noticeOpen
      ? "notice"
      : checkingHold
        ? "checking"
        : upToDateScenario
          ? "up-to-date"
          : appUpdateScenario
            ? "app-update"
            : storageScenario
              ? "storage"
              : launchNoWindow
          ? "launch-no-window"
          : rollbackScenario
            ? "rollback"
            : menuOpen
              ? "menu"
              : installing
                ? "installing"
                : notInstalled
                  ? "not-installed"
                  : "ready";
    // 内容高度从 .app-scroll 量，不是 documentElement：整窗只有内容区滚动，
    // 文档本身不滚，量文档只会得到视口高度，截出来永远是半张图。
    const capture = async (file) => {
      const fullHeight = await window.webContents.executeJavaScript(
        `(() => {
          const scroll = document.querySelector(".app-scroll");
          const bar = document.querySelector(".topbar");
          const barHeight = bar ? bar.getBoundingClientRect().height : 0;
          const content = scroll ? scroll.scrollHeight : document.documentElement.scrollHeight;
          return Math.min(Math.round(barHeight + content + 20), 2400);
        })()`,
      );
      // 只调高度、保持被测宽度：宽度一变布局会切到另一个断点，截出来的就不是
      // 刚刚断言过的那套布局了（曾经因此让「浏览按钮折行」在截图里可见、断言却放过）。
      window.setContentSize(windowWidth, Math.max(780, Math.round(fullHeight)));
      await new Promise((resolve) => setTimeout(resolve, 400));
      // resize 之后合成器偶尔还没出帧，capturePage 会回一张空图。空 PNG 看起来
      // 跟「截图失败」一模一样，会让人误判成界面白屏，所以这里重试到拿到内容为止。
      let image = await window.webContents.capturePage();
      for (let attempt = 0; attempt < 3 && image.isEmpty(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        image = await window.webContents.capturePage();
      }
      writeFileSync(file, image.toPNG());
      console.log(`\n  截图：${file}${image.isEmpty() ? "（空图，抓帧失败）" : ""}`);
    };

    // 主场景把四页都截下来：界面是「概览 / 诊断 / 版本历史 / 设置」四页结构，
    // 只看概览等于只验收了四分之一 —— 窄窗口和深色下的问题恰好多出在另外三页。
    // 其他场景有自己的焦点状态（对话框、进度、回退），只截该场景本身。
    const views = name === "ready" ? ["overview", "diagnostics", "history", "settings"] : [null];
    for (const view of views) {
      if (view) {
        await window.webContents.executeJavaScript(
          `(() => { const item = document.querySelector('.nav-item[data-nav="${view}"]'); if (item) item.click(); return !!item; })()`,
        );
        // 页面入场动画 0.24s，等它落定再截。
        await new Promise((resolve) => setTimeout(resolve, 320));
        await window.webContents.executeJavaScript(
          `(() => { const scroll = document.querySelector(".app-scroll"); if (scroll) scroll.scrollTo({ top: 0 }); return true; })()`,
        );
      }
      await capture(join(screenshotDir, view ? `${name}-${view}.png` : `${name}.png`));
      // 设置页四个标签一次只渲染一个，只截一个标签等于只验收了四分之一。
      // 「外观」是主题切换唯一入口，深色截图必须能看见它。
      if (view === "settings") {
        await window.webContents.executeJavaScript(
          `(() => { const tab = document.getElementById("settings-tab-appearance"); if (tab) tab.click(); return !!tab; })()`,
        );
        await new Promise((resolve) => setTimeout(resolve, 260));
        await capture(join(screenshotDir, `${name}-settings-appearance.png`));
      }
    }
  }

  if (problems.length > 0) {
    console.error("✗ 渲染冒烟测试失败：");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.log(`  实测主区：${report.heading} / ${report.lede}`);
    console.log(`  实测路径行按钮：[${(report.pathRowButtons ?? []).map((b) => `${b.label} ${b.width}×${b.height} ${b.lineBoxes}行`).join(" | ")}]`);
    if (report.notice?.present) {
      const d = report.notice;
      console.log(
        `  实测对话框：${d.width}×${d.height}，中心偏离 ${d.offsetX}px/${d.offsetY}px；` +
          `遮罩 top=${d.backdropTop} height=${d.backdropHeight}，视口高 ${d.viewportHeight}，transform=${d.transform}`,
      );
    }
    if (busyReport) {
      const describe = (state) =>
        [...(state.cta ?? []), ...(state.health ?? []), ...(state.instant ?? [])]
          .map((button) => `${button.label}${button.disabled ? "（灰）" : "（可点）"}`)
          .join(" | ");
      console.log(`  实测运行中：${describe(busyReport)}；check_update 发出 ${busyReport.checkUpdateCalls} 次`);
      if (idleReport) console.log(`  实测结束后：${describe(idleReport)}`);
    }
    if (consoleErrors.length > 0) console.error(`  控制台报错：\n    ${consoleErrors.join("\n    ")}`);
    app.exit(1);
    return;
  }

  const scenarioLabel = noticeOpen
    ? "命令结论对话框"
    : checkingHold
      ? "命令执行中的交互锁"
      : launchUnknown
        ? "打开 Codex（判不出原因，不给修复入口）"
        : launchNoWindow
          ? "打开 Codex（进程在/窗口不在，判定为搬迁 bug）"
        : rollbackScenario
          ? "版本回退"
          : storageScenario
            ? "存储管理（主题切换 / 缓存迁移确认 / 应用迁移检测）"
          : installing
            ? "安装进度流"
            : notInstalled
              ? "未安装"
              : "已安装";
  console.log(`✓ 渲染冒烟测试通过（${scenarioLabel}场景）`);
  console.log(`  根节点子元素：${report.rootChildren}`);
  console.log(`  样式表数量：${report.styleSheetCount}`);
  console.log(`  主区标题：${report.heading}`);
  // 副标题也要印出来：启动两段（只读本机 → 联网查最新版）的中间态全靠它交代，
  // 只打标题的话，「到底哪一段没说话」在日志里看不出来。
  console.log(`  主区副标题：${report.lede}`);
  console.log(`  主操作按钮：${report.ctaLabel}`);
  console.log(`  健康组件行：${report.healthRows}（结论：${report.verdict}）`);
  if (report.cache) {
    const clear = report.cache.clearLabel + (report.cache.clearDisabled ? "（灰）" : "");
    console.log(`  安装包缓存：${report.cache.summary} | 清空按钮：${clear}`);
  }
  if (report.rollback) {
    console.log(
      `  版本历史：[${
        report.rollback.rows
          .map((row) => `${row.version} ${row.state}${row.buttonLabel ? ` / ${row.buttonLabel}` : ""}`)
          .join(" | ") || "空（已给出解释文案）"
      }]`,
    );
  }
  if (rollbackAfter) console.log(`  回退后主按钮：${rollbackAfter.rollback?.ctaLabel ?? "（未渲染）"}，phase=${rollbackAfter.phase}`);
  console.log(`  路径行按钮：[${(report.pathRowButtons ?? []).map((b) => `${b.label} ${b.width}×${b.height} ${b.lineBoxes}行`).join(" | ")}]`);
  console.log(`  Codex 安装位置（高级设置里显示的）：${report.installLocationField ?? "（未渲染）"}`);
  console.log(`  窗口控制：[${report.windowControls.map((c) => `${c.label} ${c.width}×${c.height}`).join(" | ")}]`);
  console.log(`  顶栏固定：滚到底后窗口按钮仍在视口内（滚动位置 ${stickyTitleBar?.scrolled ?? "?"}px）`);
  if (report.notice?.present) {
    const dialog = report.notice;
    console.log(
      `  结论对话框：「${dialog.heading} / ${dialog.message}」${dialog.width}×${dialog.height}` +
        `，偏离视口中心 ${dialog.offsetX}px/${dialog.offsetY}px，确认按钮「${dialog.buttonLabel}」可点且已聚焦` +
        `${noticeAfterClose ? `，点击后${noticeAfterClose.notice?.present ? "仍在（未关闭!）" : "已关闭"}` : ""}`,
    );
  }
  if (navReport) {
    console.log(
      `  侧栏导航：[${navReport.items.map((i) => `${i.id}/${i.label}@${i.top}px${i.covered ? " 被盖住!" : ""}`).join(" | ")}]`,
    );
    console.log(`  逐页导航：[${navReport.pages.map((page) => `${page.id} → ${page.heading || "(无标题)"}`).join(" | ")}]`);
    const scroll = navReport.scroll;
    console.log(
      `  滚动：设置页滚到底 ${scroll.scrolledTo.top}/${scroll.scrolledTo.max}；` +
        `切回概览顶部 ${scroll.resetTop}；` +
        `PageDown=${scroll.keyboardScroll.afterPageDown}，End=${scroll.keyboardScroll.afterEnd}/${scroll.keyboardScroll.max}，Home=${scroll.keyboardScroll.afterHome}`,
    );
  }

  if (busyReport) {
    const describe = (state) =>
      [...(state.cta ?? []), ...(state.health ?? [])]
        .map((button) => `${button.label}${button.disabled ? "（灰）" : "（可点）"}`)
        .join(" | ");
    console.log(`  命令执行中：${describe(busyReport)}`);
    console.log(
      `  即时入口：${(busyReport.instant ?? []).map((i) => `${i.label}${i.disabled ? "（灰）" : ""}`).join(" | ")}`,
    );
    console.log(`  连点 4 次「检查更新」，实际发出 ${busyReport.checkUpdateCalls} 次 IPC`);
    if (idleReport) console.log(`  命令结束后：${describe(idleReport)}（应全部恢复可点）`);
  }
  if (installing) {
    console.log(`  下载阶段：${downloadReport?.activity.percent}（不确定进度条=${downloadReport?.activity.indeterminate}，${downloadReport?.activity.subline}）`);
    console.log(`  安装完成：${report.activity.percent} 进度条=${report.activity.fillWidth} 「${report.activity.label}」`);
    console.log(`  软告警：${report.activity.warning}`);
    console.log(`  日志区：${report.activity.logSummary}`);
  }
  if (launchNoWindow && report.launchCard && !report.launchCard.missingButton) {
    console.log(`  窗口缺失横幅：${report.launchCard.heading}`);
    console.log(`  修复入口：${report.launchCard.buttonLabel} ${report.launchCard.buttonWidth}×${report.launchCard.buttonHeight}（可点击=${!report.launchCard.buttonDisabled && !report.launchCard.buttonCovered}）`);
    console.log(`  原始诊断：${report.rawOutputs.length} 段（含窗口探测输出）`);
  }
  if (launchUnknown && report.launchCard) {
    console.log(`  窗口缺失横幅：${report.launchCard.heading}`);
    console.log(`  判定文案：${report.launchCard.text}`);
    console.log(`  修复入口：${report.launchCard.missingButton ? "无（符合预期）" : report.launchCard.buttonLabel}（卡内不应出现修复按钮）`);
  }
  if (packaged) console.log(`  内置脚本：${PACKAGED_SCRIPTS.length} 个已就位于 ${packagedScriptsDir}`);
  app.exit(0);
}

app.whenReady().then(main).catch((error) => {
  console.error("✗ 渲染冒烟测试异常：", error);
  app.exit(1);
});
