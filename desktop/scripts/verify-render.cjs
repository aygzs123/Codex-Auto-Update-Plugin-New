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

const { app, BrowserWindow, ipcMain } = require("electron");
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

// 打包态还必须确认脚本落在 asar 之外。PowerShell 无法执行 app.asar 内的 .ps1，
// 而 extraResources 配错时这件事不会报错，只会等到用户点「一键安装」才失败。
const PACKAGED_SCRIPTS = [
  "CodexStoreUpdater.psm1",
  "check-codex-update.ps1",
  "install-codex-msix-and-restart.ps1",
  "check-codex-desktop-health.ps1",
  "list-cached-codex-packages.ps1",
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

// --launch-no-window：从菜单触发「打开 Codex」，桩返回「进程起来了但没有主窗口」。
// 这条路径以前是 fire-and-forget：界面上报「已请求启动」，用户屏幕上什么都没有，
// 看起来就是「点了没反应」。这个场景专门验证那种情况现在会给出结论和补救入口。
const launchNoWindow = process.argv.includes("--launch-no-window");

// --notice：从菜单触发「检查更新」，验证命令的结论是**居中的模态对话框**。
// 以前是右下角 toast：用户点完按钮，视线还在主区（视线的另一头），很容易整个错过
// —— 而这里弹的是命令唯一的反馈。所以这个场景断言的不是「它出现了」，而是
// 「居中、完整落在视口内、按钮点得到、点完真的会关掉」。
const noticeOpen = process.argv.includes("--notice");

// --checking：「检查更新」跑到一半（网络往返挂住不返回）时的界面。
//
// 这条场景钉的是一个交互问题：命令跑着的时候，所有能再触发命令的入口都必须点不动。
// 以前「检查更新」压根不置任何忙标志，用户点一下没见反应就连点，于是并发发出好几次
// 检查、连弹好几次结论；反过来，标志位若漏清，界面会永久锁死，用户只能重启应用。
// 所以这里两件事都要看到：跑着时点不动（按钮 disabled + 再发命令不产生第二次 IPC），
// 跑完之后重新点得动。
const checkingHold = process.argv.includes("--checking");

// --rollback：点一次「版本历史」里的回退按钮，走完整条真实链路
// （按钮 → store.rollback → 校验签名 → 装旧包）。这条场景要证明的不只是「卡片画出来了」，
// 而是：回退真的带着 allowDowngrade 发出去了、跑着的时候按钮点不动、跑完能回到正常态。
// 安装那一步用挂住的方式模拟一次长命令，否则它瞬间返回，观察不到「正在回退」的中间态。
const rollbackScenario = process.argv.includes("--rollback");

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
      needsRepair: false,
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
      overall: "ok",
      components: [
        { state: "ok", symbol: "OK", name: "win-cli", path: "C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\8e5b6932", leftovers: 0 },
        { state: "ok", symbol: "OK", name: "win-rg", path: "C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\c6063512", leftovers: 0 },
        { state: "ok", symbol: "OK", name: "wsl-cli", path: "C:\\Users\\me\\.codex\\bin\\wsl\\b53f5e5f", leftovers: 0 },
        { state: "ok", symbol: "OK", name: "wsl-rg", path: "C:\\Users\\me\\.codex\\bin\\wsl\\1a4f6f66", leftovers: 0 },
        { state: "ok", symbol: "OK", name: "cua_node", path: "C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\b474a88d", leftovers: 0 },
      ],
      pluginsMaterialized: false,
      appUserModelId: null,
      probeResult: null,
      probeMessage: null,
      needsRepair: false,
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
  downloadDirectory: "C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\downloads",
};

// 「版本历史」卡片的数据源。三行一次覆盖三种 relation：比当前新的（已下载未安装）、
// 当前这一版、以及唯一能回退的那一版。未安装的机器上缓存是空的 —— 这条也要有，
// 空列表必须给出解释文案，不能是一个空盒子。
const CACHE_DIRECTORY = "C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\downloads";
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
// --rollback 场景里被挂住的 install_codex，同上。
const releaseHeldInstall = [];
const releaseInstall = () => releaseHeldInstall.splice(0).forEach((resolve) => resolve());

