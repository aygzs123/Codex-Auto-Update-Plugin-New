// 「这个窗口得像个正经 Windows 程序」。
//
// 用户原话：「后面要发给整个团队使用的，需要考虑一下。最好变成便捷容易使用的」。
// 一个只在自己机器上跑过的工具，缺的正是这些东西：双击两次出来两个更新器、窗口每次
// 都开在默认位置和尺寸、任务栏上是个 Electron 原子图标、几百 MB 下载时任务栏什么都
// 不显示、装到一半关窗没有任何提醒。
//
// 这些都不是「界面好不好看」，而是**同一件事有两个入口**或**没有出口**：两个实例能
// 同时点「一键安装」，两条安装链路会互相踩（一个在装 MSIX，另一个在关 Codex）。
//
// 按仓库既有做法读源码文本断言（主进程是 .cjs，但里面有 Electron，不能 require）。
// 切片边界一律 \r?\n —— CI 是 CRLF 检出，裸 \n 会切空、断言随之静默失效。

const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const main = read("electron", "main.cjs");
const preload = read("electron", "preload.cjs");
const pkg = JSON.parse(read("package.json"));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** 抠出一个顶层 `function name(...) { ... }` 的实现体（结尾的 } 顶格）。 */
function sliceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `main.cjs 里找不到 ${name}`);
  const rest = source.slice(start);
  const end = rest.search(/\r?\n\}\r?\n/);
  assert.notEqual(end, -1, `${name} 的结尾找不到`);
  return rest.slice(0, end);
}

// ---------- 单实例 ----------

test("单实例锁在 whenReady 之前拿到，拿不到就退出", () => {
  const lockAt = main.indexOf("app.requestSingleInstanceLock()");
  assert.notEqual(lockAt, -1, "没有单实例锁：双击两次会出来两个更新器，两个都能点「一键安装」");
  assert.match(main, /const hasSingleInstanceLock = app\.requestSingleInstanceLock\(\);/, "锁的结果要留着，whenReady 里还要用");
  assert.match(main, /if \(!hasSingleInstanceLock\) app\.quit\(\);/, "拿不到锁要退出");
  // ready 之后再判就晚了：第二个实例可能已经把 PowerShell 拉起来了。
  const readyAt = main.indexOf("app.whenReady()");
  assert.ok(lockAt < readyAt, "单实例锁必须在 whenReady 之前拿");
});

test("whenReady 里也要挡住没拿到锁的实例", () => {
  // app.quit() 是异步的，而 whenReady 的回调排在同一轮事件循环里 —— 不挡住的话，
  // 第二个实例照样会把窗口和 PowerShell 建出来再退出。
  assert.match(main, /if \(!hasSingleInstanceLock\) return;/, "whenReady 的回调开头必须挡住没抢到锁的实例");
});

test("第二个实例把已有窗口叫到前台", () => {
  // 拿不到锁就静默退出，用户看到的是「双击了没反应」—— 他只想看到那个窗口。
  const handler = main.match(/app\.on\("second-instance"[\s\S]*?\r?\n\}\);/);
  assert.ok(handler, "缺少 second-instance 处理：用户双击图标时窗口不会浮出来");
  assert.match(handler[0], /showMainWindow\(\)/);
  const show = sliceFunction(main, "showMainWindow");
  assert.match(show, /mainWindow\.isMinimized\(\)\) mainWindow\.restore\(\)/, "最小化状态要先 restore，否则 show() 不起作用");
  assert.match(show, /mainWindow\.focus\(\)/, "光 show 不 focus，窗口会被别的窗口盖着");
});

// ---------- 窗口位置尺寸 ----------

