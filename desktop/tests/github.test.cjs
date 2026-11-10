// GitHub Release → 更新器自身版本与更新公告的解析与接线。
//
// 数据源只有一个：本仓库的 Release 列表（`desktop-v*`）。这里盯的是四件事：
//   1. 解析层只认已发布、tag 合规的 Release，版本比较按数字而不是字符串；
//   2. 资产清单里的 sha256 摘要要原样带出来 —— 应用内下载靠它校验；
//   3. 主进程只多开两个白名单命令，打开链接必须校验前缀，不能变成任意 URL 跳板；
//   4. 公告时间线按发布时间倒序，且只取最近十条。

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const github = require("../electron/github.cjs");
const main = read("electron", "main.cjs");
const app = read("src", "state", "app.ts");
const appView = read("src", "App.tsx");
const types = read("src", "types.ts");
const announcements = read("src", "lib", "announcements.ts");
const bell = read("src", "components", "AnnouncementBell.tsx");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const release = (tag, extra = {}) => ({
  tag_name: tag,
  name: extra.name ?? tag,
  body: extra.body ?? "",
  html_url: extra.html_url ?? `https://github.com/x/y/releases/tag/${tag}`,
  draft: extra.draft ?? false,
  prerelease: extra.prerelease ?? false,
  published_at: extra.published_at ?? "2026-11-01T00:00:00Z",
  assets: extra.assets ?? [],
});

// ---------- 版本号 ----------

test("版本比较按数字比，不是按字符串比", () => {
  assert.equal(github.compareVersions("26.902.100.0", "26.902.99.0"), 1);
  assert.equal(github.compareVersions("26.902.99.0", "26.902.100.0"), -1);
  assert.equal(github.compareVersions("26.902.100.0", "26.902.100.0"), 0);
});

test("段数不同时短的一侧按 0 补齐", () => {
  // 更新器是 0.3.0，命令行里可能写成 0.3；两边必须判等，否则「已是最新」会抖。
  assert.equal(github.compareVersions("0.3", "0.3.0"), 0);
  assert.equal(github.compareVersions("0.3.1", "0.3"), 1);
  assert.equal(github.compareVersions("v0.4.0", "0.3.0"), 1);
});

test("不认识的值返回 null，不抛异常", () => {
  assert.equal(github.compareVersions("latest", "0.3.0"), null);
  assert.equal(github.compareVersions(null, "0.3.0"), null);
  assert.equal(github.compareVersions("", ""), null);
});

// ---------- 更新器自身版本 ----------

test("更新器只提示比当前版本新的，且取其中最高的", () => {
  const releases = [release("desktop-v0.4.0"), release("desktop-v0.3.2"), release("desktop-v0.2.0")];
  assert.equal(github.pickUpdater(releases, "0.2.0").version, "0.4.0");
  assert.equal(github.pickUpdater(releases, "0.4.0"), null, "同版本不该再提示");
  assert.equal(github.pickUpdater(releases, "0.5.0"), null, "本机比 Release 新时更不该提示");
});

test("草稿与预发布不生效", () => {
  const releases = [
    release("desktop-v0.9.0", { draft: true }),
    release("desktop-v0.8.0", { prerelease: true }),
    release("desktop-v0.3.0"),
  ];
  assert.equal(github.pickUpdater(releases, "0.2.0").version, "0.3.0");
});

test("tag 不合规的一律不认", () => {
  const releases = [release("desktop-latest"), release("desktop-v0.3"), release("v0.3.0"), release("codex-pin-v26.902.100.0")];
  assert.equal(github.pickUpdater(releases, "0.1.0"), null);
});

// ---------- 资产（应用内下载的输入） ----------

test("Release 资产带上名字、大小、下载地址与 sha256 摘要", () => {
  const updater = github.pickUpdater(
    [
      release("desktop-v0.4.0", {
        assets: [
          {
            name: "Codex Updater Setup 0.4.0.exe",
            size: 88_000_000,
            browser_download_url:
              "https://github.com/aygzs123/Codex-Auto-Update-Plugin-New/releases/download/desktop-v0.4.0/CodexUpdater.exe",
            digest: `sha256:${"a".repeat(64)}`,
          },
        ],
      }),
    ],
    "0.3.0",
  );
  assert.deepEqual(updater.assets, [
    {
      name: "Codex Updater Setup 0.4.0.exe",
      size: 88_000_000,
      url: "https://github.com/aygzs123/Codex-Auto-Update-Plugin-New/releases/download/desktop-v0.4.0/CodexUpdater.exe",
      digest: `sha256:${"a".repeat(64)}`,
    },
  ]);
});

