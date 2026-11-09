// 「命令跑着的时候，触发命令的入口必须点不动」。
//
// 用户原话：「交互还是得优化一下，点击检查更新后不应该可以继续点」。
//
// 这个 bug 的形状值得写清楚，因为它不是「按钮忘了置灰」这么简单：
//
//   1. 每条命令各记各的忙标志（phase / probing / repairing），谁都没把「别人正在跑」
//      算进去。于是修复途中还能再点「一键安装」，两条命令叠着跑 —— 一边关 Codex
//      一边装 Codex。
//   2. 「检查更新」最彻底：它压根不置任何标志（它不动安装状态，结果只落在 update
//      和 notice 上）。网络往返那几秒里，按钮全亮着，用户点几次就并发几条检查，
//      结论弹窗也就跟着弹几次。
//   3. 反过来，忙标志漏清比不置更糟：界面会永久锁死，用户只能重启应用。
//
// 所以这里钉三件事：判据只有一处、所有入口都用它、以及标志位一定会在 finally 里清掉。
// 「先点一下看它变没变灰」这种验证只能证明某一个入口，证明不了快捷键绕过去的那条路
// —— 那是 app.ts 的 runAction 在管，本文件直接从源码上钉住它。

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const store = read("src", "state", "app.ts");
const app = read("src", "App.tsx");
const titleBar = read("src", "components", "TitleBar.tsx");
const healthPanel = read("src", "components", "HealthPanel.tsx");
const styles = read("src", "styles.css");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("忙的判据只有一处，且把所有命令都算进去", () => {
  assert.match(store, /export const isCommandRunning = /, "共享判据必须导出，否则各处又会各写一份");
  // 结尾必须是 `\r?\n` 而不是 `\n`：这条断言读的是工作区里的源码字节，而行尾由检出方式决定。
  // Git for Windows 默认 core.autocrlf=true，GitHub 的 windows runner 也是 CRLF —— 只写 `\n` 的话
  // `;` 后面跟着的是 `\r`，正则在 CRLF 检出下永远匹配不上。这正是 CI 上红的那一条。
  const predicate = store.match(/export const isCommandRunning = \(state: \{[^}]+\}\): boolean =>([\s\S]*?);\r?\n/);
  assert.ok(predicate, "找不到 isCommandRunning 的实现");
  const body = predicate[1];
  for (const signal of ["phase === \"working\"", "probing", "repairing", "checkingUpdate"]) {
    assert.ok(body.includes(signal), `isCommandRunning 漏了 ${signal}：少算一种，那种命令跑着时入口就是亮的`);
  }
});

test("「检查更新」必须置位并在 finally 里清掉", () => {
  // 不置位 = 用户抱怨的那个 bug；不清 = 界面永久锁死。两个方向都要钉住。
  assert.match(store, /checkingUpdate: boolean;/, "store 里要有 checkingUpdate 标志位");
  assert.match(store, /checkUpdate: async \(\) => \{[\s\S]*?set\(\{ checkingUpdate: true/, "checkUpdate 开始时必须置位");
  const checkUpdate = store.match(/checkUpdate: async \(\) => \{([\s\S]*?)\n  \},/);
  assert.ok(checkUpdate, "找不到 checkUpdate 的实现");
  const body = checkUpdate[1];
  const finallyBlock = body.match(/finally \{([\s\S]*?)\}/);
  assert.ok(finallyBlock, "checkUpdate 缺少 finally：中途失败就再也不解锁了");
  assert.match(finallyBlock[1], /checkingUpdate: false/, "finally 里必须清掉 checkingUpdate");
});

test("所有会真跑命令的入口都走同一个判据", () => {
  // 快捷键（Ctrl+R / Ctrl+I）由主进程直接发到渲染进程，不经过 DOM。按钮置灰拦不住它，
  // 所以 runAction —— 窗口内菜单和原生菜单的汇合点 —— 必须自己再判一次。
  assert.match(app, /const COMMAND_ACTIONS = new Set\(\["check", "install", "launch", "health", "repair"\]\)/);
  assert.match(
    app,
    /if \(COMMAND_ACTIONS\.has\(action\) && isCommandRunning\(store\)\) return;/,
    "runAction 必须挡住「已有命令在跑」时的新命令",
  );
  // App 里的 busy 必须是共享判据，不能退回 phase === "working"（那正是漏掉检查更新、
  // 健康自检、修复三者的写法）。
  assert.match(app, /const busy = useAppStore\(isCommandRunning\)/, "App 的 busy 必须来自共享判据");
  assert.doesNotMatch(app, /busy=\{working\}/, "主按钮的 busy 不能退回只看 phase === \"working\"");
  // 诊断面板原来自己算 busy = probing || repairing，那样安装中它的按钮还是亮的。
  assert.match(healthPanel, /busy: boolean;/, "HealthPanel 必须接收共享的 busy");
  assert.doesNotMatch(
    healthPanel,
    /const busy = probing \|\| repairing/,
    "HealthPanel 不能再自算 busy，否则安装/检查更新期间它的按钮仍然可点",
  );
});

test("页面按钮：命令入口跟 busy 走，打开目录的即时入口不跟着变灰", () => {
  // 置灰必须按「这一项会不会真跑命令」区分。把「打开日志目录」「复制诊断信息」一起
  // 禁用是帮倒忙 —— 命令跑着的时候正是用户最想点它们去看日志、把现场发出来的时刻。
  for (const [name, source] of [
    ["主区 CTA", app],
    ["诊断面板", healthPanel],
  ]) {
    assert.match(source, /disabled=\{busy\}/, `${name} 的按钮要真的接上共享 busy`);
  }
  // 版本历史里的回退按钮同样走共享判据，而不只是本地的 rollingBack。
  const history = read("src", "components", "VersionHistory.tsx");
  assert.match(history, /disabled=\{busy\}/, "回退按钮要接上共享 busy");
  assert.match(history, /有命令正在执行，等它结束再操作/, "回退按钮置灰要有 title 说明");

  // 即时入口（打开缓存/日志目录、复制诊断）刻意不接 busy。它们跑在 IPC 上，
  // 瞬间返回，不占用安装链路。
  const advanced = read("src", "components", "AdvancedSettings.tsx");
  assert.doesNotMatch(advanced, /disabled=\{busy\}/, "打开目录与复制诊断不该被忙态禁掉");

  // 光置灰不够：样式上要能看出不可点。
  assert.match(styles, /\.btn:disabled,\s*\.button:disabled\s*\{[^}]*cursor:\s*not-allowed/);
});

test("置灰必须给出理由，否则用户看到的是「点了没反应」", () => {
  assert.match(app, /checkingUpdate \? "正在检查…" : "仅检查更新"/, "检查更新期间次按钮要显示进行中");
  assert.match(app, /有命令正在执行，等它结束再操作/, "主区按钮置灰要有 title 说明");
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
