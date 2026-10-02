// 「打开 Codex」的接线测试。纯 node，不依赖 electron，用 `npm test` 跑。
//
// 这条路径以前的写法是 fire-and-forget：发一条 explorer.exe shell:AppsFolder\...
// 就返回 { ok: true }，界面提示「已请求启动 Codex」。问题是启动后主窗口可能迟迟
// 不出现（资源搬迁真的坏了、运行时还在往本地缓存里落几百 MB、或者被一个启动对话框
// 挡住），此时上面的实现在界面上报的是成功，用户屏幕上却什么都没有，看起来就是
// 「点了没反应」，而且原因彻底丢失。
//
// 所以这里钉住五件事：
//   1. 启动必须走健康脚本的 -Probe（= 启动后等主窗口），而不是只发启动请求；
//   2. 结论必须回给界面（windowVisible / needsRepair），且没窗口时要给补救入口；
//   3. 等待窗口那段时间必须有进度事件，否则等待期又变成「没反应」；
//   4. 真的没装 Codex 时必须是可读的错误，而不是一句 ok；
//   5. **原因只能由脚本的判定给出**：主进程里不得再出现「没等到窗口就是官方那个
//      加密资源搬迁 bug」这类无条件断言（2026-10-01 的误诊就是这么来的）。

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const codexSource = read("electron", "codex.cjs");
const mainSource = read("electron", "main.cjs");
const storeSource = read("src", "state", "app.ts");
const appSource = read("src", "App.tsx");
const typesSource = read("src", "types.ts");

// 只取 launchCodex 函数体：断言必须落在这个函数里，不能靠全文匹配蒙对。
const launchBody = codexSource.match(/async function launchCodex[\s\S]*?\n\}/);
assert.ok(launchBody, "找不到 launchCodex 函数");
const launch = launchBody[0];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- 主进程 ----------