test("字段缺失时是空串 / 0，不编一个值出来", () => {
  // 没有摘要的资产由下载命令拒绝。这一层不做「没有就算了」的兜底，否则
  // 「无法校验」会被静默当成「校验通过」。
  const updater = github.pickUpdater([release("desktop-v0.4.0", { assets: [{ name: "x.exe" }] })], "0.3.0");
  assert.deepEqual(updater.assets, [{ name: "x.exe", size: 0, url: "", digest: "" }]);
});

// ---------- 公告时间线 ----------

test("公告只收 desktop-v*，按发布时间倒序", () => {
  const releases = [
    release("desktop-v0.3.0", { published_at: "2026-11-05T00:00:00Z" }),
    release("codex-pin-v26.902.100.0", { published_at: "2026-11-08T00:00:00Z" }),
    release("desktop-v0.4.0", { published_at: "2026-11-01T00:00:00Z" }),
    release("unrelated-v1.0.0"),
    release("desktop-v0.9.0", { draft: true }),
  ];
  const list = github.pickAnnouncements(releases);
  assert.deepEqual(
    list.map((entry) => entry.tag),
    ["desktop-v0.3.0", "desktop-v0.4.0"],
    "时间线里只该有已发布的 desktop-v*，且按时间倒序",
  );
});

