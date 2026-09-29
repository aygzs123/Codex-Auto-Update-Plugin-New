// 解析层测试。纯 node，不依赖 electron，用 `npm test` 跑。
//
// 这些用例的价值在于把「脚本输出格式」当成契约钉住：exe 复用仓库里已有的
// PowerShell 脚本，一旦上游脚本改了输出措辞，这里必须先红，而不是等到界面上
// 显示出一片空白才发现。

const assert = require("node:assert/strict");
const {
  parseHealth,
  healthNeedsRepair,
  parseUpdateCheck,
  parseCachedPackages,
  partialNameFor,
  parseInstallLogLine,
  installLogTerminal,
  creepPercent,
} = require("../electron/parse.cjs");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- 健康检查 ----------

// 真实输出（本机 2026-09-28 捕获），非臆造格式。
const REAL_HEALTH_OK = [
  "Package  : OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0",
  "Version  : 26.901.6511.0",
  "Location : C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0",
  "[OK   ] win-cli      C:\\Users\\lijunyuan\\AppData\\Local\\OpenAI\\Codex\\bin\\8e5b6932251c2c1c",
  "[OK   ] win-rg       C:\\Users\\lijunyuan\\AppData\\Local\\OpenAI\\Codex\\bin\\c60635126245daef",
  "[OK   ] wsl-cli      C:\\Users\\lijunyuan\\.codex\\bin\\wsl\\b53f5e5f7452dd19",
  "[OK   ] wsl-rg       C:\\Users\\lijunyuan\\.codex\\bin\\wsl\\1a4f6f66dd2f3710",
  "[OK   ] cua_node     C:\\Users\\lijunyuan\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\b474a88d5d105afa",
  "Plugins  : NOT materialized (bundled plugins stale)",
  "OVERALL=ok",
].join("\n");

test("健康输出：全 OK 时解析出版本、5 个组件与 OVERALL", () => {
  const health = parseHealth(REAL_HEALTH_OK, 0);
  assert.equal(health.installed, true);
  assert.equal(health.overall, "ok");
  assert.equal(health.version, "26.901.6511.0");
  assert.equal(health.packageFullName, "OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0");
  assert.equal(health.installLocation, "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0");
  assert.equal(health.components.length, 5);
  assert.deepEqual(
    health.components.map((component) => component.name),
    ["win-cli", "win-rg", "wsl-cli", "wsl-rg", "cua_node"],
  );
  assert.ok(health.components.every((component) => component.state === "ok"));
  // 真实输出里 Plugins 是 NOT materialized，而 OVERALL 仍是 ok —— 两者独立。
  assert.equal(health.pluginsMaterialized, false);
  assert.equal(health.overall, "ok");
});

// 装在别的盘上是最容易出错的一条路径，而它在开发机上永远不会自然出现
// （本机的 Codex 在 C 盘）。如果哪天有人图省事，把显示或匹配改成按系统盘拼路径，
// 这条断言必须立刻红。
test("健康输出：装在 D 盘时安装位置原样解析，不做任何盘符假设", () => {
  const text = [
    "Package  : OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0",
    "Version  : 26.901.6511.0",
    "Location : D:\\WindowsApps\\OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0",
    "[OK   ] win-cli      D:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\8e5b6932",
    "Plugins  : materialized",
    "OVERALL=ok",
  ].join("\n");
  const health = parseHealth(text, 0);
  assert.equal(health.installLocation, "D:\\WindowsApps\\OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0");
  // 盘符、大小写、反斜杠都不许被改写。
  assert.ok(!health.installLocation.startsWith("C:"), "解析层不得把安装位置改写成系统盘");
});

test("健康输出：没有 Location 行时是 null，不是空串或 \"undefined\"", () => {
  // 老版本脚本、或未安装时都不会打印这一行。界面靠 null 决定显示占位文案，
  // 拿到空串或字面量 "undefined" 就会在输入框里显示出一句乱码。
  const health = parseHealth(["Package  : X", "Version  : 1.0.0.0", "OVERALL=ok"].join("\n"), 0);
  assert.equal(health.installLocation, null);
});

