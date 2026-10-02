// 「同事装上之后不用再想起它」这件事的边界。
//
// 这批功能的危险不在写错，而在**写多**：一个默认开机自启、发现新版就直接装的更新器，和流氓
// 软件没有区别。所以这个文件盯的是三道闸门：
//   1. 两个开关默认关、落盘按键分别写（拨一下开关不能把别的设置抹掉）；
//   2. 发现新版本**只弹一条通知**，同一版本只弹一次，且绝不带安装动作；
//   3. 后台复查定时器只在真的开了后台模式时才存在，且复用启动时那条检查路径。

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const main = read("electron", "main.cjs");
const app = read("src", "state", "app.ts");
const types = read("src", "types.ts");
const card = read("src", "components", "BackgroundSettings.tsx");
const preload = read("electron", "preload.cjs");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function sliceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `找不到 ${name}`);
  const rest = source.slice(start);
  const end = rest.search(/\r?\n\}\r?\n/);
  assert.notEqual(end, -1, `${name} 的结尾找不到`);
  return rest.slice(0, end);
}

// ---------- 落盘 ----------

test("save_settings 按 args 里实际出现的键组 patch", () => {
  const save = main.match(/case "save_settings": \{[\s\S]*?\r?\n    \}/);
  assert.ok(save, "找不到 save_settings 分支");
  const body = save[0];

  for (const key of ["downloadDirectory", "minimizeToTray", "launchAtLogin"]) {
    assert.ok(body.includes(`if ("${key}" in args)`), `${key} 没有按「键出现了才写」处理`);
  }
  // writeSettings 是浅合并，而定长对象在缺键时会写成 undefined/空串 —— 用户只是拨了一下
  // 「开机自启」，自定义缓存目录就被悄悄抹掉了。
  assert.ok(
    !/writeSettings\(\{\s*downloadDirectory:/.test(body),
    "不能把 patch 写成定长对象：拨一个开关会把别的设置一起覆盖掉",
  );
  assert.match(body, /Boolean\(args\.minimizeToTray\)/, "开关值必须 Boolean 化，别把字符串 'false' 当真值存进去");
  assert.match(body, /Boolean\(args\.launchAtLogin\)/);
});

test("拨开关要真的动系统，不只是落盘", () => {
  const save = main.match(/case "save_settings": \{[\s\S]*?\r?\n    \}/)[0];
  assert.match(save, /applyLoginItem\(saved\.launchAtLogin\)/, "开了自启只写配置文件的话，注册表里什么都没有");
  assert.match(save, /applyBackgroundTimer\(\)/, "改了开关要起/停后台定时器");
  // 读回来的值要以主进程落盘的为准（它可能做了 Boolean 化），所以渲染进程是回读而不是本地合并。
  assert.match(app, /await invokeCommand<Settings>\("save_settings", patch\)/, "渲染进程要把 patch 发给主进程");
  assert.match(app, /const settings = await invokeCommand<Settings>\("get_settings"\)/, "写完要回读，不能本地合并");
});

test("两个开关在类型里是可选的，默认就是关", () => {
  assert.match(types, /minimizeToTray\?: boolean;/, "类型里缺 minimizeToTray");
  assert.match(types, /launchAtLogin\?: boolean;/, "类型里缺 launchAtLogin");
  assert.match(types, /lastNotifiedVersion\?: string;/, "类型里缺 lastNotifiedVersion");
  // 卡片里两个 checkbox 都按 `=== true` 判：字段缺失（老配置文件）时必须显示为未勾选，
  // 而不是被 `undefined` 当假值时让 React 报「非受控组件」。
  assert.match(card, /checked=\{settings\.minimizeToTray === true\}/);
  assert.match(card, /checked=\{settings\.launchAtLogin === true\}/);
});

// ---------- 通知 ----------

test("notify_update 的三道判据缺一不可", () => {
  const notify = sliceFunction(main, "notifyUpdate");
  assert.match(notify, /const version = String\(args\.version \|\| ""\);[\s\S]*?if \(!version\)/, "没有版本号就没有通知");
  // 判据一：用户正盯着界面时，顶栏已经写着「可更新到 X」，再弹一条是重复打扰。
  assert.match(
    notify,
    /isVisible\(\) && mainWindow\.isFocused\(\)/,
    "窗口可见且聚焦时要跳过：用户正看着界面，通知是纯打扰",
  );
  // 判据二：同一个版本只提醒一次。
  assert.match(notify, /lastNotifiedVersion === version/, "没有「同一版本只提醒一次」：开机三次提醒三次，用户会把通知关掉");
  // 判据三：系统得支持。
  assert.match(notify, /Notification\.isSupported\(\)/, "要先问系统支不支持通知");
});

test("通知只在弹出成功之后才记账，且点开只是显示窗口", () => {
  const notify = sliceFunction(main, "notifyUpdate");
  const showAt = notify.indexOf("notification.show()");
  const recordAt = notify.indexOf("writeSettings({ lastNotifiedVersion: version })");
  assert.notEqual(showAt, -1, "没有调用 show()");
  assert.notEqual(recordAt, -1, "没有记下已经提醒过的版本");
  assert.ok(showAt < recordAt, "先记账再弹的话，弹失败（被系统静音）也会被当成提醒过，这个版本就再也不提醒了");
  assert.match(notify, /notification\.on\("click", \(\) => showMainWindow\(\)\)/, "点通知应当打开窗口");
  // 需要提权的安装永远由人点（AGENTS.md：后台运行绝不弹 UAC）。
  assert.ok(!/install|Add-AppxPackage|review_bundles/.test(notify), "通知里不能带任何安装动作：后台运行不得触发需要提权的操作");
});

test("只有发现新版本才提醒，且提醒失败不留痕迹", () => {
  assert.match(
    app,
    /if \(update\.updateAvailable && update\.availableVersion\) \{[\s\S]*?notify_update/,
    "应当只在「可更新且有版本号」时调 notify_update",
  );
  assert.match(app, /notify_update", \{ version: update\.availableVersion \}\)\.catch\(\(\) => \{\}\)/, "通知发不出去不该在界面上留下错误");
});

test("Windows 上要先设 AUMID，否则通知根本不显示", () => {
  assert.match(main, /app\.setAppUserModelId\(/, "没有 AppUserModelID 的话 Windows 会静默丢掉这条通知");
});

// ---------- 后台复查 ----------

test("后台复查定时器只在开了后台模式时存在", () => {
  assert.match(main, /const BACKGROUND_CHECK_INTERVAL_MS = 6 \* 60 \* 60 \* 1000;/, "间隔应当是 6 小时");
  const apply = sliceFunction(main, "applyBackgroundTimer");
  // 先无条件清掉旧的，再按新设置决定要不要起 —— 这样「关掉开关」才能真正停掉它。
  assert.match(apply, /clearInterval\(backgroundTimer\)[\s\S]*?backgroundTimer = null;[\s\S]*?const settings = readSettings\(\);/);
  assert.match(
    apply,
    /if \(!settings\.minimizeToTray && !settings\.launchAtLogin\) return;/,
    "两个开关都关着时进程随窗口一起退出，定时器纯属多余",
  );
  assert.match(apply, /setInterval\(/, "缺定时器");
  assert.match(apply, /"desktop:background-check"/, "定时器要通知渲染进程去查");
  // 进程被关掉时定时器没有意义，而且它不该拖住退出。
  assert.match(main, /new BrowserWindow|getAllWindows\(\)[\s\S]{0,200}isDestroyed\(\)/, "发消息前要确认窗口还活着");
});

test("后台复查复用启动时那条检查路径，不新开第二条", () => {
  const connect = sliceFunction(app, "connectBackgroundCheck");
  assert.match(connect, /subscribeBackgroundCheck\(/, "要订阅主进程的敲门");
  assert.match(connect, /autoCheckUpdate\(\)/, "敲门的处理必须是复用 autoCheckUpdate —— 新写一条检查路径就是第二处会走网络的代码");
  assert.match(app, /export function connectBackgroundCheck\(\): \(\) => void/);
  assert.match(preload, /onBackgroundCheck:/, "预加载桥没暴露订阅");
});

// ---------- 文案 ----------

test("设置卡片说清了「不会自动安装」", () => {
  assert.match(card, /不会自动安装任何东西/, "这句不能省：它最容易被误会成「开了就会自动装」");
  assert.match(card, /默认关闭/, "要写明默认关");
  assert.match(card, /需要管理员[\s\S]*?永远由你自己点/, "要说清需要提权的安装仍然要人点");
  assert.match(card, /只提醒一次/, "要说清同一版本不反复提醒");
  // 开发模式下没有带 AUMID 的快捷方式，通知不一定弹得出来 —— 这个坑不写出来就会被当成 bug 报。
  assert.match(card, /AppUserModelID/, "要写明通知在开发模式下不一定显示");
});

// ---------- 剪贴板白名单 ----------

test("白名单里只有「写剪贴板」，没有「读剪贴板」", () => {
  const list = main.match(/const allowedCommands = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(list, "找不到 allowedCommands");
  assert.ok(list[1].includes('"copy_text"'), "copy_text 不在白名单里，渲染进程调不动");
  assert.ok(list[1].includes('"notify_update"'), "notify_update 不在白名单里");
  assert.ok(!/read_text|readClipboard/.test(list[1]), "能读走用户剪贴板内容的接口没有任何存在的理由");

  assert.match(main, /clipboard\.writeText\(text\)/, "缺写入实现");
  assert.match(main, /if \(!text\) throw new Error/, "空文本要报错，而不是把剪贴板清空");
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