test("公告只取最近十条，不把整个 Release 列表搬进界面", () => {
  const releases = Array.from({ length: 14 }, (_, index) =>
    release(`desktop-v0.${index + 1}.0`, { published_at: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00Z` }),
  );
  assert.equal(github.pickAnnouncements(releases).length, 10);
});

test("本地 CHANGELOG 公告优先于远端同 tag 的条目，且合并后倒序去重", () => {
  // 历史 Release 的正文是通用模板（「Windows x64 Electron installer…」），版本说明
  // 以打包进应用的 CHANGELOG 为准；远端独有的条目（比当前版本新的 Release）照常展示。
  assert.match(announcements, /for \(const entry of local\) byTag\.set\(entry\.tag, entry\);/, "本地应优先写入");
  assert.match(announcements, /if \(!byTag\.has\(entry\.tag\)\) byTag\.set/, "远端只补本地没有的 tag");
  assert.match(announcements, /sort\(\(left, right\) => publishedTime\(right\) - publishedTime\(left\)\)/, "合并后要按时间倒序");
  assert.match(announcements, /slice\(0, limit\)/, "合并后仍要限制条数");
  assert.match(announcements, /const ANNOUNCEMENT_LIMIT = 10;/, "上限应是 10 条");
  assert.match(appView, /mergeAnnouncements\(changelogAnnouncements\(\), github\?\.announcements \?\? \[\]\)/, "App 没有把两份公告合并");
});

// ---------- 拉取 ----------

test("拉取 URL 固定在本仓库的公开 API，且一次要够多条", async () => {
  const calls = [];
  const result = await github.fetchGithubUpdates({
    repo: "owner/repo",
    currentVersion: "0.2.0",
    fetchJson: async (url) => {
      calls.push(url);
      return [release("codex-pin-v26.902.100.0"), release("desktop-v0.3.0")];
    },
  });
  assert.deepEqual(calls, ["https://api.github.com/repos/owner/repo/releases?per_page=30"]);
  assert.equal(result.updater.version, "0.3.0");
  // 同一次请求顺带产出公告时间线，界面不该为此再打一次 API。
  assert.equal(result.announcements.length, 1, "announcements 没有跟着一起返回");
  assert.equal(result.announcements[0].tag, "desktop-v0.3.0");
  assert.equal("pin" in result, false, "版本固定已移除，返回值里不该再有 pin");
});

test("返回格式不对时明确报错，不静默当成「没有新版本」", async () => {
  await assert.rejects(
    () =>
      github.fetchGithubUpdates({
        repo: "owner/repo",
        currentVersion: "0.2.0",
        fetchJson: async () => ({ message: "rate limited" }),
      }),
    /格式不对/,
  );
});

// ---------- 主进程接线 ----------

test("GitHub 相关命令都在白名单且有实现", () => {
  for (const command of ["get_github_updates", "open_release", "download_app_update", "install_app_update"]) {
    assert.match(main, new RegExp(`"${command}",`), `${command} 不在白名单`);
    assert.match(main, new RegExp(`case "${command}":`), `${command} 没有实现`);
  }
});

test("打开链接只接受本仓库的 releases 前缀", () => {
  const open = main.match(/case "open_release": \{[\s\S]*?\r?\n    \}/);
  assert.ok(open, "找不到 open_release 分支");
  assert.match(open[0], /allowedPrefix = `https:\/\/github\.com\/\$\{GITHUB_REPO\}\/releases\//, "前缀必须是本仓库的 releases");
  assert.match(open[0], /if \(!url\.startsWith\(allowedPrefix\)\) throw/, "前缀不匹配必须拒绝");
});

test("GitHub 结果有五分钟内存缓存与磁盘兜底", () => {
  assert.match(main, /const GITHUB_CACHE_MS = 5 \* 60 \* 1000;/, "缓存时长不是五分钟");
  assert.match(main, /github-cache\.json/, "没有磁盘缓存：离线启动会把更新结论静默丢掉");
  // 请求失败但手上有旧结果时，要带 stale 标记继续按旧结论执行。
  assert.match(main, /stale: true/, "失败时没有 stale 标记");
});

// ---------- 渲染进程接线 ----------

test("设置里只落盘公告忽略列表，pinToGithubRelease 已彻底移除", () => {
  assert.match(main, /"dismissedTips" in args/, "save_settings 不认 dismissedTips");
  assert.match(types, /dismissedTips\?: string\[\];/, "Settings 缺 dismissedTips");
  assert.doesNotMatch(main, /pinToGithubRelease/, "主进程还认 pinToGithubRelease");
  assert.doesNotMatch(types, /pinToGithubRelease/, "Settings 还留着 pinToGithubRelease");
});

test("界面只从 currentUpdatePolicy 取结论", () => {
  assert.match(appView, /const policy = currentUpdatePolicy\(\);/, "App 没有读统一策略");
  assert.doesNotMatch(appView, /update\?\.updateAvailable/, "App 还在直接读 update.updateAvailable");
  assert.match(appView, /<AnnouncementBell/, "顶栏没有渲染更新公告入口");
});

test("「本次更新后无法退回当前版本」的常驻告警已移除", () => {
  // 用户明确要求去掉这条：缓存可以按份数保留、也能逐个固定，这条告警读起来像
  // 「更新一定会毁掉退路」，而实际策略已经由「安装包缓存」那组设置承担。
  assert.doesNotMatch(appView, /UpdateTip/, "App 还在渲染策略告警");
  assert.doesNotMatch(appView, /无法退回当前版本/, "概览页还留着回滚风险告警文案");
  assert.doesNotMatch(
    read("src", "lib", "policy.ts"),
    /rollbackRisk/,
    "策略里还留着不再展示的 rollbackRisk 字段",
  );
});

test("公告在顶栏铃铛里可单独忽略，红点只跟「有新版」走", () => {
  assert.match(bell, /className="bell-dot"/, "有更新时要有红点");
  assert.match(bell, /className="timeline"/, "公告要用时间线展示");
  assert.match(bell, /不再显示/);
  assert.match(bell, /onDismiss\(entry\.tag\)/, "忽略要按 tag 落盘，不能只改本地状态");
  assert.match(bell, /const showDot = hasUpdate && visible\.length > 0;/, "红点只该跟更新器新版本走");
  assert.doesNotMatch(bell, /entry\.kind/, "公告不再有 pin / updater 两类");
});

test("刷新结论不再被固定版本开关门控", () => {
  // 以前启动时要先等 GitHub；现在 GitHub 只服务「更新器自身版本 + 公告」，
  // 它失败了也不该拦住 Codex 的更新判断。
  const bootstrap = app.slice(app.indexOf("bootstrap: async"), app.indexOf("oneClick: async"));
  assert.doesNotMatch(bootstrap, /pinToGithubRelease/);
  assert.doesNotMatch(app, /targetFromCache|pinState|pinVersion/);
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