function registerStubHandlers() {
  ipcMain.handle("desktop:command", (_event, command, args) => {
    // 记下每条命令真的走了几次 IPC。这是「命令跑着时再点不会叠加」唯一可靠的证据：
    // DOM 上的 disabled 只说明按钮点不动，说明不了快捷键/其它入口有没有绕过去。
    commandCalls[command] = (commandCalls[command] || 0) + 1;
    commandArgs[command] = args || {};
    switch (command) {
      case "get_settings":
        return {
          downloadDirectory: "",
          defaultDownloadDirectory: "C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\downloads",
          logsDirectory: "C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\logs",
        };
      case "get_status":
      case "check_health":
        return STUB_HEALTH;
      case "list_cached_packages":
        // 不桩的话默认分支会回一个 {}，渲染进程读 packages 会炸。
        return { ...STUB_CACHED_PACKAGES };
      case "verify_download_signature":
        // 回退和安装共用同一道签名闸门。桩回「通过」，让流程能走到安装那一步 ——
        // 校验失败的分支由 rollback.test.cjs 的源码契约盯着。
        return {
          status: "verified",
          publisher: "CN=OpenAI, O=OpenAI, L=San Francisco, S=California, C=US",
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
      // 「打开 Codex」的失败形态：启动请求发出去了、进程也在跑，但主窗口没出现
      // （官方加密资源搬迁 bug）。健康数据取自健康脚本真实输出的形状。
      case "launch_codex":
        return {
          ok: false,
          windowVisible: false,
          version: "26.901.6511.0",
          appUserModelId: "OpenAI.Codex_2p2nqsd0c76g0!App",
          probeMessage:
            "WARNING: Codex Desktop processes are up but NO main window appeared within 20 s. " +
            "This is the signature of the official encrypted-resource relocation bug.",
          health: {
            ...STUB_HEALTH,
            exitCode: 3,
            overall: "ok",
            appUserModelId: "OpenAI.Codex_2p2nqsd0c76g0!App",
            probeResult: "window-not-visible",
            probeMessage: "WARNING: Codex Desktop processes are up but NO main window appeared within 20 s.",
            needsRepair: true,
          },
        };
      case "check_update":
        // --checking 场景把它挂住：真实的 check_update 是一次网络往返，几秒不回话。
        // 返回一个由测试侧决定何时 resolve 的 Promise，就有了一段稳定的「命令跑着」
        // 的窗口可以用来观察界面。每次调用各挂一个，方便反复观察。
        if (checkingHold) {
          return new Promise((resolve) => {
            releaseHeldUpdate.push(() => resolve({ ...STUB_UPDATE }));
          });
        }
        return { ...STUB_UPDATE };
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
  return window.webContents.executeJavaScript(`(() => {
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
      ctaLabel: cta ? cta.textContent.trim() : "",
      ctaDisabled: cta ? cta.disabled : null,
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
      // —— 而它右边的按钮（「打开 Windows 存储设置」）恰恰是最长的一个。
      pathRowButtons: (() => {
        const rows = [...document.querySelectorAll(".path-row")];
        if (rows.length === 0) return null;
        return rows.flatMap((row, rowIndex) => {
          const rowRect = row.getBoundingClientRect();
          return [...row.querySelectorAll("button")].map((button) => {
            const rect = button.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(button);
            const lineBoxes = range.getClientRects().length;
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
      // 卡片标题栏上的装饰圆点（原型 .window-head::before）：红黄绿三个，
      // 用 box-shadow 画出另外两个。它是装饰，不该有点击目标。
      cardDots: (() => {
        const head = document.querySelector(".window-head");
        if (!head) return null;
        const dot = getComputedStyle(head, "::before");
        return {
          content: dot.content,
          color: dot.backgroundColor,
          radius: dot.borderTopLeftRadius,
          shadow: dot.boxShadow,
          width: Math.round(parseFloat(dot.width) || 0),
          pointerEvents: dot.pointerEvents,
        };
      })(),
      // 卡片标题栏的左内边距：给圆点留的空位（原型是 94px）。
      cardHeadPadding: (() => {
        const head = document.querySelector(".window-head");
        return head ? Math.round(parseFloat(getComputedStyle(head).paddingLeft) || 0) : null;
      })(),
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
        const button = card.querySelector("button");
        if (!button) return { heading: heading ? heading.textContent.trim() : "", missingButton: true };
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          heading: heading ? heading.textContent.trim() : "",
          buttonLabel: button.textContent.trim(),
          buttonDisabled: button.disabled,
          buttonWidth: Math.round(rect.width),
          buttonHeight: Math.round(rect.height),
          buttonTop: Math.round(rect.top),
          buttonCovered: !(hit && (hit === button || button.contains(hit))),
          hitTag: hit ? hit.className || hit.tagName : "(空)",
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
            lineBoxes = range.getClientRects().length;
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
}

/**
 * 采集「所有能触发命令的入口是否可点」。
 *
 * 逐个入口量，而不是只看主按钮：用户说的「点完检查更新还能继续点」正是从菜单和次按钮
 * 来的 —— 主按钮置灰而菜单不置灰，等于闸门只关了一半。
 */
async function readBusyState(window) {
  const readButtons = () =>
    window.webContents.executeJavaScript(`(() => {
      const collect = (selector) =>
        [...document.querySelectorAll(selector)].map((button) => ({
          label: button.textContent.trim(),
          disabled: button.disabled,
          title: button.title || "",
        }));
      return {
        cta: collect(".cta-row button"),
        health: collect(".dash-actions button"),
      };
    })()`);

  // 菜单项只在展开时才存在，所以逐组展开、采集，再收起。点两次同一个触发器就是关闭。
  const readMenuGroup = async (index, count) => {
    const open = async () => {
      await window.webContents.executeJavaScript(
        `(() => { const t = document.querySelectorAll(".menu-trigger")[${index}]; if (t) t.click(); return !!t; })()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
      const items = await window.webContents.executeJavaScript(`(() => {
        const popover = document.querySelector(".menu-popover");
        if (!popover) return null;
        return [...popover.querySelectorAll("button")].map((button) => ({
          label: button.textContent.trim(),
          disabled: button.disabled,
          title: button.title || "",
        }));
      })()`);
      await window.webContents.executeJavaScript(
        `(() => { const t = document.querySelectorAll(".menu-trigger")[${index}]; if (t) t.click(); return true; })()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      return items;
    };
    const items = await open();
    // 展不开就再试一次：菜单靠 React 状态渲染，极慢的机器上第一次可能还没提交。
    return items && items.length === count ? items : await open();
  };

  const buttons = await readButtons();
  const menu = [
    ...((await readMenuGroup(0, 3)) ?? []),
    ...((await readMenuGroup(1, 4)) ?? []),
  ];
  return { ...buttons, menu };
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

  const window = new BrowserWindow({
    // 截图需要真实合成，隐藏窗口抓图不可靠。
    show: Boolean(screenshotDir),
    width: windowWidth,
    height: 780,
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
  // 等 IPC 往返完成、界面退出 checking 态。轮询而不是固定等待，避免慢机器上误报。
  // 注意不能只等「标题非空」：checking 态本身就有标题，那样会立刻退出。
  const deadline = Date.now() + 10_000;
  let report = await inspect(window);
  while (Date.now() < deadline && (report.phase === "checking" || report.phase === null)) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    report = await inspect(window);
  }

  // 展开「高级设置」，让路径行（输入框 + 浏览按钮）真的进入布局再测量。
  // 折叠状态下 <details> 内容不参与布局，量不到裁切。必须在状态数据到位之后做：
  // settings 未就绪时 AdvancedSettings 渲染 null，那时还拿不到这个元素。
  const openedSettings = await window.webContents.executeJavaScript(
    `(() => { const details = document.querySelector(".settings-card"); if (details) details.open = true; return !!details; })()`,
  );
  await new Promise((resolve) => setTimeout(resolve, 250));

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
  if (launchNoWindow) {
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
  //   1. 发一次「检查更新」，桩把它挂住 → 命令处于跑着的状态；
  //   2. 再发三次 → 若闸门有效，IPC 只该发生一次（连点不叠加）；
  //   3. 量界面：主按钮、次按钮、诊断按钮、五个命令菜单项都必须 disabled，
  //      而「打开日志目录 / 打开缓存目录」必须仍然可点（它们秒回，且正是跑着时最有用的）；
  //   4. 放行 → 界面必须重新可点（标志位漏清就是永久锁死，用户只能重启应用）。
  let busyReport = null;
  let idleReport = null;
  if (checkingHold) {
    window.webContents.send("desktop:menu-action", "check");
    await new Promise((resolve) => setTimeout(resolve, 300));
    // 连点三次：菜单动作（runAction）是渲染进程里所有入口的汇合点，这里走的就是真实链路。
    for (let attempt = 0; attempt < 3; attempt++) {
      window.webContents.send("desktop:menu-action", "check");
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    report = await inspect(window);
    busyReport = await readBusyState(window);
    busyReport.checkUpdateCalls = commandCalls.check_update || 0;
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
    const clicked = await window.webContents.executeJavaScript(
      `(() => {
        const button = document.querySelector(".rollback-row.older .rollback-action");
        if (button) button.click();
        return !!button;
      })()`,
    );
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

  // 顶栏下拉菜单：打开后逐个菜单项做命中测试。用 elementFromPoint 而不是看
  // getBoundingClientRect —— 菜单的坐标可以完全正确，同时被上面那层内容盖住，
  // 这种「量得到、点不到」只有命中测试能发现。
  let menuReport = null;
  if (menuOpen) {
    menuReport = await window.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector(".menu-trigger");
      if (!trigger) return { missing: true };
      const triggerRect = trigger.getBoundingClientRect();
      // 尺寸为 0 说明触发器压根没参与布局（display:none / 被隐藏），
      // 此时菜单不是「被盖住」而是「不存在」，报错文案要能区分这两件事。
      if (triggerRect.width === 0 || triggerRect.height === 0) return { hidden: true };
      trigger.click();
      return null;
    })()`);

    if (!menuReport) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      menuReport = await window.webContents.executeJavaScript(`(() => {
        const popover = document.querySelector(".menu-popover");
        const controls = document.querySelector(".window-controls");
        const menu = document.querySelector(".app-menu");
        const bar = document.querySelector(".topbar");
        if (!popover) return { noPopover: true };
        const items = [...popover.querySelectorAll("button")];
        const probe = (element) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return {
            label: element.textContent.trim(),
            top: Math.round(rect.top),
            zeroSize: rect.width === 0 || rect.height === 0,
            covered: !(hit && (hit === element || element.contains(hit))),
            hitTag: hit ? (hit.className || hit.tagName) : "(空)",
          };
        };
        const barRect = bar ? bar.getBoundingClientRect() : null;
        const menuRect = menu ? menu.getBoundingClientRect() : null;
        const controlsRect = controls ? controls.getBoundingClientRect() : null;
        return {
          items: items.map(probe),
          self: probe(popover),
          // 窗口按钮在右上角，窄窗口下菜单会和它们争右边界，量一下有没有撞上。
          gapToControls: menuRect && controlsRect
            ? Math.round(controlsRect.left - menuRect.right)
            : null,
          // 菜单本身也不能被顶出顶栏右边界。
          roomRight: barRect && menuRect ? Math.round(barRect.right - menuRect.right) : null,
        };
      })()`);
    }
  }

  const problems = [];
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
  // --checking 场景的主按钮本来就该是灰的（命令正在跑），这里按「就绪即可点」断言会误报。
  if (!checkingHold && report.ctaDisabled !== false) problems.push("主操作按钮在就绪状态下应当可点击");

  // 高级设置的路径行：输入框 width:100% + flex 默认 min-width:auto 会把「浏览…」
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
    const browse = pathButtons.find((button) => button.label.includes("浏览"));
    if (!browse) problems.push(`路径行缺少「浏览」按钮：${pathButtons.map((b) => b.label).join(", ")}`);
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

  // 卡片标题栏上的 mac 装饰圆点：要有红黄绿三个、要够圆，且不能变成可点元素 ——
  // 它在滚动容器里，往下滚就跟着走，让它承担窗口操作会得到「滚到底关不掉窗口」。
  const dots = report.cardDots;
  if (!dots || dots.content === "none") {
    problems.push("卡片标题栏上没有渲染出 mac 装饰圆点（.window-head::before 缺失）");
  } else {
    if (dots.color !== "rgb(255, 95, 87)") problems.push(`装饰圆点基准色应为口红灯 #ff5f57，实际 ${dots.color}`);
    if (dots.radius !== "50%") problems.push(`装饰圆点不是圆形：border-radius=${dots.radius}`);
    for (const [name, color] of [["黄", "254, 188, 46"], ["绿", "40, 200, 64"]]) {
      if (!dots.shadow.includes(color)) problems.push(`装饰圆点缺少${name}灯（box-shadow=${dots.shadow}）`);
    }
    if (report.cardHeadPadding !== null && report.cardHeadPadding < dots.width * 3) {
      problems.push(`卡片标题栏左内边距 ${report.cardHeadPadding}px 放不下三个圆点，标题会压在圆点上`);
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

  // 顶栏下拉菜单必须真的能看到、点到：菜单是「检查更新 / 一键安装 / 诊断」这些命令
  // 唯一的可见入口（窗口无边框，原生菜单栏不显示），窗口缩小时把它隐藏掉等于
  // 让用户彻底用不了这些命令。
  if (menuOpen) {
    if (menuReport?.missing) problems.push("顶栏里没有菜单触发器 .menu-trigger");
    else if (menuReport?.hidden) problems.push("菜单触发器在窗口缩小时被隐藏了（display:none），命令失去入口");
    else if (menuReport?.noPopover) problems.push("点击菜单触发器后没有弹出 .menu-popover");
    else if (!menuReport) problems.push("菜单探测没有返回结果");
    else {
      for (const item of [menuReport.self, ...menuReport.items]) {
        if (item.zeroSize) problems.push(`菜单项没有参与布局（尺寸为 0）：${item.label || "菜单面板"}`);
        else if (item.covered) problems.push(`菜单被内容盖住（点不到）：${item.label || "菜单面板"}，命中到 ${item.hitTag}`);
      }
      // 窄窗口下菜单可能被顶出顶栏右边界（后面的菜单组也就点不到了）。
      if (menuReport.roomRight !== null && menuReport.roomRight < 0) {
        problems.push(`菜单被挤出顶栏 ${-menuReport.roomRight}px（窗口太窄时后面的菜单组点不到）`);
      }
      if (menuReport.gapToControls !== null && menuReport.gapToControls < 0) {
        problems.push(`菜单与窗口按钮重叠了 ${-menuReport.gapToControls}px（窗口太窄时挤在一起）`);
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
    // 这个 exe 的主用途：新机器上把 Codex 装起来。启动只读状态、不查更新，
    // 所以此时按钮就该是「一键安装 Codex」。
    if (!report.heading.includes("一键安装")) problems.push(`未安装时主区标题不正确：${report.heading}`);
    if (report.ctaLabel !== "一键安装 Codex") problems.push(`未安装时主操作按钮文案不正确：${report.ctaLabel}`);
    if (report.verdict !== "未安装") problems.push(`未安装时健康结论不正确：${report.verdict}`);
    if (report.healthRows !== 0) problems.push(`未安装时不应渲染资源组件行，实际 ${report.healthRows} 个`);
    if (!report.fieldHelp.includes("尚未检测到已安装")) problems.push("未安装时缺少说明文案");
    // 新机器上没有插件可物化，这条提示不该出现。
    if (report.fieldHelp.includes("插件资源尚未物化")) problems.push("未安装时不应提示插件未物化");
  } else {
    // 启动只读设置与状态、不查更新，所以此时还不知道有没有新版本。
    // 按钮应当是「一键检查并更新」——点一下就把查更新→下载→安装整条链走完。
    // --notice 场景例外：它本来就执行了一次真实的检查，按钮随结果变成「一键更新到 X」，
    // 那是正确行为，这里按初始态断言会误报。
    if (!noticeOpen && report.ctaLabel !== "一键检查并更新") problems.push(`主操作按钮文案不正确：${report.ctaLabel}`);
    if (!report.heading.includes("已安装")) problems.push(`主区标题未反映已安装状态：${report.heading}`);
    if (report.healthRows !== 5) problems.push(`健康诊断应渲染 5 个组件行，实际 ${report.healthRows} 个`);
    if (report.verdict !== "资源完整") problems.push(`健康结论不正确：${report.verdict}`);
  }

  // 「打开 Codex」：结论必须可见、且下一步必须可点。这两个缺一个，用户看到的就是
  // 「点了没反应」—— 前一个项目 bug 正是两句都缺：只提示「已请求启动」，而进程在跑、
  // 窗口没出现的失败没有任何呈现。
  if (launchNoWindow) {
    const card = report.launchCard;
    if (!card) {
      problems.push("「打开 Codex」既没有给出窗口缺失结论，也没有报错：点击后界面没有任何反馈");
    } else if (card.missingButton) {
      problems.push("窗口缺失横幅里没有修复按钮，用户拿不到下一步");
    } else {
      if (!card.heading.includes("主窗口没有出现")) problems.push(`窗口缺失横幅标题不正确：${card.heading}`);
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
  }

  // 版本历史 / 回退。卡片在每个场景都在页面上，所以这组断言不绑 --rollback：
  // 布局被挤坏、徽章写错、有人加回一颗删除按钮，这些在默认场景就该被发现。
  const rollbackCard = report.rollback;
  if (!rollbackCard) {
    problems.push("页面上没有渲染出「版本历史」卡片（.rollback-card）");
  } else {
    if (rollbackCard.heading !== "版本历史") problems.push(`版本历史卡片标题不正确：${rollbackCard.heading}`);
    if (rollbackCard.deleteButtonCount > 0) {
      problems.push("版本历史里出现了删除按钮：旧安装包删掉就再也退不回去，不能给误点的机会");
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

      const commandItems = ["检查更新", "一键安装 / 更新", "打开 Codex", "健康自检（含窗口探测）", "修复资源副本"];
      const instantItems = ["打开日志目录", "打开缓存目录"];
      const byLabel = new Map((busyReport.menu ?? []).map((item) => [item.label, item]));
      if (byLabel.size === 0) problems.push("命令执行中没有采集到任何菜单项");
      for (const label of commandItems) {
        const item = byLabel.get(label);
        if (!item) problems.push(`菜单里找不到命令项：${label}`);
        else if (!item.disabled) problems.push(`命令执行中菜单项仍可点击：${label}`);
      }
      // 打开目录是每条命令链路之外的动作，秒回，而且跑着的时候正是用户最想点它。
      for (const label of instantItems) {
        const item = byLabel.get(label);
        if (!item) problems.push(`菜单里找不到目录项：${label}`);
        else if (item.disabled) problems.push(`命令执行中不该禁用目录项：${label}`);
      }

      // 连点不叠加：上面发了 4 次「检查更新」，真跑到的只该是第一次。
      if (busyReport.checkUpdateCalls !== 1) {
        problems.push(`命令执行中重复点击叠加了命令：check_update 实际发出 ${busyReport.checkUpdateCalls} 次（应为 1 次）`);
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
        const item = (idleReport.menu ?? []).find((entry) => entry.label === "检查更新");
        if (item?.disabled) problems.push("命令结束后菜单项没有恢复可点：检查更新");
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
    const file = join(screenshotDir, `${name}.png`);
    writeFileSync(file, image.toPNG());
    console.log(`\n  截图：${file}${image.isEmpty() ? "（空图，抓帧失败）" : ""}`);
  }

  if (problems.length > 0) {
    console.error("✗ 渲染冒烟测试失败：");
    for (const problem of problems) console.error(`  - ${problem}`);
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
        [...(state.cta ?? []), ...(state.health ?? []), ...(state.menu ?? [])]
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
      : launchNoWindow
        ? "打开 Codex（进程在/窗口不在）"
        : rollbackScenario
          ? "版本回退"
          : installing
            ? "安装进度流"
            : notInstalled
              ? "未安装"
              : "已安装";
  console.log(`✓ 渲染冒烟测试通过（${scenarioLabel}场景）`);
  console.log(`  根节点子元素：${report.rootChildren}`);
  console.log(`  样式表数量：${report.styleSheetCount}`);
  console.log(`  主区标题：${report.heading}`);
  console.log(`  主操作按钮：${report.ctaLabel}`);
  console.log(`  健康组件行：${report.healthRows}（结论：${report.verdict}）`);
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
  if (report.cardDots && report.cardDots.content !== "none") {
    console.log(`  卡片装饰圆点：基准色 ${report.cardDots.color}，直径 ${report.cardDots.width}px（另有黄、绿由 box-shadow 画出）`);
  }
  console.log(`  顶栏固定：滚到底后窗口按钮仍在视口内（滚动位置 ${stickyTitleBar?.scrolled ?? "?"}px）`);
  if (report.notice?.present) {
    const dialog = report.notice;
    console.log(
      `  结论对话框：「${dialog.heading} / ${dialog.message}」${dialog.width}×${dialog.height}` +
        `，偏离视口中心 ${dialog.offsetX}px/${dialog.offsetY}px，确认按钮「${dialog.buttonLabel}」可点且已聚焦` +
        `${noticeAfterClose ? `，点击后${noticeAfterClose.notice?.present ? "仍在（未关闭!）" : "已关闭"}` : ""}`,
    );
  }
  if (menuReport && !menuReport.missing && !menuReport.hidden && !menuReport.noPopover) {
    console.log(
      `  下拉菜单：[${menuReport.items.map((i) => `${i.label}@${i.top}px${i.covered ? " 被盖住!" : ""}`).join(" | ")}]` +
        `（距窗口按钮 ${menuReport.gapToControls}px，距顶栏右边界 ${menuReport.roomRight}px）`,
    );
  }

  if (busyReport) {
    const describe = (state) =>
      [...(state.cta ?? []), ...(state.health ?? [])]
        .map((button) => `${button.label}${button.disabled ? "（灰）" : "（可点）"}`)
        .join(" | ");
    console.log(`  命令执行中：${describe(busyReport)}`);
    console.log(
      `  菜单项：${(busyReport.menu ?? []).map((i) => `${i.label}${i.disabled ? "（灰）" : ""}`).join(" | ")}`,
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
  if (packaged) console.log(`  内置脚本：${PACKAGED_SCRIPTS.length} 个已就位于 ${packagedScriptsDir}`);
  app.exit(0);
}

app.whenReady().then(main).catch((error) => {
  console.error("✗ 渲染冒烟测试异常：", error);
  app.exit(1);
});