test("主进程：启动走健康脚本的 -Probe，不再是 fire-and-forget", () => {
  assert.match(launch, /bundledScript\("check-codex-desktop-health\.ps1"\)/, "启动必须复用健康脚本");
  assert.match(launch, /flags:\s*\["-Probe"\]/, "必须带 -Probe，否则不会等主窗口");
  // 原来的实现在这里直接 Start-Process explorer.exe 就收工，正是「点了没反应」的来源。
  assert.doesNotMatch(launch, /Start-Process/, "启动不能再自己发 explorer.exe 请求");
  assert.doesNotMatch(launch, /ps\.runCode\(/, "runCode 非零退出即抛错，拿不到退出码语义；端口探测要用流式");
});

test("主进程：退出码是数据，2（未安装）才是真失败", () => {
  assert.match(launch, /parseHealth\(/, "必须解析脚本输出");
  assert.match(launch, /not-installed/, "必须区分「未安装」");
  // 退出码 3 = 进程在、窗口不在，这是要如实汇报的状态，不能当成异常抛掉。
  assert.doesNotMatch(launch, /code !== 0\)\s*throw/, "退出码 3 是状态不是错误，不能按非零即失败处理");
});

test("主进程：探测没跑完时必须报错，不能当成「窗口没出现」", () => {
  // 这个分支真被踩到过：AppId 绑定在 PowerShell 5.1 下抛错，脚本在打印 RESULT= 之前
  // 就断了。把工具故障说成「你的 Codex 坏了」，会把人引去修一个不存在的资源问题。
  assert.match(launch, /if \(!health\.probeResult\)/, "缺少「探测未产出结论」的判定");
  assert.match(launch, /窗口探测没有跑完/, "必须给出可读的错误");
  assert.match(launch, /stderr: errors\.join/, "要把 stderr 带出来，否则只剩一句无从下手的提示");
});

test("主进程：窗口是否出现如实回给界面，并带上补救判定", () => {
  assert.match(launch, /probeResult === "window-visible"/);
  assert.match(launch, /windowVisible/, "必须回传 windowVisible");
  assert.match(launch, /healthNeedsRepair\(health\)/, "必须带回「是否值得修复」的判定");
  assert.match(launch, /probeMessage/, "窗口没出现时脚本的说明要留给界面");
});

test("主进程：等待窗口期间推送进度（否则等待期就是「没反应」）", () => {
  assert.match(launch, /kind:\s*"phase"/, "启动阶段要发阶段事件");
  assert.match(launch, /id:\s*"launch"/, "阶段事件要挂在 launch 这个活动上");
  // 脚本开始等窗口后就不再输出，界面的进展只能由这里自己给。
  assert.match(launch, /Probing for a visible main window/, "要拿脚本这一行当「已发出启动请求」的信号");
  assert.match(launch, /正在等待主窗口出现/);
});

test("主进程：没等到窗口时不得自己断言原因", () => {
  // 2026-10-01 的误诊：主进程在这里写着「若 N 秒内没有出现，就是官方已知的加密资源
  // 搬迁问题，可用修复资源副本处理」。而当天真实的阻塞是「运行时还在物化」（约 132 秒）
  // 加一个组织策略对话框 —— 断言是凭空下的，用户照着去修了一遍根本不存在的问题。
  //
  // 原因只能来自脚本的判定（startupDiagnosis）。这条断言就是防止那句话再被写回来。
  assert.doesNotMatch(launch, /就是官方已知的加密资源搬迁问题/);
  assert.doesNotMatch(launch, /官方已知的加密资源搬迁/);
  // 判定必须原样带回界面，而不是在这里被翻译成结论。
  assert.match(launch, /startupDiagnosis:\s*health\.startupDiagnosis/);
});

test("主进程：等待时长按总预算报，不能只说基础那一段", () => {
  // 延长是有条件的（只在「还在落运行时缓存」时发生），所以界面上的「最多 N 秒」
  // 必须报基础值 + 延长值的总和。只报 20 秒的话文案就是在撒谎：
  // 用户盯着进度条等到第 40 秒，界面却一直说「最多 20 秒」。
  assert.match(launch, /const extensionSeconds = 150;/);
  assert.match(launch, /const budgetSeconds = seconds \+ extensionSeconds;/);
  assert.match(launch, /"-ProbeExtensionSeconds":\s*extensionSeconds/);
  assert.match(launch, /最多 \$\{budgetSeconds\} 秒/);
});

test("主进程：launch_codex 必须把进度上报函数传下去", () => {
  // emit 不传的话 launchCodex 内部所有 emit 都是空操作，界面又退回静默等待。
  assert.match(mainSource, /case "launch_codex":[\s\S]{0,200}codex\.launchCodex\(args,\s*emit\)/);
});

// ---------- 渲染进程 ----------

test("渲染进程：启动期间进入 working 态并显示活动面板", () => {
  const body = storeSource.match(/launch: async[\s\S]*?\n  \},/);
  assert.ok(body, "找不到 store.launch");
  assert.match(body[0], /phase:\s*"working"/);
  assert.match(body[0], /startActivity\("launch"/);
  assert.match(body[0], /launchResult:\s*null/, "重试前要清掉上一次的结论");
});

test("渲染进程：窗口没出现时给出可点的修复入口，而不是只留一句提示", () => {
  // 只说「已请求启动」而不说结果，正是这个 bug 的用户可见形态。
  assert.doesNotMatch(storeSource, /已请求启动 Codex/);
  const banner = appSource.match(/launchWindowMissing && \([\s\S]*?\n      \)\}/);
  assert.ok(banner, "找不到「进程在、窗口不在」的横幅");
  assert.match(banner[0], /Codex 进程已启动，但主窗口没有出现/);
  assert.match(banner[0], /runRepair/, "横幅里必须能直接修复");
  assert.match(banner[0], /launchResult\?\.version/, "要说明是哪个版本启动失败");
  // 原始诊断只在一处呈现（健康面板），横幅负责结论和下一步，避免同一段
  // 脚本输出在页面上出现两遍。
  assert.doesNotMatch(banner[0], /raw-output/, "横幅不应重复健康面板里的原始诊断");
});

