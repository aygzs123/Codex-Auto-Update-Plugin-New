// 解析层测试。纯 node，不依赖 electron，用 `npm test` 跑。
//
// 这些用例的价值在于把「脚本输出格式」当成契约钉住：exe 复用仓库里已有的
// PowerShell 脚本，一旦上游脚本改了输出措辞，这里必须先红，而不是等到界面上
// 显示出一片空白才发现。

const assert = require("node:assert/strict");
const {
  parseHealth,
  healthNeedsRepair,
  healthRepairTargets,
  parseUpdateCheck,
  parseCachedPackages,
  partialNameFor,
  parseInstallLogLine,
  installLogTerminal,
  creepPercent,
  normalizeStartupDiagnosis,
  STARTUP_DIAGNOSIS_VALUES,
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
  // 光是 needsRepair 为 true 证明不了什么 —— 这个夹具四种状态齐全，只要判据里还留着
  // 任何一条「非 ok 就算数」的分支它都会通过。真正钉住收窄的是这一行：只点名 partial 那个。
  assert.deepEqual(healthRepairTargets(health), ["wsl-cli"]);
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
  // 进程在跑但没有窗口 —— 这只是**事实**，不再等于加密资源搬迁 bug（2026-10-01 的
  // 误诊就是这么来的：健康机器首次启动要物化几百 MB，30 秒探针必然超时）。
  // 修复入口照旧给（修复脚本幂等，用户手动点也无害），但原因由 startupDiagnosis 决定。
  assert.equal(healthNeedsRepair(invisible), true);
  assert.match(invisible.probeMessage, /NO main window appeared/);
});

// ---------- 启动判定（STARTUP_DIAGNOSIS）----------
// 三档判定是脚本给出的结论，解析层只负责原样搬运 + 把不认识的值收成 null。
// 这一层绝不能自己「推断」原因 —— 那正是被修掉的 bug。

test("启动判定：三个合法值都解析出来", () => {
  assert.deepEqual(STARTUP_DIAGNOSIS_VALUES, ["still-preparing", "relocation-bug", "unknown"]);
  for (const verdict of STARTUP_DIAGNOSIS_VALUES) {
    const health = parseHealth(`${REAL_HEALTH_OK}\nRESULT=window-not-visible\nSTARTUP_DIAGNOSIS=${verdict}`, 3);
    assert.equal(health.startupDiagnosis, verdict);
  }
});

test("启动判定：没有这一行时是 null（老脚本、探针成功或没跑判定）", () => {
  assert.equal(parseHealth(`${REAL_HEALTH_OK}\nOVERALL=ok`, 0).startupDiagnosis, null);
  // 探针成功的那一跑不会有判定行，别把它当成「缺了什么」。
  assert.equal(parseHealth(`${REAL_HEALTH_OK}\nRESULT=window-visible`, 0).startupDiagnosis, null);
});

test("启动判定：不认识的值收成 null，不让它漏到界面上", () => {
  // 老脚本不会写这一行，但**新脚本 + 老界面**这个组合将来一定出现（用户升级了插件
  // 但没升级桌面端）。把未知值原样带下去，界面就会拿着一个没有文案映射的字符串去
  // 查表，最轻是显示空白，最重是当成 relocation-bug 又把人推回误诊。
  assert.equal(normalizeStartupDiagnosis("some-future-verdict"), null);
  assert.equal(normalizeStartupDiagnosis(""), null);
  assert.equal(normalizeStartupDiagnosis(null), null);
  assert.equal(normalizeStartupDiagnosis(undefined), null);
  assert.equal(normalizeStartupDiagnosis("RELOCATION-BUG"), null, "大小写不匹配的一律不收");
  assert.equal(
    parseHealth(`${REAL_HEALTH_OK}\nRESULT=window-not-visible\nSTARTUP_DIAGNOSIS=some-future-verdict`, 3)
      .startupDiagnosis,
    null,
  );
});

test("启动判定：健康侧的判定**不**独自触发修复入口", () => {
  // 修复入口由 healthNeedsRepair 决定（组件状态 + 探针结果），判定只改文案。
  // 这条钉住「判定与修复入口解耦」：不然后面有人顺手加一条
  // `|| health.startupDiagnosis === "relocation-bug"`，就等于把误诊又装回来。
  const health = parseHealth(`${REAL_HEALTH_OK}\nRESULT=window-not-visible\nSTARTUP_DIAGNOSIS=unknown`, 3);
  assert.equal(health.startupDiagnosis, "unknown");
  assert.equal(healthNeedsRepair(health), true, "全 OK 的组件 + 无窗口，入口照旧给");
});

