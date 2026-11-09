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

test("布局：窗口按钮在固定顶栏里，且就是那三颗红绿灯", () => {
  // 重新设计之后，窗口操作全部由标题栏左侧的三颗圆点承担：红色关闭、黄色最小化、
  // 绿色最大化/还原。它们必须待在 .topbar 里（固定、不随内容滚动），不能退回卡片装饰。
  const header = titleBarSource.match(/<header className="topbar"[\s\S]*?<\/header>/);
  assert.ok(header, "找不到 .topbar");
  assert.match(header[0], /<WindowControls \/>/, "窗口按钮必须留在顶栏里");

  assert.match(stylesSource, /\.window-control\.red[^}]*#ff5f57/);
  assert.match(stylesSource, /\.window-control\.yellow[^}]*#febc2e/);
  assert.match(stylesSource, /\.window-control\.green[^}]*#28c840/);

  // 装饰性的卡片圆点随旧布局一起删掉，否则同一个界面里会出现两套「窗口按钮」。
  assert.doesNotMatch(stylesSource, /\.window-head::before/);

  assert.doesNotMatch(titleBarSource, /brand-sub/, "副标题已按需求去掉");
  assert.doesNotMatch(stylesSource, /\.brand-sub/, "副标题的样式也应一并清掉");
});

test("导航：旧顶栏菜单被侧栏取代，原生快捷键仍然保留", () => {
  // 操作/诊断下拉菜单在改版里被左侧导航取代。四组入口由 Sidebar 提供，
  // 顶栏不再承载菜单 —— 但主进程那条只留快捷键的原生菜单不能被一起删掉。
  const sidebar = read("src", "components", "Sidebar.tsx");
  const ids = [...sidebar.matchAll(/id:\s*"(overview|diagnostics|history|settings)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, ["overview", "diagnostics", "history", "settings"], `侧栏入口应为 概览/诊断/版本历史/设置，实际 ${ids.join(" / ")}`);
  assert.doesNotMatch(titleBarSource, /MENU_GROUPS|menu-trigger|menu-popover/, "顶栏不该再留着旧菜单");

  // 原生菜单栏在 frame:false 下不显示，它留下来只是为了快捷键，不能被一起删掉。
  assert.match(
    mainSource,
    /label:\s*"窗口"[\s\S]{0,400}CmdOrCtrl\+W/,
    "原生菜单必须保留窗口命令的快捷键（Ctrl+W / Ctrl+M）",
  );
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
  // 窗口是无边框的（frame: false + autoHideMenuBar），原生菜单栏根本不显示，
  // 所以侧栏是「检查更新 / 一键安装 / 诊断 / 设置」唯一的可见入口。窄窗口下把它
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

test("布局：窄窗口下顶栏三块不打架（标题 / 状态胶囊 / 上次检查）", () => {
  // 顶栏是「红绿灯 + 居中标题 + 右侧状态」三块抢同一行宽度。默认 1120 宽够用，
  // 但窗口能缩到 760：右侧再挂着「上次检查」就会压到居中标题上。胶囊本身也必须有
  // 上限，否则长版本号会一路往左顶。
  const css = stylesSource.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /\.status-chip\s*\{[^}]*max-width:\s*360px/);
  assert.match(css, /\.status-chip\s*\{[^}]*text-overflow:\s*ellipsis/);

  const block = (width) => {
    const start = css.indexOf(`@media (max-width: ${width}px)`);
    assert.ok(start >= 0, `找不到 ${width}px 断点`);
    let depth = 0;
    for (let index = css.indexOf("{", start); index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) return css.slice(start, index);
      }
    }
    throw new Error(`${width}px 断点没有闭合`);
  };
  // 1100px 以下先收掉次要的「上次检查」，并把胶囊压到 320；
  // 930px 以下继续压到 290，给居中的「Codex Updater」让出位置。
  assert.match(block(1100), /\.last-check\s*\{[^}]*display:\s*none/);
  assert.match(block(1100), /\.status-chip\s*\{[^}]*max-width:\s*320px/);
  assert.match(block(930), /\.status-chip\s*\{[^}]*max-width:\s*290px/);
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
  // 默认 1120×780 在 1280×800@150% 的笔记本上比工作区还高；从外接大屏切回来时
  // 上次存的大矩形也可能超出。Windows 不会替你挪回来，底部内容就落在屏幕外了。
  assert.match(mainSource, /screen\.getDisplayMatching\(restore\)[\s\S]{0,80}screen\.getPrimaryDisplay\(\)/);
  assert.match(mainSource, /\.workArea/);
  const create = mainSource.match(/async function createWindow\(\) \{[\s\S]*?const window = new BrowserWindow\(\{([\s\S]*?)\n  \}\);/);
  assert.ok(create, "找不到 createWindow 的 BrowserWindow 配置");
  const options = create[1];
  assert.match(options, /width,/, "宽度必须用收进工作区后的值");
  assert.match(options, /height,/, "高度必须用收进工作区后的值");
  assert.doesNotMatch(options, /width:\s*restore \? restore\.width/, "不能把存的宽度原样交给 Windows");
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