test("窗口位置尺寸从 settings.json 读，并且恢复前先查显示器", () => {
  const stored = sliceFunction(main, "storedWindowBounds");
  assert.match(stored, /readSettings\(\)\.windowBounds/, "位置尺寸要落盘复用现有的 settings");
  // 半个矩形比没有更糟：缺失字段会让窗口开到 NaN 坐标去。
  assert.match(stored, /Number\.isFinite/, "任何一项不是有限数都必须当成没存过");

  const visible = sliceFunction(main, "isVisibleOnSomeDisplay");
  assert.match(visible, /screen\.getAllDisplays\(\)/, "必须拿真实显示器列表来判");
  assert.match(visible, /display\.workArea/, "要比的是工作区，不是整屏（贴边时会被任务栏压住）");

  const create = sliceFunction(main, "createWindow");
  assert.match(
    create,
    /const restore = stored && isVisibleOnSomeDisplay\(stored\) \? stored : null;/,
    "外接显示器拔掉后，窗口会开在一块不存在的屏幕上：任务栏里有图标、点了有反应，但屏幕上什么都没有",
  );
});

test("最大化时存的是还原矩形，不是整屏尺寸", () => {
  const save = sliceFunction(main, "saveWindowBounds");
  assert.match(save, /mainWindow\.isMaximized\(\)/);
  assert.match(save, /getNormalBounds\(\)/, "存 getBounds() 的话，最大化下退出再打开会得到「占满屏幕的普通窗口」，再点最大化看似没反应");
  assert.match(save, /maximized/, "最大化这个状态本身也要记下来");
});

test("位置尺寸的写盘是防抖的", () => {
  const create = sliceFunction(main, "createWindow");
  // 一次拖动会连着触发几十次 resize/move，每次都写一遍 settings.json 就是几十次磁盘写。
  assert.match(create, /clearTimeout\(boundsTimer\)/, "没有防抖：拖动窗口会连着写几十次配置文件");
  assert.match(create, /window\.on\("resize", scheduleSaveBounds\)/);
  assert.match(create, /window\.on\("move", scheduleSaveBounds\)/);
});

// ---------- 图标 ----------

