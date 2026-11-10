// CHANGELOG 是更新公告的唯一来源：应用读它（构建时生成 JSON），发版 CI 也读它
// （把当前版本的小节写进 Release 正文）。所以这里钉三件事：
//
//   1. 解析格式固定（`## [x.y.z] - YYYY-MM-DD`），三节历史都能切出来且正文非空；
//   2. package.json 的版本号必须在 CHANGELOG 里有小节 —— 发版忘写公告会直接失败；
//   3. 提交的 changelog.generated.json 必须与 CHANGELOG 一致，防止手改生成物。

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const pkg = JSON.parse(read("package.json"));
const changelog = read("CHANGELOG.md");
const generated = JSON.parse(read("src", "lib", "changelog.generated.json"));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// sync-changelog.mjs 是 ESM（type: module），普通 require 要用动态 import。
let mod;

const load = async () => {
  mod ??= await import("../scripts/sync-changelog.mjs");
  return mod;
};

test("解析：`## [版本] - 日期` 切节，按发布时间倒序", async () => {
  const { parseChangelog } = await load();
  const entries = parseChangelog(changelog);
  assert.ok(entries.length >= 3, `至少要有 0.1.0 / 0.2.0 / 0.3.0 三节，实际 ${entries.length} 节`);
  const dates = entries.map((entry) => entry.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), "应按日期倒序");
  for (const entry of entries) {
    assert.match(entry.version, /^\d+\.\d+\.\d+$/, `版本号不合规：${entry.version}`);
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, `日期不合规：${entry.date}`);
    assert.ok(!!new Date(`${entry.date}T00:00:00Z`).getTime(), `日期解析失败：${entry.date}`);
    assert.ok(entry.body.trim().length > 0, `${entry.version} 的正文是空的`);
    assert.doesNotMatch(entry.body, /^## \[/m, "正文里不该再出现下一个版本的标题");
  }
});

test("解析：历史版本都已回填", async () => {
  const { parseChangelog } = await load();
  const versions = parseChangelog(changelog).map((entry) => entry.version);
  for (const version of ["0.1.0", "0.2.0", "0.3.0"]) {
    assert.ok(versions.includes(version), `CHANGELOG 缺 ${version} 的小节`);
  }
});

test("闸门：package.json 的版本必须在 CHANGELOG 里有小节", async () => {
  // 发版 CI 会按这个版本号抽 Release 正文；没有小节就该当场失败，
  // 而不是发一个空正文的 Release 出去。
  const { parseChangelog } = await load();
  const entry = parseChangelog(changelog).find((candidate) => candidate.version === pkg.version);
  assert.ok(entry, `CHANGELOG.md 里没有 ${pkg.version} 的小节：发版前必须先补 ## [${pkg.version}] - YYYY-MM-DD`);
});

test("生成物与 CHANGELOG 一致（防止手改 JSON）", async () => {
  const { parseChangelog } = await load();
  assert.deepEqual(generated, parseChangelog(changelog), "src/lib/changelog.generated.json 过期了，跑 npm run sync:changelog 重新生成");
});

test("发版正文会补回版本标题", async () => {
  const { parseChangelog, releaseNotes } = await load();
  const entry = parseChangelog(changelog)[0];
  const notes = releaseNotes(entry);
  assert.match(notes, new RegExp(`^## \\[${entry.version.replace(/\./g, "\\.")}\\] - ${entry.date}`));
  assert.ok(notes.includes(entry.body), "正文要原样带上");
});

test("解析对 CRLF 与结尾空行稳健", async () => {
  const { parseChangelog } = await load();
  // CI 是 CRLF 检出，本地是 LF。两份输入必须得到同一份结果。
  const crlf = changelog.replace(/\n/g, "\r\n");
  assert.deepEqual(parseChangelog(crlf), parseChangelog(changelog));
  assert.deepEqual(parseChangelog(""), []);
  assert.deepEqual(parseChangelog("# Changelog\n\n没有版本小节\n"), []);
});

// ---------- runner ----------

let failed = 0;
(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${error.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} 通过`);
  process.exit(failed === 0 ? 0 : 1);
})();