test("渲染进程：启动失败时不得与通用修复横幅重复", () => {
  // 启动失败那张卡片已经把「进程在、窗口不在」说全了（含修复入口），
  // 不排除掉的话同一件事会渲染两张卡片。
  //
  // 排除条件看 repairTargets，不看 needsRepair：needsRepair 含着「窗口没出现」
  // 那条探针分支，而这一档正是启动卡片自己在报的。用 needsRepair 的话两个条件
  // 在窗口缺失时同时为真，看起来像「已排除」，其实是靠 launchWindowMissing 拦下来的
  // —— 一旦哪天探针判定变了，就会多弹一张。
  assert.match(appSource, /!launchWindowMissing && repairTargets\.length > 0/);
  // 判据只能在主进程（parse.cjs 的 healthRepairTargets）里算一遍。渲染进程自己
  // 再写一次 state === "partial" 就是第二份实现，两边迟早说不到一块去。
  assert.doesNotMatch(appSource, /state === "partial"/);
});

test("类型：活动 id 覆盖 launch，启动结果与主进程字段对齐", () => {
  assert.match(typesSource, /ActivityId = [^;]*"launch"/);
  const result = typesSource.match(/interface LaunchResult \{[\s\S]*?\n\}/);
  assert.ok(result, "找不到 LaunchResult");
  // startupDiagnosis 必须在这里：界面靠它选文案、决定给不给修复按钮。
  // 少一个字段，渲染进程就只能退回「没窗口 = 那个 bug」的默认假设。
  for (const field of ["windowVisible", "probeMessage", "health", "startupDiagnosis"]) {
    assert.match(result[0], new RegExp(`${field}`), `LaunchResult 缺少 ${field}`);
  }
});

// ---------- 解析层联动 ----------

test("解析层：真实探测输出 → 无窗口时判定为需要修复", () => {
  const { parseHealth, healthNeedsRepair } = require("../electron/parse.cjs");
  const visible = parseHealth("OVERALL=ok\nAppUserModelId: OpenAI.Codex_2p2nqsd0c76g0!App\nRESULT=window-visible", 0);
  assert.equal(visible.probeResult, "window-visible");
  assert.equal(healthNeedsRepair(visible), false, "窗口出现时不该提示修复");

  const invisible = parseHealth(
    "OVERALL=ok\nRESULT=window-not-visible\n" +
      "WARNING: Codex Desktop processes are up but NO main window appeared within 180 s.\n" +
      "STARTUP_DIAGNOSIS=relocation-bug\n" +
      "This is the signature of the official encrypted-resource relocation bug.",
    3,
  );
  assert.equal(invisible.probeResult, "window-not-visible");
  assert.equal(healthNeedsRepair(invisible), true, "无窗口必须触发修复入口");
  assert.match(invisible.probeMessage, /NO main window appeared/, "诊断说明要保留给界面");
  // 原因来自脚本的判定，界面据此决定要不要提「修复资源副本」。
  assert.equal(invisible.startupDiagnosis, "relocation-bug");
});

test("解析层：判定为「还在准备」时同样没窗口，但结论是另一档", () => {
  // 这条与上一条只差一个词，但它是整个修复的核心：同样是 window-not-visible，
  // 判定不同则界面文案与修复按钮都不同。两条并排放着，防止有人把判定折叠回
  // 「没窗口 = 那个 bug」。
  const { parseHealth } = require("../electron/parse.cjs");
  const health = parseHealth(
    "OVERALL=ok\nRESULT=window-not-visible\n" +
      "WARNING: Codex Desktop processes are up but NO main window appeared within 180 s.\n" +
      "STARTUP_DIAGNOSIS=still-preparing\n" +
      "This is NOT the encrypted-resource relocation bug. Codex is still materializing its runtime into the local cache.",
    3,
  );
  assert.equal(health.probeResult, "window-not-visible");
  assert.equal(health.startupDiagnosis, "still-preparing");
  assert.match(health.probeMessage, /This is NOT the encrypted-resource relocation bug/);
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