test("健康输出：各状态符号映射正确", () => {
  const text = [
    "Package  : OpenAI.Codex_1.0.0.0_x64__abc",
    "Version  : 1.0.0.0",
    "[OK   ] win-cli      C:\\a",
    "[MISS ] win-rg       C:\\b  <- staging/repair leftovers: 2",
    "[PART ] wsl-cli      C:\\c  <- staging/repair leftovers: 0",
    "[ERR  ] cua_node     C:\\d  <- staging/repair leftovers: 1",
    "Plugins  : materialized",
    "OVERALL=degraded",
  ].join("\n");
  const health = parseHealth(text, 1);
  assert.deepEqual(
    health.components.map((component) => component.state),
    ["ok", "missing", "partial", "error"],
  );
  assert.equal(health.components[1].path, "C:\\b");
  assert.equal(health.components[1].leftovers, 2);
  assert.equal(health.pluginsMaterialized, true);
  assert.equal(healthNeedsRepair(health), true);
});

test("健康输出：退出码 2 视为未安装，且不解析出组件", () => {
  const health = parseHealth(
    "Codex Desktop package 'OpenAI.Codex' is not installed (or not visible to Get-AppxPackage).\nOVERALL=not-installed",
    2,
  );
  assert.equal(health.installed, false);
  assert.equal(health.overall, "not-installed");
  assert.equal(health.components.length, 0);
  assert.equal(healthNeedsRepair(health), false);
});

test("健康输出：-Probe 的结果行", () => {
  const visible = parseHealth(`${REAL_HEALTH_OK}\nAppUserModelId: OpenAI.Codex_2p2nqsd0c76g0!App\nRESULT=window-visible`, 0);
  assert.equal(visible.probeResult, "window-visible");
  assert.equal(visible.appUserModelId, "OpenAI.Codex_2p2nqsd0c76g0!App");
  assert.equal(healthNeedsRepair(visible), false);

  const invisible = parseHealth(
    `${REAL_HEALTH_OK}\nRESULT=window-not-visible\nWARNING: Codex Desktop processes are up but NO main window appeared within 20 s.`,
    3,
  );
  assert.equal(invisible.probeResult, "window-not-visible");
  // 进程在跑但没有窗口，正是加密资源搬迁 bug 的特征 —— 必须给出修复入口。
  assert.equal(healthNeedsRepair(invisible), true);
  assert.match(invisible.probeMessage, /NO main window appeared/);
});

test("健康输出：插件未物化不触发修复入口（修复脚本不修插件）", () => {
  // 真实健康输出里 Plugins 是 NOT materialized 而 OVERALL=ok。把它当修复触发条件
  // 会让每个用户常驻一个修不好的横幅，所以这里显式钉住「不触发」。
  const health = parseHealth(REAL_HEALTH_OK, 0);
  assert.equal(health.pluginsMaterialized, false);
  assert.equal(health.overall, "ok");
  assert.equal(healthNeedsRepair(health), false);
  // 信息本身仍然要解析出来供界面展示。
  assert.equal(typeof health.pluginsMaterialized, "boolean");
});

// ---------- 更新检查 ----------

test("更新检查：有新版本且已下载", () => {
  const report = parseUpdateCheck(
    [
      "Querying Codex package links from store.rg-adguard.net...",
      "Installed version: 26.901.6511.0",
      "Available version: 26.902.100.0",
      "Selected package: OpenAI.Codex_26.902.100.0_x64__2p2nqsd0c76g0.msix",
      "Update available: True",
      "Downloaded package: C:\\Users\\me\\AppData\\Roaming\\codex-updater-desktop\\downloads\\OpenAI.Codex_26.902.100.0_x64__2p2nqsd0c76g0.msix",
    ].join("\n"),
  );
  assert.equal(report.installedVersion, "26.901.6511.0");
  assert.equal(report.availableVersion, "26.902.100.0");
  assert.equal(report.fileName, "OpenAI.Codex_26.902.100.0_x64__2p2nqsd0c76g0.msix");
  assert.equal(report.updateAvailable, true);
  assert.match(report.downloadedPath, /\.msix$/);
});

test("更新检查：已是最新时不下载", () => {
  const report = parseUpdateCheck(
    [
      "Querying Codex package links from store.rg-adguard.net...",
      "Installed version: 26.902.100.0",
      "Available version: 26.902.100.0",
      "Selected package: OpenAI.Codex_26.902.100.0_x64__2p2nqsd0c76g0.msix",
      "Update available: False",
      "No newer package was found. Skipping download.",
    ].join("\n"),
  );
  assert.equal(report.updateAvailable, false);
  assert.equal(report.skipped, true);
  assert.equal(report.downloadedPath, null);
});