test("图标三处接线都在：build.win、extraResources、BrowserWindow", () => {
  assert.equal(pkg.build.win.icon, "resources/icon.ico", "build.win.icon 没接：exe 与安装包还是 Electron 默认图标");
  assert.equal(pkg.build.nsis.installerIcon, "resources/icon.ico", "安装程序图标没接");
  assert.equal(pkg.build.nsis.uninstallerIcon, "resources/icon.ico", "卸载程序图标没接");
  // build/ 那种 buildResources 目录不会进包，运行期要用的图标必须走 extraResources。
  const extra = pkg.build.extraResources.some(
    (entry) => entry.from === "resources/icon.ico" && entry.to === "icon.ico",
  );
  assert.ok(extra, "extraResources 没有把图标带进包：打包后托盘/窗口图标会读不到");
  assert.ok(existsSync(join(root, "resources", "icon.ico")), "resources/icon.ico 不存在，先跑 npm run icon:make");

  const iconPath = sliceFunction(main, "iconPath");
  assert.match(iconPath, /app\.isPackaged[\s\S]*process\.resourcesPath/, "打包态要从 resourcesPath 读");
  assert.match(iconPath, /resources", "icon\.ico"/, "开发态要从仓库里读");
  const create = sliceFunction(main, "createWindow");
  assert.match(create, /icon: iconPath\(\)/, "BrowserWindow 没接图标：开发时任务栏上是个 Electron 原子");
});

// ---------- 任务栏进度 ----------

test("任务栏进度在同一条 progressReporter 里，命令结束清掉", () => {
  const reporter = sliceFunction(main, "progressReporter");
  assert.match(reporter, /window\.setProgressBar\(/, "任务栏上看不到进度：几百 MB 的下载被别的窗口盖住时完全不知道在干什么");
  assert.match(reporter, /event\.kind === "phase"[\s\S]*?percent \/ 100/, "阶段事件按百分比显示");
  // 下载总量是脚本那边算不出来的，编一个百分比会让进度条先跑到头再跳回去。
  assert.match(reporter, /event\.kind === "download-bytes"[\s\S]*?setProgressBar\(2\)/, "下载阶段应当是不确定态（2）");

  // 清理放在命令 handler 的 finally 里：失败路径同样要清，否则那根条会留在半路，
  // 用户一直以为还在下载。
  const handler = main.match(/ipcMain\.handle\("desktop:command"[\s\S]*?\r?\n\}\);/);
  assert.ok(handler, "找不到 desktop:command 的 handler");
  assert.match(handler[0], /finally \{/, "命令结束必须清理任务栏进度");
  assert.match(handler[0], /setProgressBar\(-1\)/, "命令结束要把进度条清掉");
});

// ---------- 关窗保护 ----------

test("只有会改动系统的长命令才拦关窗", () => {
  const longCommands = main.match(/const LONG_COMMANDS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(longCommands, "找不到 LONG_COMMANDS");
  const names = [...longCommands[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(
    names.sort(),
    ["clear_cached_packages", "download_codex", "install_codex", "launch_codex", "repair_bundles"],    "长命令清单变了：清单外的命令不会被拦，清单内的会被拦",
  );
  // 「检查更新」刻意不在里面：它不改动任何东西，跑到一半关窗完全无害。
  assert.ok(!names.includes("check_update"), "检查更新不该拦关窗：为它弹对话框是把用户当贼防");
  // 「清空缓存」在里面：它是全应用唯一会真的删掉用户数据的命令，删到一半关窗会留下
  // 一个「删了几个、还剩几个」说不清的中间状态。判据是会不会改动系统，不是跑多久。
  assert.ok(names.includes("clear_cached_packages"), "清空缓存要在里面：删到一半关窗会留下一半删一半没删的状态");

  const create = sliceFunction(main, "createWindow");
  assert.match(create, /window\.on\("close"/, "没有 close 拦截：安装到一半关窗不会有任何提醒");
  assert.match(create, /if \(busyCommands > 0\)/, "关窗保护要认在飞的长命令计数");
  assert.match(create, /event\.preventDefault\(\)/, "拦下来必须 preventDefault，否则窗口照样关掉");
});

// ---------- 白名单命令数：文档里那个数字必须是真的 ----------
//
// desktop/README.md 写着「只接受 N 个固定白名单命令」。这个数字**错了两次**：
// 上一批加命令时没改（实际 16、文档写 17），这一批又顺手 +1 写成 18（实际 17）。
// 两次都是「按加一条就 +1」推的，没人真的数过。它不会让任何东西坏掉，所以永远不会有人
// 发现 —— 正好是那种只靠人自觉就一定漂移的数字，改成从源码数出来比对。
test("README 里的白名单命令数与 main.cjs 实际数量一致", () => {
  const allowList = main.match(/const allowedCommands = new Set\(\[([^\]]*)\]\)/);
  assert.ok(allowList, "找不到 allowedCommands");
  const actual = new Set([...allowList[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));

  const claimed = read("README.md").match(/只接受 (\d+) 个固定白名单命令/);
  assert.ok(claimed, "README 里找不到白名单命令数那句");
  assert.equal(
    Number(claimed[1]),
    actual.size,
    `README 说 ${claimed[1]} 个，main.cjs 里实际 ${actual.size} 个：加命令时顺手改一下那个数字`,
  );
  // 顺带钉住「清空缓存」确实在白名单里 —— 界面那颗按钮点了要有人接。
  assert.ok(actual.has("clear_cached_packages"), "清空缓存必须在白名单里");
});

test("计数只在长命令上加减，且退出路径不被拦", () => {
  const handler = main.match(/ipcMain\.handle\("desktop:command"[\s\S]*?\r?\n\}\);/);
  const body = handler[0];
  assert.match(body, /const tracked = LONG_COMMANDS\.has\(command\);/, "计数要按 LONG_COMMANDS 判");
  assert.match(body, /if \(tracked\) busyCommands \+= 1;/, "进命令时要计数");
  assert.match(body, /if \(tracked\) busyCommands -= 1;/, "出命令时（含失败路径）要减回去，否则界面从此关不掉");

  // app.quit() 走的是 close 事件，不置标志的话「托盘 → 退出」会被关窗保护反过来拦下。
  assert.match(main, /app\.on\("before-quit"[\s\S]*?isQuitting = true;/, "缺 before-quit：托盘里的「退出」会被自己拦下来");
});

test("确认框的默认按钮是「继续等待」", () => {
  const confirm = sliceFunction(main, "confirmCloseWhileBusy");
  assert.match(confirm, /showMessageBox/, "缺确认框：用户不知道关掉会发生什么");
  assert.match(confirm, /defaultId: 0/, "默认按钮必须是「继续等待」：回车键落到「仍然关闭」会把装了一半的安装打断");
  assert.match(confirm, /window\.destroy\(\)/, "确认后要用 destroy：close 会再走一遍这个 handler，用户得连点两次");
  assert.match(confirm, /closePromptOpen/, "确认框开着的时候不能再弹第二个");
});

// ---------- 托盘与开机自启 ----------

test("托盘是惰性创建的，且只有真的需要时才出现", () => {
  const ensure = sliceFunction(main, "ensureTray");
  assert.match(ensure, /if \(tray\) return tray;/, "重复创建会让通知区域闪来闪去");
  assert.match(ensure, /new Tray\(icon\)/);
  for (const label of ["显示主界面", "立即检查更新", "退出"]) {
    assert.ok(ensure.includes(label), `托盘菜单缺少「${label}」`);
  }
  assert.match(ensure, /tray\.on\("double-click"/, "双击托盘应当显示主界面");
  // 图标缺失不该让整个应用起不来 —— 托盘只是少一个入口。
  assert.match(ensure, /existsSync\(icon\)/, "创建托盘前要先确认图标存在");
  // 只有「启动就带了 --hidden」才需要一开始就有托盘。
  const create = sliceFunction(main, "createWindow");
  assert.match(create, /if \(startHidden\) ensureTray\(\);/, "带 --hidden 启动时必须建托盘，否则窗口没显示、托盘也没有 = 应用不见了");
});

test("开机自启只在打包态写注册表，且带 --hidden", () => {
  const apply = sliceFunction(main, "applyLoginItem");
  assert.match(apply, /if \(!app\.isPackaged\) return;/, "开发模式下 process.execPath 是 electron.exe，注册它等于往注册表里塞垃圾");
  assert.match(apply, /openAtLogin/, "缺 openAtLogin");
  assert.match(apply, /\["--hidden"\]/, "自启必须带 --hidden：开机就弹一个窗口是骚扰");
  // 注册表项可能被清理软件抹掉，所以每次启动都按落盘值重写一遍。
  assert.match(main, /applyLoginItem\(readSettings\(\)\.launchAtLogin\)/, "启动时要按落盘值补写一次注册表");
  const create = sliceFunction(main, "createWindow");
  assert.match(create, /show: !startHidden/, "--hidden 启动时窗口必须是隐藏的");
});

// ---------- 主题 ----------

test("窗口底色跟随系统主题，切换时也要跟着变", () => {
  const color = sliceFunction(main, "windowBackgroundColor");
  assert.match(color, /nativeTheme\.shouldUseDarkColors/, "深色系统下用浅色底色，打开窗口会闪一下白");
  const create = sliceFunction(main, "createWindow");
  assert.match(create, /backgroundColor: windowBackgroundColor\(\)/, "createWindow 没接上");
  // 系统主题是能在应用开着的时候切换的。
  assert.match(main, /nativeTheme\.on\("updated"/, "系统切换主题后新窗口又会闪白");
});

// ---------- 渲染进程侧 ----------

test("预加载桥把后台复查与真正退出都暴露出去", () => {
  assert.match(preload, /onBackgroundCheck:/, "缺后台复查订阅");
  assert.match(preload, /ipcRenderer\.on\("desktop:background-check"/);
  assert.match(preload, /removeListener\("desktop:background-check"/, "订阅必须可取消，否则热重载会重复累积");
  assert.match(preload, /quit: \(\) => ipcRenderer\.invoke\("desktop:window", "quit"\)/, "缺真正退出的入口");
  assert.match(main, /if \(action === "quit"\) app\.quit\(\);/, "主进程没实现 quit 动作");
});

// ---------- runner ----------

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
