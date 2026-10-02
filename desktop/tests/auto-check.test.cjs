// 「启动时就该知道装的是不是最新版本，不该点一下才知道」。
//
// 用户原话：「启动的时候只读取了版本，不会识别到是不是最新的版本号，还是会出现检查更新和
// 查版本号，要点检查版本号才能查到是最新的」。
//
// 这是**有意写死**的行为（bootstrap 只跑 get_settings / get_status /
// list_cached_packages 三条全本地命令），所以它有一整圈配套设施：启动后有一个不弹模态、
// 不报错、带超时的自动检查，以及顶栏那句「已是最新」。这个文件钉的就是那一圈，逐条对着
// 一个具体的退化方式 —— 因为这个 bug 最难的地方在于**它坏起来是静默的**：
//
//   - 顺序写错（在 set({ phase: "ready" }) 之前调用）→ 被 autoCheckUpdate 自己那道
//     忙判据挡掉 → 不报错、不变红，只是永远不查，界面看起来「和以前一样」；
//   - 超时忘了清 checkingUpdate → 启动即永久锁死，用户什么都没点却什么都点不动；
//   - 顺手写了 notice / error → 每次启动都弹一个居中模态，或把界面染红。
//
// app.ts 是 TS，测试里 require 不了（与 busy-state / launch / rollback / repair 同一套
// 做法：读源码文本断言）。切片边界一律写 \r?\n —— 检出可能是 CRLF，裸 \n 会切空、
// 断言随之静默失效。

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const store = read("src", "state", "app.ts");
const app = read("src", "App.tsx");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** 抠出一个「对象字面量属性 = async 函数」的实现体，边界那两级缩进是 app.ts 的既有排版。 */
function sliceAsyncProperty(source, name) {
  const match = source.match(new RegExp(`${name}: async \\(\\) => \\{([\\s\\S]*?)\\r?\\n  \\},`));
  assert.ok(match, `app.ts 里找不到 ${name} 的实现`);
  return match[1];
}

test("bootstrap 启动时会真的查一次「是不是最新」", () => {
  const bootstrap = sliceAsyncProperty(store, "bootstrap");
  assert.match(
    bootstrap,
    /void get\(\)\.autoCheckUpdate\(\);/,
    "bootstrap 没有触发自动检查，功能等于没做：启动仍然只读本机版本",
  );
  // 不 await 是刻意的：界面就绪不该等一次网络往返。写成 await 会让启动界面一直卡在
  // 「正在准备」直到查询回来（坏网络下最长 30 秒），那比不查更糟。
  assert.doesNotMatch(
    bootstrap,
    /await get\(\)\.autoCheckUpdate\(\)/,
    "自动检查不该被 await，界面就绪不能等一次网络往返",
  );
});

test("自动检查排在 set({ phase: \"ready\" }) 之后", () => {
  // 这一条是整份文件里最容易写错、也最难发现的一条。isCommandRunning 把
  // phase === "checking" 也算忙，写在 ready 之前会被 autoCheckUpdate 自己那道 guard
  // 直接挡掉 —— 不报错、不变红，只是永远不查，看起来和改之前一模一样。
  const bootstrap = sliceAsyncProperty(store, "bootstrap");
  const readyAt = bootstrap.indexOf('set({ settings, status, phase: "ready" })');
  const callAt = bootstrap.indexOf("void get().autoCheckUpdate()");
  assert.notEqual(readyAt, -1, "找不到 bootstrap 里把 phase 置为 ready 的那次 set");
  assert.notEqual(callAt, -1, "bootstrap 里没有触发自动检查");
  assert.ok(
    callAt > readyAt,
    "自动检查必须在 phase 置为 ready 之后触发，否则会被忙判据静默挡掉（功能失效但不报错）",
  );
});