test("更新检查：未安装时 Installed version 是说明文字，不能当版本号", () => {
  const report = parseUpdateCheck(
    [
      "Installed version: not installed or not visible to Get-AppxPackage",
      "Available version: 26.902.100.0",
      "Update available: True",
    ].join("\n"),
  );
  assert.equal(report.installedVersion, null);
  assert.equal(report.availableVersion, "26.902.100.0");
  assert.equal(report.updateAvailable, true);
});

test("更新检查：缓存清理列表按缩进行收集", () => {
  // 措辞是 superseded，不再是 installed-or-older：保留策略换了 —— 现在删的是
  // 「超出保留额度」的包，而不是所有不高于已安装版本的包（那会把回退目标一起删掉）。
  const report = parseUpdateCheck(
    [
      "Installed version: 26.900.1.0",
      "Removed 2 superseded package file(s) from download cache:",
      "  C:\\cache\\OpenAI.Codex_26.890.0.0_x64__2p2nqsd0c76g0.msix",
      "  C:\\cache\\OpenAI.Codex_26.880.0.0_x64__2p2nqsd0c76g0.msix",
      "Available version: 26.902.100.0",
    ].join("\n"),
  );
  assert.equal(report.removedCacheFiles.length, 2);
  assert.match(report.removedCacheFiles[0], /26\.890\.0\.0/);
});

// ---------- 缓存安装包清单（版本历史 / 回退） ----------

test("缓存清单：三种 relation + 带空格的路径", () => {
  const list = parseCachedPackages(
    [
      "Download directory: C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\downloads",
      "Installed version: 26.901.6511.0",
      "Cached package count: 3",
      "  26.902.100.0|x64|876123456|2026-09-28T13:26:56Z|newer|C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\downloads\\OpenAI.Codex_26.902.100.0_x64__2p2nqsd0c76g0.msix",
      "  26.901.6511.0|x64|873000000|2026-09-20T09:00:00Z|installed|C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\downloads\\OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0.msix",
      "  26.896.100.0|x64|871000000|2026-09-11T03:20:00Z|older|D:\\安装包 缓存\\OpenAI.Codex_26.896.100.0_x64__2p2nqsd0c76g0.msix",
    ].join("\n"),
  );
  assert.equal(list.downloadDirectory, "C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\downloads");
  assert.equal(list.installedVersion, "26.901.6511.0");
  assert.equal(list.packages.length, 3);
  assert.deepEqual(
    list.packages.map((pkg) => pkg.relation),
    ["newer", "installed", "older"],
  );
  assert.equal(list.packages[0].sizeBytes, 876123456);
  assert.equal(list.packages[0].architecture, "x64");
  assert.equal(list.packages[0].modifiedAt, "2026-09-28T13:26:56Z");
  // 装到别的盘、路径里有空格和中文：回退要靠这个路径去 Add-AppxPackage，
  // 被截断或改写就等于回退必然失败。
  assert.equal(list.packages[2].path, "D:\\安装包 缓存\\OpenAI.Codex_26.896.100.0_x64__2p2nqsd0c76g0.msix");
});

test("缓存清单：路径里出现管道符也不让字段错位", () => {
  // 路径放最后一个字段并按 6 段切分，就是为了这个：真出现 `|` 时前五个字段仍然正确。
  const list = parseCachedPackages(
    [
      "Installed version: 1.0.0.0",
      "Cached package count: 1",
      "  1.0.0.0|x64|100|2026-01-01T00:00:00Z|installed|C:\\odd|dir\\a.msix",
    ].join("\n"),
  );
  assert.equal(list.packages.length, 1);
  assert.equal(list.packages[0].version, "1.0.0.0");
  assert.equal(list.packages[0].relation, "installed");
  // 这一份夹具故意不带 `Download directory:` 那一行 —— 脚本没跑成、输出被截断、或者
  // 对上的是旧版脚本时就是这样。解析器的初值是 null，所以 types.ts 里
  // CachedPackageList.downloadDirectory 必须如实写成 string | null；写成 string
  // 是类型在说谎，会让调用方以为可以直接当路径用。
  assert.equal(list.downloadDirectory, null);
  assert.equal(list.packages[0].path, "C:\\odd|dir\\a.msix");
});