test("启动判定：三档说明句都进 probeMessage，健康面板才看得见「不是搬迁 bug」", () => {
  // 只收 WARNING 的话，「这不是搬迁 bug」和「判不出原因」这两档在健康面板里就只剩一句
  // 冷冰冰的 WARNING —— 用户照样会去点「修复资源副本」。
  const stillPreparing = parseHealth(
    [
      REAL_HEALTH_OK,
      "RESULT=window-not-visible",
      "WARNING: Codex Desktop processes are up but NO main window appeared within 180 s.",
      "STARTUP_DIAGNOSIS=still-preparing",
      "This is NOT the encrypted-resource relocation bug. Codex is still materializing its runtime into the local cache. Recent write activity: written within the last 90 s: C:\\a\\bin.",
    ].join("\n"),
    3,
  );
  assert.equal(stillPreparing.startupDiagnosis, "still-preparing");
  assert.match(stillPreparing.probeMessage, /NO main window appeared within 180 s/);
  assert.match(stillPreparing.probeMessage, /This is NOT the encrypted-resource relocation bug/);

  const unknown = parseHealth(
    [
      REAL_HEALTH_OK,
      "RESULT=window-not-visible",
      "STARTUP_DIAGNOSIS=unknown",
      "No cause could be determined from the relocation-health evidence. This is not, by itself, evidence of the encrypted-resource relocation bug. Evidence: none.",
    ].join("\n"),
    3,
  );
  assert.equal(unknown.startupDiagnosis, "unknown");
  assert.match(unknown.probeMessage, /No cause could be determined/);
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

// ---------- 资源修复入口的判据（只认「未完成的物化残留」）----------
//
// 这一组是 2026-10-02 那次误报的回归闸门。旧判据是 `state !== "ok"`，于是凡是有任何一项
// 不在就算数 —— 用户那台机器上命中的是 wsl-cli（WSL 侧那份 CLI 副本，跟 Windows 桌面端
// 能不能开窗口是两件事），页面因此常驻一张「Codex 可能无法正常打开窗口」的横幅，
// 而他的 Codex 打开完全正常。
//
// 注意这一组是 CI 唯一钉得住本次修复的地方：ci.yml 只跑 npm test 与 verify:simulate，
// 不跑 verify:render（那边是渲染冒烟，夹具是手写的、根本不经过 healthNeedsRepair）。

// 本机 2026-10-02 的真实输出（原文照抄，含那个尾巴上的 leftovers: 0）。
const REAL_HEALTH_WSL_MISSING = [
  "Package  : OpenAI.Codex_26.928.3736.0_x64__2p2nqsd0c76g0",
  "Version  : 26.928.3736.0",
  "Location : C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.928.3736.0_x64__2p2nqsd0c76g0",
  "[OK   ] win-cli      C:\\Users\\lijunyuan\\AppData\\Local\\OpenAI\\Codex\\bin\\de8a38d2100ae498",
  "[OK   ] win-rg       C:\\Users\\lijunyuan\\AppData\\Local\\OpenAI\\Codex\\bin\\5cb96978b0b525f8",
  "[MISS ] wsl-cli      C:\\Users\\lijunyuan\\.codex\\bin\\wsl\\65bf23c0b8844a0d  <- staging/repair leftovers: 0",
  "[OK   ] wsl-rg       C:\\Users\\lijunyuan\\.codex\\bin\\wsl\\1a4f6f66dd2f3710",
  "[OK   ] cua_node     C:\\Users\\lijunyuan\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\154806497bb51bae",
  "Plugins  : NOT materialized (bundled plugins stale)",
  "OVERALL=degraded",
].join("\n");

test("资源修复入口：本机形态（wsl-cli 缺失、无残留）不触发", () => {
  const health = parseHealth(REAL_HEALTH_WSL_MISSING, 1);
  assert.equal(health.installed, true);
  assert.equal(health.overall, "degraded");
  assert.equal(health.components.find((component) => component.name === "wsl-cli").state, "missing");
  // missing = 目标目录不在、连残留都没有。首次启动前五项全是这个状态，它是常态而不是
  // 故障证据；拿它当触发条件，就是用户 2026-10-02 看到的那张常驻横幅。
  assert.equal(healthNeedsRepair(health), false, "missing 没有残留，不是物化失败的证据");
  assert.deepEqual(healthRepairTargets(health), []);
});

test("资源修复入口：partial（目标不在 + 有 .staging 残留）才触发并点名", () => {
  const health = parseHealth(
    [
      "Package  : OpenAI.Codex_26.928.3736.0_x64__2p2nqsd0c76g0",
      "Version  : 26.928.3736.0",
      "[PART ] wsl-cli      C:\\x\\.codex\\bin\\wsl\\65bf23c0b8844a0d  <- staging/repair leftovers: 3",
      "OVERALL=degraded",
    ].join("\n"),
    1,
  );
  assert.equal(health.components[0].leftovers, 3);
  assert.equal(healthNeedsRepair(health), true);
  assert.deepEqual(healthRepairTargets(health), ["wsl-cli"]);
});

test("资源修复入口：error（MSIX 源文件缺失）不触发", () => {
  // error = Get-BundleIdText 抛 Source file missing。修复脚本正是从那份源复制，
  // 会在算 bundle id 时就抛出、整条脚本 exit 1，还会连累其它本来能修的组件 ——
  // 给入口等于指一条走不通的路。
  const health = parseHealth(
    ["[ERR  ] cua_node     C:\\x  <- staging/repair leftovers: 0", "OVERALL=degraded"].join("\n"),
    1,
  );
  assert.equal(health.components[0].state, "error");
  assert.equal(healthNeedsRepair(health), false);
  assert.deepEqual(healthRepairTargets(health), []);
});

test("资源修复入口：混在一起时只点名 partial 的那些", () => {
  const health = parseHealth(
    [
      "[MISS ] win-rg       C:\\a  <- staging/repair leftovers: 0",
      "[PART ] wsl-cli      C:\\b  <- staging/repair leftovers: 2",
      "[ERR  ] cua_node     C:\\c  <- staging/repair leftovers: 0",
      "OVERALL=degraded",
    ].join("\n"),
    1,
  );
  assert.equal(healthNeedsRepair(health), true);
  assert.deepEqual(healthRepairTargets(health), ["wsl-cli"]);
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

test("安装日志：需要提权的那一跑也有完整阶段", () => {
  const lines = [
    "[2026-09-28 06:20:31] Worker started for package: C:\\dl\\OpenAI.Codex_26.928.3736.0_x64__2p2nqsd0c76g0.msix",
    "[2026-09-28 06:20:33] Requesting administrator privileges (a UAC prompt will appear)...",
    "[2026-09-28 06:20:41] Closed 2 Codex Desktop process(es).",
    "[2026-09-28 06:20:41] Installing package with Add-AppxPackage...",
    "[2026-09-28 06:22:10] Install command completed.",
    "[2026-09-28 06:22:10] Elevated install worker exited with code 0.",
    "[2026-09-28 06:22:10] Elevated install verified. Installed version: 26.928.3736.0",
    "[2026-09-28 06:22:11] Restart requested. Installed version: 26.928.3736.0",
    "[2026-09-28 06:22:11] Probing for a visible main window (up to 30 s)...",
    "[2026-09-28 06:22:16] Window probe OK: Codex main window is visible.",
  ];
  const parsed = lines.map(parseInstallLogLine);
  assert.deepEqual(
    parsed.map((event) => event.phase),
    [
      "preparing",
      "elevating",
      "closing",
      // 提权子进程结束后 worker 写的两行刻意不建阶段：它们落在 78% 的安装之后，
      // 没有更靠后的里程碑可占，硬塞一个只会让进度条看起来在倒退。
      "installing",
      "verifying",
      undefined,
      undefined,
      "restarting",
      "probing",
      "done",
    ],
  );
  // 提权必须落在关闭(12)与安装(20)之间：写小了会被关闭那一步吞掉，
  // 用户就看不到「正在等 UAC」这句话，只看到进度条卡在那里。
  //
  // 这里只看数值的相对大小，不看「日志顺序里单调递增」—— 日志顺序是
  // 4 → 14 → 12 → 20（提权子进程装完才写「Closed N」），单调性由 tail 的
  // Math.max 保证，simulate-install.cjs 的 elevated-ok 场景盯的就是那一条。
  const elevating = parsed[1];
  assert.ok(elevating.percent > parsed[2].percent, "提权阶段要排在关闭进程之前");
  assert.ok(elevating.percent < parsed[3].percent, "提权阶段要排在安装之前");
  assert.equal(installLogTerminal(parsed[9]), "success");
});

test("安装日志：提权被取消是一条 FATAL，不是「还在等」", () => {
  const event = parseInstallLogLine(
    "[2026-09-28 06:20:41] FATAL: Elevation was declined or could not start (操作已被用户取消。). Nothing was installed and Codex was not closed.",
  );
  assert.equal(event.type, "fatal");
  assert.equal(installLogTerminal(event), "failed");
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

test("安装日志：判定行紧跟探针失败，但它自己不是终止状态", () => {
  // 顺序即契约：`WINDOW_PROBE=FAILED` 在前，`STARTUP_DIAGNOSIS=` 紧跟其后。
  // 判定行**不是**终态：终态仍由 probe-failed（window-missing）决定，它只是把「为什么」补上。
  // 若它变成终态，tail 会提前收工，后面那整段窗口清单必然被丢掉 —— 而窗口清单恰恰是
  // 「30 秒没等到窗口」时最该看的东西。
  for (const verdict of STARTUP_DIAGNOSIS_VALUES) {
    const event = parseInstallLogLine(`[2026-09-28 06:22:23] STARTUP_DIAGNOSIS=${verdict}`);
    assert.equal(event.type, "startup-diagnosis");
    assert.equal(event.verdict, verdict);
    assert.equal(installLogTerminal(event), null, `${verdict} 不该是终止状态`);
    // 也不能带 phase：带了就会走 tail 的阶段推进分支，失败路径上进度条会先跳一次。
    assert.equal(event.phase, undefined);
  }
});

test("安装日志：判定值不认识时 verdict 是 null，类型仍是 startup-diagnosis", () => {
  const event = parseInstallLogLine("[2026-09-28 06:22:23] STARTUP_DIAGNOSIS=who-knows");
  assert.equal(event.type, "startup-diagnosis");
  assert.equal(event.verdict, null);
  // 类型不退化：退化成 log 的话，`STARTUP_DIAGNOSIS=` 会作为普通日志行渲染出来，
  // 而 tail 里 `if (event.type === "startup-diagnosis")` 也就永远等不到值。
  assert.notEqual(event.type, "log");
});

test("安装日志：三档说明句都识别成 note，且都不驱动任何动作", () => {
  // 「说明」与「动作」必须分开：动作只看 startup-diagnosis。把说明句也接进动作，
  // 就等于让一句文案决定要不要建议用户跑修复脚本。
  const sentences = [
    "[2026-09-28 06:22:23] This is NOT the encrypted-resource relocation bug. Codex is still materializing its runtime into the local cache. Recent write activity: written within the last 90 s: C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin (win-cli).",
    "[2026-09-28 06:22:23] This is the signature of the official encrypted-resource relocation bug.",
    "[2026-09-28 06:22:23] No cause could be determined from the relocation-health evidence. This is not, by itself, evidence of the encrypted-resource relocation bug. Evidence: none.",
    "[2026-09-28 06:22:23] Next: check the app's own logs under %LOCALAPPDATA%\\OpenAI\\Codex, and whether a Codex dialog or a crash is blocking the main window.",
    "[2026-09-28 06:22:23] Window inventory unavailable.",
  ];
  for (const line of sentences) {
    const event = parseInstallLogLine(line);
    assert.equal(event.type, "note", `${event.message} 应为 note`);
    assert.equal(installLogTerminal(event), null);
    assert.equal(event.phase, undefined);
  }
  // 最关键的一条：「这不是搬迁 bug」这句**绝不能**被当成补救提示。
  // 补救提示是界面渲染修复按钮的依据，认错就等于误诊原样复现。
  const notBug = parseInstallLogLine(
    "[2026-09-28 06:22:23] This is NOT the encrypted-resource relocation bug. Codex is still materializing its runtime into the local cache.",
  );
  assert.equal(notBug.type, "note");
  assert.equal(notBug.remedy, undefined);
});

test("安装日志：窗口清单行降级为普通日志，但标题原样保留", () => {
  // 清单行不进事件类型是有意的：它是给人看的原始证据，界面按普通日志渲染即可。
  // 但整行内容必须一字不差地传下去 —— 用户的启动对话框标题正是靠它才浮出来。
  const event = parseInstallLogLine('[2026-09-28 06:22:23]   pid=4212 owned=True class=#32770 title="无法加载组织设置"');
  assert.equal(event.type, "log");
  assert.match(event.message, /无法加载组织设置/);
  assert.equal(installLogTerminal(event), null);

  // 一个窗口都没有时脚本写的是这句。它同样只是普通日志，不是终止、也不带阶段。
  const none = parseInstallLogLine("[2026-09-28 06:22:23]   (none visible)");
  assert.equal(none.type, "log");
  assert.equal(installLogTerminal(none), null);
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
