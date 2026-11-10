// 把 desktop/CHANGELOG.md 变成两份产物：
//   1. src/lib/changelog.generated.json —— 应用内的历史更新公告（构建时生成）；
//   2. 发版时的 Release 正文（--version <x.y.z> --out <file>）。
//
// 为什么要有这个脚本：公告只能维护一处。发版写在 CHANGELOG 里，应用读同一份内容，
// CI 也读同一份内容 —— 三处各写一遍，迟早会出现「Release 说更新了 A，应用公告说 B」。
//
// 生成物是要提交的（测试会比对它与 CHANGELOG 是否一致）；predev / prebuild 会重新生成。

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = join(desktopRoot, "CHANGELOG.md");
const generatedPath = join(desktopRoot, "src", "lib", "changelog.generated.json");

const HEADING = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/gm;

/**
 * 解析 CHANGELOG，返回按发布时间倒序的 { version, date, body }。
 *
 * body 不含 `## [版本] - 日期` 这一行：界面上版本号与日期是单独渲染的，正文里再出现
 * 一次只会重复。发布时由脚本把标题补回去。
 */
export function parseChangelog(markdown) {
  const text = String(markdown ?? "").replace(/\r\n/g, "\n");
  const matches = [...text.matchAll(HEADING)];
  return matches
    .map((match, index) => {
      const start = match.index + match[0].length;
      const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
      return {
        version: match[1],
        date: match[2],
        body: text.slice(start, end).trim(),
      };
    })
    .sort((left, right) => {
      if (left.date !== right.date) return left.date < right.date ? 1 : -1;
      return left.version < right.version ? 1 : -1;
    });
}

export function releaseNotes(entry) {
  return [`## [${entry.version}] - ${entry.date}`, "", entry.body, ""].join("\n");
}

function readChangelog() {
  return readFileSync(changelogPath, "utf8");
}

function generate() {
  const entries = parseChangelog(readChangelog());
  writeFileSync(generatedPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  console.log(`已生成 ${generatedPath}（${entries.length} 个版本）`);
}

function extract(version, outPath) {
  const entry = parseChangelog(readChangelog()).find((candidate) => candidate.version === version);
  if (!entry) {
    console.error(`CHANGELOG.md 里没有 ${version} 的小节。发版前必须先补上：## [${version}] - YYYY-MM-DD`);
    process.exitCode = 1;
    return;
  }
  if (!entry.body) {
    console.error(`CHANGELOG.md 里 ${version} 的小节是空的。Release 正文不能是空的。`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(outPath, releaseNotes(entry), "utf8");
  console.log(`已写出 ${version} 的 Release 正文：${outPath}`);
}

// 只有直接运行时才干活：测试用 import 拿 parseChangelog，不该顺手重写生成物。
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const versionIndex = args.indexOf("--version");
  const outIndex = args.indexOf("--out");

  if (versionIndex !== -1 || outIndex !== -1) {
    const version = versionIndex === -1 ? "" : args[versionIndex + 1] ?? "";
    const outPath = outIndex === -1 ? "" : args[outIndex + 1] ?? "";
    if (!version || !outPath) {
      console.error("用法：node scripts/sync-changelog.mjs --version <x.y.z> --out <file>");
      process.exitCode = 1;
    } else {
      extract(version, outPath);
    }
  } else {
    generate();
  }
}
