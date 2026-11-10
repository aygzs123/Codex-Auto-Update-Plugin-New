// 窗口按钮与固定顶栏的接线测试。纯 node，不依赖 electron，用 `npm test` 跑。
//
// 这两块在 verify:render 里是**测不到的**：渲染冒烟测试自己造 BrowserWindow、
// 自己用桩替换 IPC，所以主进程真的有没有处理 is-maximized、最大化事件有没有推给
// 渲染进程，它一概看不见。这里用源码契约把接线钉住：
//
//   1. 最大化按钮要显示「还原」图标，就必须能读到当前状态（is-maximized 查询）
//      并且订阅后续变化（maximize / unmaximize → desktop:window-state）。
//      少了任何一半，双击标题栏最大化后图标就会停在「最大化」上。
//   2. 图标用 SVG 而不是字体符号。− □ × 的基线和对齐随字体变，而「还原」需要的
//      双矩形根本没有对应字符，所以这既是美观问题也是正确性问题。
//   3. 窗口按钮的可点区域不能退回 14px。这不是纯审美：14px 远小于可用的点击目标。
//   4. 窗口按钮在顶栏（固定），卡片标题栏上那三个 mac 圆点只是装饰。

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const mainSource = read("electron", "main.cjs");
const preloadSource = read("electron", "preload.cjs");
const titleBarSource = read("src", "components", "TitleBar.tsx");
const stylesSource = read("src", "styles.css");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- 主进程 ----------

test("主进程：is-maximized 查询返回窗口真实状态", () => {
  assert.match(mainSource, /action === "is-maximized"[\s\S]{0,80}window\.isMaximized\(\)/);
});

test("主进程：最大化与还原都推送状态，且走同一个发布函数", () => {
  // 两个事件必须都接上：只接 maximize 的话，还原之后图标不会变回「最大化」。
  const maximize = mainSource.match(/window\.on\("maximize",\s*(\w+)\)/);
  const unmaximize = mainSource.match(/window\.on\("unmaximize",\s*(\w+)\)/);
  assert.ok(maximize, "缺少 maximize 事件订阅");
  assert.ok(unmaximize, "缺少 unmaximize 事件订阅");
  assert.equal(maximize[1], unmaximize[1], "两个事件必须调用同一个发布函数，否则状态会漂移");
  assert.match(mainSource, new RegExp(`${maximize[1]}[\\s\\S]{0,240}desktop:window-state`));
});

// ---------- 预加载桥 ----------

