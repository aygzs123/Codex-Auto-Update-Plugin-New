// PowerShell 调用拼装层测试。纯 node，不依赖 electron，用 `npm test` 跑。
//
// 这层是踩过坑才定型的，用例的价值就是把这几个坑钉死：
//
//   1. 参数不能用 @argv 数组展开传。数组展开传的是「位置参数值」而不是参数名，
//      `@('-CheckOnly','-NoProxy','-DownloadDirectory','C:/cache')` 会把第一个位置
//      参数覆盖成字符串 "-CheckOnly"，开关全部失效。实测过，不是理论风险。
//   2. 值必须单引号包裹。单引号是 PowerShell 里唯一完全不展开的字面量，值里带空格、
//      引号、$、反引号都不会被解释；同时因为带了引号，值也不可能被误认成参数名。
//   3. 退出码必须显式带出来，否则脚本内的 exit N 出不来，状态语义全丢。

const assert = require("node:assert/strict");
const { buildInvocation, quoteValue, wrapCommand } = require("../electron/ps.cjs");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- 取值转义 ----------

test("单引号字面量：把值包起来并复制内部单引号", () => {
  assert.equal(quoteValue("plain"), "'plain'");
  assert.equal(quoteValue("it's"), "'it''s'");
  assert.equal(quoteValue("a'b'c"), "'a''b''c'");
});

test("单引号字面量：$、反引号、分号都原样保留（不会被展开或断句）", () => {
  // 若走双引号，$env:USERPROFILE 会被展开、`n 会变成换行，都是注入面。
  assert.equal(quoteValue("$env:USERPROFILE"), "'$env:USERPROFILE'");
  assert.equal(quoteValue("a`nb"), "'a`nb'");
  assert.equal(quoteValue("x; Remove-Item -Recurse C:\\"), "'x; Remove-Item -Recurse C:\\'");
});

test("单引号字面量：中文与非 ASCII 路径原样保留", () => {
  assert.equal(quoteValue("C:\\用户\\测试 目录"), "'C:\\用户\\测试 目录'");
});

// ---------- 调用式拼装 ----------

test("拼装：开关裸写、值单引号跟随，参数名成对出现", () => {
  const invocation = buildInvocation("C:\\scripts\\check.ps1", {
    flags: ["-CheckOnly", "-NoProxy"],
    values: { "-DownloadDirectory": "C:\\cache" },
  });
  assert.equal(invocation, "& 'C:\\scripts\\check.ps1' -CheckOnly -NoProxy -DownloadDirectory 'C:\\cache'");
});

test("拼装：脚本路径也走单引号，路径里的空格不会把参数切断", () => {
  const invocation = buildInvocation("C:\\Program Files\\Codex\\check.ps1", {});
  assert.equal(invocation, "& 'C:\\Program Files\\Codex\\check.ps1'");
});

test("拼装：值为空的参数被整对跳过，不会退化成裸开关", () => {
  // 退化成裸开关是最危险的情况：`-DownloadDirectory` 会去吞掉后面那个参数当它的值。
  const invocation = buildInvocation("C:\\check.ps1", {
    flags: ["-NoProxy"],
    values: { "-DownloadDirectory": "", "-LogPath": null, "-Ring": undefined },
  });
  assert.equal(invocation, "& 'C:\\check.ps1' -NoProxy");
});

test("拼装：值为 0 或 false 时不被当成空值丢掉", () => {
  // 用 `if (!value) continue` 会误丢 0。这里必须只判 null/undefined/""。
  const invocation = buildInvocation("C:\\check.ps1", { values: { "-ProbeSeconds": 0 } });
  assert.equal(invocation, "& 'C:\\check.ps1' -ProbeSeconds '0'");
});

test("拼装：值里带引号和空格时仍然只是一个参数", () => {
  const invocation = buildInvocation("C:\\check.ps1", { values: { "-Tag": "it's a test" } });
  assert.equal(invocation, "& 'C:\\check.ps1' -Tag 'it''s a test'");
});

test("拼装：非法开关被拒绝（防止值伪装成参数名）", () => {
  assert.throws(() => buildInvocation("C:\\check.ps1", { flags: ["CheckOnly"] }), /非法开关/);
  assert.throws(() => buildInvocation("C:\\check.ps1", { flags: ["-Check Only"] }), /非法开关/);
  assert.throws(() => buildInvocation("C:\\check.ps1", { values: { "DownloadDirectory": "x" } }), /非法参数名/);
  assert.throws(() => buildInvocation("C:\\check.ps1", { values: { "-Down; Remove-Item": "x" } }), /非法参数名/);
});

// ---------- 命令包装 ----------

test("包装：带 UTF-8 前缀与显式退出码透传", () => {
  const wrapped = wrapCommand("& 'C:\\check.ps1' -NoProxy");
  assert.ok(wrapped.startsWith("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"), "缺少 UTF-8 前缀");
  assert.ok(wrapped.includes("$LASTEXITCODE = 0;"), "缺少退出码归零");
  assert.ok(wrapped.endsWith("; exit $LASTEXITCODE"), "缺少退出码透传");
  assert.ok(wrapped.includes("& 'C:\\check.ps1' -NoProxy"), "原始调用式被破坏");
});

test("包装：归零在调用之前，保证脚本正常走完时报 0 而不是残留值", () => {
  const wrapped = wrapCommand("& 'C:\\check.ps1'");
  assert.ok(
    wrapped.indexOf("$LASTEXITCODE = 0;") < wrapped.indexOf("& 'C:\\check.ps1'"),
    "归零必须发生在调用之前",
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
