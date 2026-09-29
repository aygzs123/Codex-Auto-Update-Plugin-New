// 窗口按钮与固定顶栏的接线测试。纯 node，不依赖 electron，用 `npm test` 跑。
//
// 这两块在 verify:render 里是**测不到的**：渲染冒烟测试自己造 BrowserWindow、
// 自己用桩替换 IPC，所以主进程真的有没有处理 is-maximized、最大化事件有没有推给
// 渲染进程，它一概看不见。这里用源码契约把接线钉住：
//
//   1. 最大化按钮要显示「还原」图标，就必��能读到当前状态（is-maximized 查询）
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

test("布局：装饰圆点在内容区卡片里，顶栏不再有副标题", () => {
  // 卡片标题栏上的 mac 圆点是装饰（原型 .window-head::before 就是纯装饰）：
  // 卡片在滚动容器里，往下滚就跟着走了，所以它不能承担窗口操作。
  const dot = stylesSource.match(/\.window-head::before\s*\{([^}]*)\}/);
  assert.ok(dot, "找不到卡片上的装饰圆点规则 .window-head::before");
  assert.match(dot[1], /border-radius:\s*50%/);
  assert.match(dot[1], /#ff5f57/, "圆点应以 macOS 的红色为基准色");
  assert.match(dot[1], /box-shadow:[^;]*#febc2e[^;]*#28c840/, "另外两个圆点应由 box-shadow 画出（黄、绿）");

  // 装饰就是装饰：这三条规则一旦沾上 pointer / cursor:pointer，用户就会去点它。
  assert.doesNotMatch(dot[1], /cursor:\s*pointer/, "装饰圆点不该有可点的鼠标指针");

  // 真正能操作窗口的按钮必须在顶栏（固定、不随内容滚动）里。
  const header = titleBarSource.match(/<header className="topbar"[\s\S]*?<\/header>/);
  assert.ok(header, "找不到 .topbar");
  assert.match(header[0], /<WindowControls \/>/, "窗口按钮必须留在顶栏里");

  assert.doesNotMatch(titleBarSource, /brand-sub/, "副标题已按需求去掉");
  assert.doesNotMatch(stylesSource, /\.brand-sub/, "副标题的样式也应一并清掉");
});

test("菜单：顶栏只留「操作」和「诊断」两组", () => {
  // 窗口命令由右上角的按钮承担，菜单里再来一组就是重复入口，也和「只保留 2 个」不符。
  const groups = [...titleBarSource.matchAll(/label:\s*"([^"]+)",\s*\n\s*items:/g)].map((match) => match[1]);
  assert.deepEqual(groups, ["操作", "诊断"], `顶栏菜单分组应为 操作 / 诊断，实际 ${groups.join(" / ")}`);

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
  const shell = app.match(/<div className="app-shell"[\s\S]*?<main className="window">/);
  assert.ok(shell, "找不到 app-shell → window 的结构");
  assert.match(shell[0], /<TitleBar/, "TitleBar 必须在 .app-scroll 之前、滚动容器之外");
  assert.match(shell[0], /className="app-scroll"/, "内容区缺少 .app-scroll 滚动容器");

  assert.match(stylesSource, /\.app-scroll\s*\{[^}]*overflow-y:\s*auto/);
  // body 不能再有滚动条，否则顶栏之外的整页滚动会让固定布局失效。
  assert.match(stylesSource, /body\s*\{[^}]*overflow:\s*hidden/);
});

test("布局：窄窗口下也不许藏掉顶栏菜单", () => {
  // 窗口是无边框的（frame: false + autoHideMenuBar），原生菜单栏根本不显示，
  // 所以顶栏这个菜单是「检查更新 / 一键安装 / 诊断」唯一的可见入口。窄窗口下把它
  // display:none 掉，等于用户把窗口拖小之后就再也点不到这些命令了。
  // 先剥掉注释：说明这条规则的注释本身就写着 `.app-menu { display: none }`，
  // 不剥的话断言会被自己的注释绊倒。
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
  assert.doesNotMatch(narrow, /\.app-menu\s*\{[^}]*display:\s*none/);
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