test("预加载：window 桥暴露 isMaximized 与 onStateChange，且订阅可取消", () => {
  assert.match(preloadSource, /isMaximized:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("desktop:window",\s*"is-maximized"\)/);
  assert.match(preloadSource, /onStateChange:/);
  assert.match(preloadSource, /ipcRenderer\.on\("desktop:window-state"/);
  // 返回退订函数是约定：TitleBar 在卸载时要摘掉监听，不然会重复累积。
  assert.match(preloadSource, /removeListener\("desktop:window-state"/);
});

// ---------- 渲染进程 ----------

test("渲染进程：初始值查一次、后续变化靠订阅（不本地猜测）", () => {
  assert.match(titleBarSource, /controls\.isMaximized\(\)/);
  assert.match(titleBarSource, /controls\.onStateChange\(/);
  assert.match(titleBarSource, /useEffect\(/);
});

test("渲染进程：图标是 SVG，没有退回字体符号", () => {
  assert.match(titleBarSource, /<svg/);
  assert.doesNotMatch(titleBarSource, /window-dot/);
  // 老实现用 ::after + content 画 − □ ×，这类规则必须彻底消失。
  assert.doesNotMatch(stylesSource, /window-dot/);
  assert.doesNotMatch(stylesSource, /content:\s*"[−□×]/);
});

test("样式：窗口按钮仍是三个，且可点区域不小于 32×28", () => {
  // 只数按钮：容器是 .window-controls（复数），所以空格/引号必须跟紧在单数类名之后。
  const controls = titleBarSource.match(/className="window-control(?:\s[^"]*)?"/g) ?? [];
  assert.equal(controls.length, 3, `窗口按钮应为 3 个，实际 ${controls.length} 个`);

  const rule = stylesSource.match(/\.window-control\s*\{([^}]*)\}/);
  assert.ok(rule, "找不到 .window-control 规则");
  const width = Number(rule[1].match(/width:\s*(\d+)px/)?.[1]);
  const height = Number(rule[1].match(/height:\s*(\d+)px/)?.[1]);
  assert.ok(width >= 32, `窗口按钮宽度过小：${width}px`);
  assert.ok(height >= 28, `窗口按钮高度过小：${height}px`);
});

test("布局：三颗 mac 圆点在左上角纯装饰，真正的窗口按钮在右上角", () => {
  // 左侧：红黄绿三颗圆点，只是还原 mac 的辨识度（aria-hidden，不是按钮）。
  // 右侧：最小化 / 最大化（还原）/ 关闭，顺序按 Windows 惯例。两处不能混在一起 ——
  // 把彩点做成按钮既和右侧重复，又把「关闭」放到了最左边。
  const header = titleBarSource.match(/<header className="topbar"[\s\S]*?<\/header>/);
  assert.ok(header, "找不到 .topbar");

  const left = header[0].indexOf('className="topbar-left"');
  const right = header[0].indexOf('className="topbar-actions"');
  const lights = header[0].indexOf("<TrafficLights />");
  const controls = header[0].indexOf("<WindowControls />");
  assert.ok(left >= 0 && right >= 0 && lights >= 0 && controls >= 0, "顶栏结构不完整");
  assert.ok(left < right, "彩点在左、操作区在右");
  assert.ok(lights > left && lights < right, "彩点必须在左侧区里");
  assert.ok(controls > right, "窗口按钮必须在操作区里");

  // 彩点是 span，不是 button；三个颜色各一颗。
  const traffic = titleBarSource.match(/className="traffic"[\s\S]*?<\/div>/);
  assert.ok(traffic, "找不到装饰用的 .traffic");
  assert.match(traffic[0], /aria-hidden="true"/);
  for (const color of ["red", "yellow", "green"]) {
    assert.match(traffic[0], new RegExp(`className="traffic-dot ${color}"`));
  }
  assert.doesNotMatch(traffic[0], /<button/);

  // 按钮顺序：最小化 → 最大化 → 关闭。
  const order = [...titleBarSource.matchAll(/className="window-control (\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, ["minimize", "maximize", "close"], `按钮顺序应为 最小化/最大化/关闭，实际 ${order.join(" / ")}`);

  // 装饰性的卡片圆点随旧布局一起删掉，否则同一个界面里会出现两套「窗口按钮」。
  assert.doesNotMatch(stylesSource, /\.window-head::before/);

  assert.doesNotMatch(titleBarSource, /brand-sub/, "副标题已按需求去掉");
  assert.doesNotMatch(stylesSource, /\.brand-sub/, "副标题的样式也应一并清掉");
});

test("导航：旧顶栏菜单被侧栏取代", () => {
  // 操作/诊断下拉菜单在改版里被左侧导航取代。四组入口由 Sidebar 提供，
  // 顶栏不再承载菜单。
  const sidebar = read("src", "components", "Sidebar.tsx");
  const ids = [...sidebar.matchAll(/id:\s*"(overview|diagnostics|history|settings)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, ["overview", "diagnostics", "history", "settings"], `侧栏入口应为 概览/诊断/版本历史/设置，实际 ${ids.join(" / ")}`);
  assert.doesNotMatch(titleBarSource, /MENU_GROUPS|menu-trigger|menu-popover/, "顶栏不该再留着旧菜单");
});

test("菜单：应用菜单被整块清空，不再有原生 File / Edit", () => {
  // 无边框窗口（frame: false）并不保证原生菜单栏一定不出现 —— 只要没显式清空，
  // Windows 上就可能露出 Electron 默认的 File / Edit 那一套。用户看到过一次，
  // 所以这里钉死：应用菜单必须是 null，而不是某套自建菜单。
  assert.match(mainSource, /Menu\.setApplicationMenu\(null\)/, "必须显式清空应用菜单");
  // 托盘右键菜单仍然要用 buildFromTemplate，所以只禁止把它装成**应用菜单**。
  assert.doesNotMatch(mainSource, /setApplicationMenu\(\s*Menu\.buildFromTemplate/, "不应再构建应用菜单");
  assert.doesNotMatch(mainSource, /createApplicationMenu/, "旧的菜单构建函数必须删掉");
});

test("快捷键：菜单删掉后由主进程自己接管 Ctrl+R / I / M / W", () => {
  // 这几个组合以前是菜单的 accelerator 顺带提供的。菜单清空之后如果不接回来，
  // 用户按了会静默无反应 —— 而且 Ctrl+R 还会退回 Chromium 的刷新页面。
  assert.match(mainSource, /before-input-event/, "缺少键盘接管");
  const map = mainSource.match(/const SHORTCUT_ACTIONS = \{([\s\S]*?)\};/);
  assert.ok(map, "找不到快捷键映射");
  for (const [key, action] of [
    ["r", "check"],
    ["i", "install"],
    ["m", "minimize"],
    ["w", "close"],
  ]) {
    assert.match(map[1], new RegExp(`\\b${key}:\\s*"${action}"`), `Ctrl+${key.toUpperCase()} 必须映射到 ${action}`);
  }
  assert.match(mainSource, /event\.preventDefault\(\)/, "必须拦掉 Chromium 的默认行为（尤其 Ctrl+R）");
});

// ---------- 固定顶栏 ----------

test("布局：标题栏在滚动容器之外，且内容区自己滚", () => {
  // 顶栏一旦落进滚动容器，往下滚就被内容顶走 —— 滚到底部时连关闭按钮都点不到。
  const app = read("src", "App.tsx");
  const shell = app.match(/<div className="app-shell"[\s\S]*?<main className="content-inner">/);
  assert.ok(shell, "找不到 app-shell → content-inner 的结构");
  assert.match(shell[0], /<TitleBar/, "TitleBar 必须在 .app-scroll 之前、滚动容器之外");
  assert.match(shell[0], /className="app-scroll"/, "内容区缺少 .app-scroll 滚动容器");

  assert.match(stylesSource, /\.app-scroll\s*\{[^}]*overflow-y:\s*auto/);
  // body 不能再有滚动条，否则顶栏之外的整页滚动会让固定布局失效。
  assert.match(stylesSource, /body\s*\{[^}]*overflow:\s*hidden/);
});

test("布局：窄窗口下也不许藏掉侧栏导航", () => {
  // 应用没有菜单栏，侧栏是「检查更新 / 一键安装 / 诊断 / 设置」唯一的可见入口。窄窗口下把它
  // display:none 掉，等于用户把窗口拖小之后就再也点不到这些页面了。
  // 先剥掉注释，避免断言被说明文字里引用的选择器绊倒。
  const css = stylesSource.replace(/\/\*[\s\S]*?\*\//g, "");
  const start = css.indexOf("@media (max-width: 760px)");
  assert.ok(start >= 0, "找不到窄窗口断点");
  let depth = 0;
  let end = start;
  for (let index = css.indexOf("{", start); index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  const narrow = css.slice(start, end);
  assert.doesNotMatch(narrow, /\.sidebar\s*\{[^}]*display:\s*none/);
});

test("布局：顶栏左彩点右按钮，不再重复主区的版本结论", () => {
  // 顶栏原先塞了「红绿灯 + 居中品牌 + 状态胶囊 + 上次检查」，窗口一窄就互相挤，
  // 胶囊里的版本号还会被截断。现在左边只剩装饰彩点、右边只剩公告铃铛与窗口按钮，
  // 结论统一由主区给。两端分开靠 space-between 撑开。
  const css = stylesSource.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /\.topbar\s*\{[^}]*justify-content:\s*space-between/);
  assert.match(css, /\.topbar-actions\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.topbar-actions\s*\{[^}]*gap:/);
  // 状态胶囊整块删除：留着就还有第二处版本结论，迟早和主区分家。
  assert.doesNotMatch(css, /\.status-chip\s*\{/);
  assert.doesNotMatch(titleBarSource, /statusSlot|status-chip/);
});

// ---------- 桌面端滚动 ----------

test("滚动：切页回到顶部，键盘也能滚内容区", () => {
  // 内容区是独立的滚动容器（body 是 overflow:hidden）。不重置 scrollTop 的话，
  // 从设置页底部切回概览会停在半截；不接管 PageUp/PageDown/Home/End 的话，
  // 默认滚动的是文档，等于按了没反应 —— 这两条在浏览器里不会出现，是桌面端才有的。
  const app = read("src", "App.tsx");
  assert.match(app, /useRef<HTMLDivElement>\(null\)/, "滚动容器要有引用");
  assert.match(app, /scrollRef\.current\?\.scrollTo\(\{ top: 0 \}\)/, "切页要回顶部");
  assert.match(app, /ref=\{scrollRef\}/, "引用要真的挂到 .app-scroll 上");
  assert.match(app, /"PageDown"/);
  assert.match(app, /"PageUp"/);
  assert.match(app, /"Home"/);
  assert.match(app, /"End"/);
  // 输入框里按 Home/End 是移动光标，不能被抢走；对话框打开时也不该滚背景。
  assert.match(app, /closest\("input, textarea, select, \[contenteditable='true'\]"\)/);
  assert.match(app, /useAppStore\.getState\(\)\.notice/);
});

test("窗口：初始矩形收进显示器工作区，不把窗口底边放到屏幕外", () => {
  // 默认 1180×860 在 1280×800@150% 的笔记本上比工作区还高；从外接大屏切回来时
  // 上次存的大矩形也可能超出。Windows 不会替你挪回来，底部内容就落在屏幕外了。
  assert.match(mainSource, /screen\.getDisplayMatching\(restore\)[\s\S]{0,80}screen\.getPrimaryDisplay\(\)/);
  assert.match(mainSource, /\.workArea/);
  const create = mainSource.match(/async function createWindow\(\) \{[\s\S]*?const window = new BrowserWindow\(\{([\s\S]*?)\n  \}\);/);
  assert.ok(create, "找不到 createWindow 的 BrowserWindow 配置");
  const options = create[1];
  assert.match(options, /width,/, "宽度必须用收进工作区后的值");
  assert.match(options, /height,/, "高度必须用收进工作区后的值");
  assert.doesNotMatch(options, /width:\s*restore \? restore\.width/, "不能把存的宽度原样交给 Windows");
  // 存的矩形比工作区大时改用默认尺寸居中，而不是裁成「顶满工作区」——
  // 后者会得到一扇比上次拖动还小、却像最大化的窗口。
  assert.match(
    mainSource,
    /const fits = Boolean\(restore\) && restore\.width <= area\.width && restore\.height <= area\.height/,
    "没有先判断存的矩形能否放进工作区",
  );
  assert.match(mainSource, /fits \? restore\.width : DEFAULT_WIDTH/, "放不下时没有退回默认宽度");
  assert.match(mainSource, /fits \? restore\.height : DEFAULT_HEIGHT/, "放不下时没有退回默认高度");
});

test("窗口：混合缩放显示器上，创建后要重钉矩形再显示", () => {
  // 主屏 150% + 副屏 100% 时，BrowserWindow 创建时传进去的 DIP 尺寸会先按主屏
  // 工作区裁一次、再按主屏缩放折一次：请求 1049×852 实际得到 700×501，打开后
  // 右半边和下半截都在窗口外 —— 用户看到的就是「显示不全」。窗口建好之后
  // setBounds 用的是目标屏幕真实的 DIP 尺寸，所以必须隐藏创建、重钉、再显示。
  assert.match(mainSource, /show:\s*false,/, "创建时必须先隐藏，等矩形钉准再显示");
  assert.match(mainSource, /window\.setBounds\(targetBounds\)/, "缺少建好后重钉窗口矩形的步骤");
  assert.match(
    mainSource,
    /if \(restore && restore\.maximized\) window\.maximize\(\);[\s\S]{0,120}else if \(!startHidden\) window\.show\(\);/,
    "钉好矩形之后才显示窗口",
  );
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