test("缓存清单：空列表解析成 0 个包，不是报错", () => {
  // 界面要拿它显示「还没有可回退的旧版本」的解释文案，所以必须是空数组而不是 null。
  const list = parseCachedPackages(
    [
      "Download directory: C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\downloads",
      "Installed version: 26.901.6511.0",
      "Cached package count: 0",
    ].join("\n"),
  );
  assert.deepEqual(list.packages, []);
  assert.equal(list.installedVersion, "26.901.6511.0");
});

test("缓存清单：未安装时 Installed version 是说明文字，不能当版本号", () => {
  const list = parseCachedPackages(
    ["Download directory: C:\\dl", "Installed version: not installed", "Cached package count: 0"].join("\n"),
  );
  assert.equal(list.installedVersion, null);
});

test("缓存清单：计数行说 N 行、实际不够时不越界", () => {
  // 脚本被杀掉、输出被截断时会出现这种组合。多读会把后面的行当成安装包，
  // 少读只是少一行 —— 两种都不能抛异常。
  const list = parseCachedPackages(
    ["Installed version: 1.0.0.0", "Cached package count: 3", "  1.0.0.0|x64|100|2026-01-01T00:00:00Z|installed|C:\\a.msix"].join(
      "\n",
    ),
  );
  assert.equal(list.packages.length, 1);
});

test("partialNameFor：下载临时文件名", () => {
  assert.equal(partialNameFor("OpenAI.Codex_1.0.0.0_x64__abc.msix"), "OpenAI.Codex_1.0.0.0_x64__abc.msix.partial");
  assert.equal(partialNameFor(null), null);
});

// ---------- 安装日志 ----------
// 下面的消息串逐字取自 install-codex-msix-and-restart.ps1，不要改成近义表述。

test("安装日志：阶段推进覆盖完整流程", () => {
  const lines = [
    "[2026-09-28 06:20:31] Worker started for package: C:\\dl\\OpenAI.Codex_26.902.100.0_x64__2p2nqsd0c76g0.msix",
    "[2026-09-28 06:20:34] Closed 0 Codex Desktop process(es).",
    "[2026-09-28 06:20:34] Installing package with Add-AppxPackage...",
    "[2026-09-28 06:21:52] Install command completed.",
    "[2026-09-28 06:21:53] Removed superseded package file: C:\\dl\\OpenAI.Codex_26.880.0.0_x64__2p2nqsd0c76g0.msix",
    "[2026-09-28 06:21:53] Restart requested. Installed version: 26.902.100.0",
    "[2026-09-28 06:21:53] Probing for a visible main window (up to 30 s)...",
    "[2026-09-28 06:21:58] Window probe OK: Codex main window is visible.",
  ];
  const parsed = lines.map(parseInstallLogLine);
  assert.deepEqual(
    parsed.map((event) => event.phase),
    ["preparing", "closing", "installing", "verifying", "cleanup", "restarting", "probing", "done"],
  );
  // 进度必须单调不减，否则界面上会出现回退。
  const percents = parsed.map((event) => event.percent);
  assert.deepEqual(percents, [...percents].sort((a, b) => a - b));
  assert.equal(parsed[0].at, "2026-09-28 06:20:31");
  assert.equal(parsed[5].detail, "26.902.100.0");
  assert.equal(installLogTerminal(parsed[7]), "success");
});

test("安装日志：worker 启动行里带盘符路径的冒号不能被时间戳正则吃掉", () => {
  const event = parseInstallLogLine(
    "[2026-09-28 06:20:31] Worker started for package: C:\\dl\\OpenAI.Codex_1.0.0.0_x64__a.msix",
  );
  assert.equal(event.at, "2026-09-28 06:20:31");
  assert.equal(event.detail, "C:\\dl\\OpenAI.Codex_1.0.0.0_x64__a.msix");
});

test("安装日志：窗口探测失败是终止状态且不是成功", () => {
  const failed = parseInstallLogLine(
    "[2026-09-28 06:22:23] WINDOW_PROBE=FAILED: Codex restarted but NO main window appeared within 30 s.",
  );
  assert.equal(failed.type, "probe-failed");
  assert.equal(installLogTerminal(failed), "window-missing");
  assert.notEqual(installLogTerminal(failed), "success");
});

test("安装日志：SkipLaunch 也是成功终止", () => {
  const event = parseInstallLogLine(
    "[2026-09-28 06:21:53] Skip launch requested. Installation completed without starting Codex.",
  );
  assert.equal(event.phase, "done");
  assert.equal(installLogTerminal(event), "success");
});

