// 命令结果的呈现方式：必须是居中的模态对话框，不能退回右下角 toast。
//
// 这条是用户直接提的：「能不能改成弹窗的形式，不然出现在右下角不太能知道情况」。
// toast 的问题不是难看，是**会被漏掉**：用户点完按钮，视线还在主区按钮附近，而 toast
// 出现在视线的另一头（右下角）、还得自己去点一下才消失。可它承载的是命令唯一的反馈
// ——「已经是最新版本，无需安装」「Codex 已启动」「资源副本已重建」。漏一条，用户就
// 不知道刚才那一下到底做了什么。所以这里把「是模态」「能关掉」「浮在最上层」钉住。

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const appSource = read("src", "App.tsx");
const dialogSource = read("src", "components", "NoticeDialog.tsx");
const stylesSource = read("src", "styles.css");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("渲染进程：结果提示走模态对话框，右下角 toast 已彻底移除", () => {
  assert.match(appSource, /<NoticeDialog\s/, "App 必须渲染 NoticeDialog");
  // toast 的两半都得消失：DOM 里那个按钮，和它的样式规则。留着样式就会被再次用上。
  assert.doesNotMatch(appSource, /className="toast/, "不该再有 toast 按钮");
  assert.doesNotMatch(stylesSource, /\.toast\s*\{/, "toast 的定位样式应一并删掉");
  // 右下角定位是这条需求的核心：不能再有贴右下角的固定浮层。
  assert.doesNotMatch(stylesSource, /position:\s*fixed;[^}]*bottom:\s*22px/, "不该再有贴右下角的提示浮层");
});

test("渲染进程：对话框是模态语义，能被读屏正确识别", () => {
  assert.match(dialogSource, /role="dialog"/);
  assert.match(dialogSource, /aria-modal="true"/);
  // aria-labelledby 指向的 id 必须真的存在，否则读屏会读出一个没有名字的对话框。
  const labelledBy = dialogSource.match(/aria-labelledby="([^"]+)"/)?.[1];
  assert.ok(labelledBy, "缺少 aria-labelledby");
  assert.match(dialogSource, new RegExp(`id="${labelledBy}"`), `aria-labelledby 指向的 ${labelledBy} 不存在`);
});

test("渲染进程：三种关闭方式都在，且打开时焦点落在确认按钮上", () => {
  // 只能点按钮关是不够的：键盘用户按 Esc 关不掉，就等于被对话框困住。
  assert.match(dialogSource, /event\.key === "Escape"/, "必须支持 Esc 关闭");
  assert.match(dialogSource, /event\.target === event\.currentTarget/, "点遮罩应关闭");
  assert.match(dialogSource, /confirmRef\.current\?\.focus\(\)/, "打开时要把焦点放到确认按钮");
  // 点对话框内部不能关：否则选中提示文字这种操作会顺手把对话框关掉。
  assert.match(dialogSource, /onClick=\{onClose\}/, "确认按钮要能关闭");
});

test("渲染进程：关闭动作接回 store 的 dismissNotice，不另造一份状态", () => {
  // 自己 set({ notice: null }) 也能跑，但 store 里那份 dismissNotice 就变成死代码，
  // 以后改清理逻辑（比如顺带清 error）只改一处会漏。
  assert.match(appSource, /<NoticeDialog[^>]*onClose=\{dismissNotice\}/);
});

test("样式：对话框压得住顶栏与菜单", () => {
  const zIndexOf = (selector) => {
    const rule = stylesSource.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`));
    assert.ok(rule, `找不到 ${selector} 规则`);
    return Number(rule[1].match(/z-index:\s*(\d+)/)?.[1]);
  };
  const modal = zIndexOf(".modal-backdrop");
  assert.ok(Number.isFinite(modal), "对话框遮罩必须显式给 z-index");
  assert.ok(modal > zIndexOf(".topbar"), `对话框(${modal}) 必须压过顶栏(${zIndexOf(".topbar")})`);
  assert.ok(modal > zIndexOf(".menu-popover"), `对话框(${modal}) 必须压过菜单(${zIndexOf(".menu-popover")})`);
  // 居中而不是贴边：place-items:center 是这条需求的落点。
  assert.match(stylesSource, /\.modal-backdrop\s*\{[^}]*place-items:\s*center/);
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