test("自动检查排在 refreshCachedPackages 之后", () => {
  // -CheckOnly 不下载，但脚本照样剪枝下载缓存目录。检查若是排在枚举之前，
  // 「版本历史」卡片列的就是刚被删掉的包。
  const bootstrap = sliceAsyncProperty(store, "bootstrap");
  const refreshAt = bootstrap.indexOf("await get().refreshCachedPackages()");
  const callAt = bootstrap.indexOf("void get().autoCheckUpdate()");
  assert.notEqual(refreshAt, -1, "找不到 bootstrap 里的 refreshCachedPackages");
  assert.ok(callAt > refreshAt, "自动检查必须在枚举缓存清单之后，否则卡片会显示已删除的包");
});

test("自动检查不弹模态、不报错", () => {
  // 用户什么都没要求，启动就糊一个居中对话框是打扰；把启动界面染红比「不知道结论」更糟。
  // 结论只落在顶栏那一行。
  const body = sliceAsyncProperty(store, "autoCheckUpdate");
  assert.doesNotMatch(body, /notice:/, "自动检查不许碰 notice：那会每次启动弹一个居中模态");
  assert.doesNotMatch(body, /error:/, "自动检查不许碰 error：离线不该把启动界面染红");
  // 反过来，用户点出来的那次必须仍然弹 —— 两者共用命令，差别全在呈现。
  const checkUpdate = sliceAsyncProperty(store, "checkUpdate");
  assert.match(checkUpdate, /notice:/, "手动检查仍然要给出结论弹窗，别被这条改动顺手抹平");
});

