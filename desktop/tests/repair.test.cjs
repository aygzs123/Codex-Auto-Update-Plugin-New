// 「修复资源副本」错误报告测试。纯 node，不依赖 electron，用 `npm test` 跑。
//
// 这条路径的全部价值在于「失败时要看得见」：修复必须先关掉 Codex 才能搬文件，
// 用户点下去之后，界面就是唯一的反馈渠道。
//
// 2026-10-02 那次失效（脚本用了 Windows PowerShell 5.1 里不存在的 SHA256::HashData，
// 而桌面端只用 5.1 调它）根因在脚本，但表现成「点了没反应」有一半责任在这里：
// repairBundles 只收 stdout、把 stderr 写死成空串，streamScript 也就没订阅
// onStderrLine，于是 describeFailure 只能挤出「PowerShell 退出码 1」，
// 而 app.ts 的 catch 又立刻把 activity 置空 —— 日志行闪一下，什么都没留下。
//
// codex.cjs 顶层 require("electron")，纯 node 测试里不能直接 require，
// 所以和其他测试（busy-state / launch / rollback）一样断言源码文本。
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const source = readFileSync(join(__dirname, "..", "electron", "codex.cjs"), "utf8");

// 切出 repairBundles 的函数体。边界用正则而不是裸 "\n"，因为检出配置可能把文件
// 变成 CRLF（见仓库里那条 CRLF 检出教训），裸 \n 会切空、断言随之静默失效。
// 上界锚在 module.exports：修复函数后面紧跟它，用行首的 }); 会切在半途。
function sliceFunction(name) {
  const start = source.indexOf(`async function ${name}`);
  assert.notEqual(start, -1, `electron/codex.cjs 里找不到 ${name}`);
  const after = source.slice(start + 1);
  const stop = after.search(/\r?\nmodule\.exports/);
  return stop === -1 ? after : after.slice(0, stop);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("repairBundles 订阅了 stderr，PowerShell 的报错不再被丢掉", () => {
  const body = sliceFunction("repairBundles");
  assert.match(
    body,
    /onStderrLine/,
    "repairBundles 没给 streamScript 传 onStderrLine：解析错误和 PowerShell 自身的失败会整条丢掉",
  );
});

test("repairBundles 把收到的 stderr 交给 describeFailure", () => {
  const body = sliceFunction("repairBundles");
  assert.doesNotMatch(
    body,
    /stderr:\s*""/,
    "describeFailure 拿到了写死的空 stderr，失败会退化成「PowerShell 退出码 1」",
  );
  assert.match(
    body,
    /stderr:\s*\w+\.join\(/,
    "收集了 stderr 却没交给 describeFailure，等于白收",
  );
});

test("repairBundles 把 stderr 行推进 activity 日志，用户在界面上看得到", () => {
  const body = sliceFunction("repairBundles");
  // onStderrLine 的回调体里必须有 emit({ kind: "log", ... })，
  // 否则 stderr 只进了 describeFailure，异常抛出前界面上依然是空的。
  assert.match(
    body,
    /onStderrLine:\s*\(line\)\s*=>\s*\{[\s\S]*?emit\(\{\s*kind:\s*"log",\s*line\s*\}\)/,
    "stderr 行没有推进 activity 日志，用户仍然只能看到一闪而过的空日志",
  );
});

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
