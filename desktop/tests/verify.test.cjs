// 「安装包是不是可信的 Codex 包」—— 这段判断必须真的被执行，而不是被正则"看过"。
//
// 用户原话（桌面端的报错弹窗）：
//   签名无效或发布者不是 OpenAI，请不要继续安装
//   发布者 CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B
//   数字签名 Valid
//   安装包签名校验未通过，已中止安装。
//
// 同一张卡片上「数字签名 Valid」，上面却写着「签名无效」—— 这不是文案问题，是判断错了：
// 旧实现要求签名者主题里含 "openai"，而 Store 分发的包发布者 DN 就是 CN=<GUID> 形式，
// 于是**每一个**合法安装包都被拒。桌面端的「一键安装」在签名闸门上是 100% 失败的。
//
// 旧实现没人发现，是因为它写在 codex.cjs 里，而那个文件 require("electron")，测试根本加载不了；
// 当时的测试只对源码做正则匹配 —— 正则匹配不了「这段逻辑对真实输入算出来是什么」，
// 所以它一路发到了用户手上。修法就是把判断挪进不依赖 electron 的 verify.cjs（下面真跑），
// 只在 codex.cjs 里留下调用与措辞。

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const {
  CODEX_PACKAGE_NAME,
  FALLBACK_PUBLISHER,
  commonName,
  publisherMatches,
  evaluateSignature,
} = require("../electron/verify.cjs");

const codex = read("electron", "codex.cjs");
const app = read("src", "App.tsx");
const renderScript = read("scripts", "verify-render.cjs");

// 本机实测的两个值，逐字取自故障现场与 Get-AppxPackage。
const REAL_PUBLISHER = "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B";
const OTHER_PUBLISHER = "CN=11111111-2222-3333-4444-555555555555";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- 判断逻辑（真执行） ----------

test("真实的 Codex 包必须通过 —— 这正是被误拒的那一个", () => {
  const verdict = evaluateSignature({
    status: "Valid",
    subject: REAL_PUBLISHER,
    installedPublisher: REAL_PUBLISHER,
  });
  assert.equal(verdict.ok, true, "Store 包的发布者是 CN=<GUID>，不含 OpenAI 字样，但它就是正牌 Codex");
  assert.equal(verdict.reason, "verified");
});

test("本机没装 Codex 时回落到已登记的发布者", () => {
  assert.equal(FALLBACK_PUBLISHER, REAL_PUBLISHER, "回落值必须是实测的 Codex 发布者");
  for (const installedPublisher of ["", null, undefined, "   "]) {
    const verdict = evaluateSignature({ status: "Valid", subject: REAL_PUBLISHER, installedPublisher });
    assert.equal(verdict.ok, true, `installedPublisher=${JSON.stringify(installedPublisher)} 时应走回落`);
  }
});

test("发布者不是 Codex 的包必须拒 —— 放宽不等于不设防", () => {
  const verdict = evaluateSignature({
    status: "Valid",
    subject: OTHER_PUBLISHER,
    installedPublisher: REAL_PUBLISHER,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "publisher", "签名有效但发布者不对，要和「签名无效」分开报");
});

test("签名无效必须拒，且原因不能和「发布者不对」混为一谈", () => {
  for (const status of ["NotSigned", "HashMismatch", "UnknownError", ""]) {
    const verdict = evaluateSignature({ status, subject: REAL_PUBLISHER, installedPublisher: REAL_PUBLISHER });
    assert.equal(verdict.ok, false, `状态 ${status} 必须被拒`);
    assert.equal(verdict.reason, "unsigned");
  }
});

test("DN 只比 CN：RDN 顺序和附加字段都不该造成误拒", () => {
  // 签名者主题来自 Get-AuthenticodeSignature，期望值来自 Get-AppxPackage 的 Publisher，
  // 两个来源的 RDN 顺序并不保证一致。整串比较迟早会在某台机器上又变回「合法包被拒」。
  assert.equal(
    publisherMatches(`CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B, O=OpenAI, C=US`, REAL_PUBLISHER),
    true,
  );
  assert.equal(publisherMatches(`cn=50bdfd77-8903-4850-9ffe-6e8522f64d5b`, REAL_PUBLISHER), true, "大小写不该有影响");
  assert.equal(publisherMatches(REAL_PUBLISHER, `CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B`), true);
});

test("两边都解析不出 CN 时不算相等", () => {
  // 少了这条前提，任何两个读不懂的 DN 都会互相通过校验 —— 那等于把闸门整个拆了。
  assert.equal(publisherMatches("", ""), false);
  assert.equal(publisherMatches("O=某公司", "O=某公司"), false);
  assert.equal(publisherMatches(undefined, undefined), false);
  assert.equal(commonName(""), "");
});

// ---------- 调用方不再自带一份判断 ----------

test("codex.cjs 里不能再有「主题含 openai」这类判断", () => {
  assert.doesNotMatch(codex, /includes\(["']openai["']\)/i, "旧判断就是这么写的，它让合法包全被拒");
  assert.match(codex, /evaluateSignature\(/, "判断必须走 verify.cjs，那一份有测试真跑");
});

test("期望发布者取自本机已安装的 Codex，而不是写死在调用处", () => {
  assert.match(codex, /Get-AppxPackage -Name \$env:CODEX_VERIFY_PACKAGE_NAME/, "要现取已安装包的 Publisher");
  assert.match(codex, /\[string\]\$installed\.Publisher/, "取的是 Publisher 字段");
  assert.match(codex, /try \{[\s\S]*?Get-AppxPackage[\s\S]*?\} catch \{ \$installedPublisher = '' \}/, "查询失败要吞掉");
  assert.match(codex, /installedPublisher: report\.installedPublisher/);
  assert.match(codex, /CODEX_VERIFY_PACKAGE_NAME: CODEX_PACKAGE_NAME/, "包名经 env 传入，不拼进代码");
  assert.equal(CODEX_PACKAGE_NAME, "OpenAI.Codex", "包名要和 PowerShell 侧各脚本的默认参数一致");
});

test("查询失败不能被说成「这个包不可信」", () => {
  // 这正是要修的误报类型：一次工具故障不该变成对文件的指控。
  // 发布者读不到时 codex.cjs 只把空串交给 verify.cjs，由它回落到常量。
  assert.doesNotMatch(
    codex,
    /catch \(error\) \{[\s\S]{0,200}?message: "签名无效/,
    "读不到已安装包时不能直接判失败",
  );
});

test("签名有效但发布者不对时，措辞不能说成「签名无效」", () => {
  assert.match(codex, /verdict\.reason === "unsigned"/, "两种失败要分开措辞");
  assert.match(codex, /不是由 Codex 的发布者签发/);
});

// ---------- 界面 ----------

test("发布者不一致时，界面要把两边的值都摆出来", () => {
  assert.match(app, /预期发布者/, "只报一个「发布者」等于没说，用户无从判断哪里不对");
  assert.match(
    app,
    /signature\.expectedPublisher !== signature\.publisher/,
    "两边相同时不重复显示 —— 那是签名无效，多一行反而挡重点",
  );
});

test("渲染桩里的发布者必须是真实的 GUID 形式", () => {
  // 桩写 "CN=OpenAI, O=OpenAI, ..." 正是当初喂出那套错误判断的假数据。
  // 留着它，下一个人还会以为发布者里真的会有 "OpenAI"。
  assert.match(renderScript, /publisher: "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B"/);
  assert.match(renderScript, /expectedPublisher: "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B"/);
  assert.doesNotMatch(renderScript, /CN=OpenAI, O=OpenAI/);
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