test("自动检查置位并在 finally 里清掉 checkingUpdate", () => {
  const body = sliceAsyncProperty(store, "autoCheckUpdate");
  assert.match(body, /set\(\{ checkingUpdate: true \}\)/, "自动检查开始时必须置位，否则跑着的时候入口是亮的");
  const finallyBlock = body.match(/finally \{([\s\S]*?)\r?\n    \}/);
  assert.ok(finallyBlock, "autoCheckUpdate 缺少 finally：中途失败或超时就再也不解锁了");
  assert.match(
    finallyBlock[1],
    /checkingUpdate: false/,
    "finally 里必须清掉 checkingUpdate —— 漏清就是启动即永久锁死（用户什么都没点，只能重启应用）",
  );
  // 清定时器同样在 finally 里：不清的话每次启动都会留一个 30 秒的定时器，
  // 它会在页面已经不再检查之后触发 reject（虽然没人接了）。
  assert.match(finallyBlock[1], /clearTimeout\(/, "finally 里要清掉超时定时器");
});

test("自动检查自带超时", () => {
  // 这是本次唯一一处防御性代码，理由是硬约束：electron/ps.cjs 没有进程级超时
  // （全文没有 timeout / kill），脚本侧 Invoke-RgAdguardQuery 最多重试 3 轮、每轮还有
  // HTTPS→HTTP→curl 三层兜底。手动检查卡住只是「用户自己那次没了」，自动检查卡住却是
  // 启动即永久锁死，而用户连「是不是我在等」都无从判断。
  assert.match(store, /const AUTO_CHECK_TIMEOUT_MS = [\d_]+;/, "缺超时常量");
  const body = sliceAsyncProperty(store, "autoCheckUpdate");
  assert.match(body, /Promise\.race\(/, "自动检查必须给查询套一个超时，否则坏网络下启动界面永久置灰");
  assert.match(body, /setTimeout\(/, "缺超时定时器");
});

test("未安装时提前返回", () => {
  // 没装就没有「是不是最新」可言；顺带避开未安装时顶栏那句「可更新到 X」的怪语义。
  const body = sliceAsyncProperty(store, "autoCheckUpdate");
  assert.match(
    body,
    /if \(!current\.status\?\.installed\) return;/,
    "未安装时不该去查「是不是最新」",
  );
  // 忙的时候不叠：判据仍然只有 isCommandRunning 一处，不另写一份
  // （busy-state.test.cjs 明确禁止各写一份）。
  assert.match(body, /if \(isCommandRunning\(current\)\) return;/, "已有命令在跑时不该再叠一条");
});

test("检查剪枝了缓存就刷新「版本历史」", () => {
  const body = sliceAsyncProperty(store, "autoCheckUpdate");
  assert.match(
    body,
    /update\.removedCacheFiles\?\.length/,
    "自动检查没看 removedCacheFiles：-CheckOnly 也会剪枝缓存，卡片会显示已经不在磁盘上的包",
  );
  assert.match(body, /void get\(\)\.refreshCachedPackages\(\)/, "剪枝之后要重新枚举缓存清单");
  // 类型镜像也要有这个字段，否则上面那句读不到东西。
  const types = read("src", "types.ts");
  assert.match(types, /removedCacheFiles: string\[\];/, "UpdateReport 缺少 removedCacheFiles");
});

test("装完之后重新问一次，别留着安装前那份过期结论", () => {
  // 安装前那份报告写着「可更新到 X」，装完 X 就是当前版本了，照它渲染顶栏会自相矛盾：
  // 「已安装 X · 可更新到 X」。回退路径早就因为这个理由把 update 清成 null。
  const oneClick = sliceAsyncProperty(store, "oneClick");
  const doneAt = oneClick.indexOf('set({ installResult, status, phase: "done", activity: null, healthDetail: null })');
  const callAt = oneClick.indexOf("void get().autoCheckUpdate()");
  assert.notEqual(doneAt, -1, "找不到 oneClick 安装成功后的那次 set");
  assert.notEqual(callAt, -1, "装完之后没有重新问「是不是最新」");
  assert.ok(callAt > doneAt, "重新检查必须在 phase 置为 done 之后，否则会被忙判据挡掉");
});

test("顶栏写出「已是最新」，且与「可更新到」互斥", () => {
  const build = app.match(/<span className="build">([\s\S]*?)<\/span>/);
  assert.ok(build, "找不到顶栏的 .build");
  assert.match(build[1], /已是最新/, "顶栏没有「已是最新」：自动检查的结论就没有落点");
  assert.match(
    build[1],
    /upToDate \? "[^"]*已是最新" : ""/,
    "「已是最新」必须由 upToDate 驱动，不能自己另算一份判据",
  );
  assert.match(build[1], /可更新到/, "「可更新到」不能丢");
  // upToDate 的定义：与「可更新到」天然互斥，不用新字段。
  assert.match(
    app,
    /const upToDate = installed && update\?\.updateAvailable === false;/,
    "upToDate 的定义变了，顶栏/主按钮/次按钮三处的联动会一起走样",
  );
});

test("主区标题给出更新结论，而不是只报「已安装 X」", () => {
  // 用户原话：「第一次检测后显示的已安装 26.930.2377.0 启动所需资源完整 不太对吧，
  // 应该显示已是最新版：xxx」。主区那行大字是全页最显眼的一处，却只说了「装没装」，
  // 更新结论（要不要点那颗按钮，正是看它）一个字都没有 —— 得往上看顶栏那行小字。
  assert.match(app, /title = `已是最新版：\$\{version/, "主区标题没有「已是最新版：版本号」");
  assert.match(app, /title = `可更新到 \$\{availableVersion\}`/, "有新版时主区标题要写出可更新到哪一版");
  // 结论必须由父组件算好的 upToDate 驱动 —— 与顶栏、主按钮同一处判据。主区自己再算一份，
  // 就会出现「顶栏说已是最新、主区说可更新」这种自相矛盾，而用户无从判断哪个是真的。
  assert.match(app, /<Hero[\s\S]*?upToDate=\{upToDate\}/, "Hero 必须接收父组件的 upToDate");
  assert.match(
    app,
    /<Hero[\s\S]*?availableVersion=\{availableVersion\}/,
    "Hero 必须接收父组件的 availableVersion",
  );
  // 「还没结论」和「结论是最新」是两件事：检查没回来时不能默认报「已是最新」
  // ——编一个结论比什么都不说更糟。退路文案必须留着。
  assert.match(app, /title = `已安装 \$\{version \?\? "Codex"\}`/, "结论未回来时的退路文案不能丢");
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