test("安装日志：失败快照里的组件行与补救提示要单独识别", () => {
  const snapshot = parseInstallLogLine("[2026-09-28 06:22:23] Relocation health snapshot:");
  assert.equal(snapshot.type, "health-snapshot");

  const component = parseInstallLogLine("[2026-09-28 06:22:23]   component win-cli    state=missing");
  assert.equal(component.type, "health-component");
  assert.equal(component.name, "win-cli");
  assert.equal(component.state, "missing");

  const plugins = parseInstallLogLine("[2026-09-28 06:22:23]   bundled plugins materialized: False");
  assert.equal(plugins.type, "health-plugins");
  assert.equal(plugins.materialized, false);

  const remedy = parseInstallLogLine(
    "[2026-09-28 06:22:23] Remedy: run docs/codex-desktop-encrypted-copy-fix/repair-codex-desktop-bundles.ps1 (from the repo root) with pwsh, then relaunch Codex.",
  );
  assert.equal(remedy.type, "remedy");
  assert.match(remedy.remedy, /repair-codex-desktop-bundles\.ps1/);
});

test("安装日志：清理失败是警告而不是终止", () => {
  // 夹具用 worker 里那句原话（install-codex-msix-and-restart.ps1 的
  // Write-InstallLog "Package cache cleanup failed: ..."）。
  const event = parseInstallLogLine("[2026-09-28 06:21:53] Package cache cleanup failed: 拒绝访问。");
  assert.equal(event.warning, true);
  assert.equal(installLogTerminal(event), null);
});

test("安装日志：降级那一跑也要推进到 installing 阶段", () => {
  // worker 在 -AllowDowngrade 时写的是这句（比原话多一个括号）。
  // 以前正则只认原话，回退时进度条就卡在 12%（关闭进程）一动不动，
  // 直到「安装完成」才跳到 100% —— 用户看到的是「卡死了」。
  const event = parseInstallLogLine(
    "[2026-09-28 06:21:00] Installing package with Add-AppxPackage (downgrade allowed)...",
  );
  assert.equal(event.type, "stage");
  assert.equal(event.phase, "installing");
  assert.equal(event.percent, 20);
});

test("安装日志：worker 的 FATAL 行是终止状态，并带上真实原因", () => {
  // 这一行由脚本顶层的 trap 写出来（install-codex-msix-and-restart.ps1），
  // 包装路径不对、包名不对、Windows 拒绝降级都会走它。
  const event = parseInstallLogLine(
    "[2026-09-28 06:21:53] FATAL: 部署失败，原因是 HRESULT: 0x80073CF0, 无法打开包。",
  );
  assert.equal(event.type, "fatal");
  assert.equal(event.phase, "failed");
  // 关键：必须是终止状态。否则失败要等满 12 分钟超时才会浮出来，
  // 而超时消息只会说「安装超时」，真正的原因反倒被埋掉。
  assert.equal(installLogTerminal(event), "failed");
  assert.match(event.message, /FATAL/);
});

test("安装日志：无法识别的行降级为普通日志，不丢内容", () => {
  const event = parseInstallLogLine("[2026-09-28 06:21:53] 某个未来版本新增的消息");
  assert.equal(event.type, "log");
  assert.equal(event.message, "某个未来版本新增的消息");
});

// ---------- 进度爬升 ----------

test("爬升：不会越过下一个里程碑，也不会超过 99", () => {
  // 安装阶段下界 20、下一里程碑 78，所以上限是 76。
  assert.equal(creepPercent(20, 78, 0), 20);
  assert.equal(creepPercent(20, 78, 60_000), 47);
  assert.ok(creepPercent(20, 78, 10 * 60_000) <= 76, "长时间静默也必须停在下一里程碑之前");
  // 相邻阶段（下界 86、下一里程碑 90）空间很窄，不能越过上限 88。
  assert.ok(creepPercent(86, 90, 10 * 60_000) <= 88);
  assert.equal(creepPercent(100, 100, 10_000), 100);
});

test("爬升：单调不减", () => {
  let previous = 0;
  for (let elapsed = 0; elapsed <= 300_000; elapsed += 5_000) {
    const current = creepPercent(20, 78, elapsed);
    assert.ok(current >= previous, `在 ${elapsed}ms 处出现回退：${previous} -> ${current}`);
    previous = current;
  }
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
