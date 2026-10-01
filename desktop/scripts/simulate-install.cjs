// 安装流程模拟：不下载、不安装、不碰本机 Codex，只喂一份「格式与措辞都取自真实
// 安装脚本」的日志，走一遍真实的 tailInstallLog 管线，把进度事件按时间线打出来。
//
// 为什么值得单独做：安装过程的大部分时间花在 Add-AppxPackage 上，它是安静的长任务，
// 既不输出百分比也没有任何回调，可观测通道只有 worker 写的那个日志文件。也就是说
// 「安装时界面在动」这件事本身是逻辑推导出来的，靠真实安装去验证代价太高（会真的
// 替换本机的 Codex）。这里把那条管线单独跑起来，让进度推进、静默期爬升、终止判定、
// 失败补救提示都能被看见和被断言。
//
// 日志措辞不是编的：全部来自 install-codex-msix-and-restart.ps1 里 Write-InstallLog
// 的真实调用，行格式 `[yyyy-MM-dd HH:mm:ss] 消息` 也取自该函数。
//
// 用法：
//   npx electron scripts/simulate-install.cjs                # 全部场景
//   npx electron scripts/simulate-install.cjs --scenario ok   # 单个场景

const { app } = require("electron");
const { appendFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const codex = require("../electron/codex.cjs");

// ---------- 场景 ----------

// 每项是 [相对上一个动作的等待毫秒, 日志消息]。消息与真实脚本逐字对应。
const SCENARIOS = {
  ok: {
    title: "正常安装：关闭 Codex → 安装 → 校验 → 清理 → 重启 → 窗口探针成功",
    steps: [
      [0, "Worker started for package: C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\downloads\\OpenAI.Codex_26.924.2738.0_x64__2p2nqsd0c76g0.msix"],
      [500, "Closed 2 Codex Desktop process(es)."],
      [400, "Installing package with Add-AppxPackage..."],
      [900, "Install command completed."],
      [400, "Removed superseded package file: C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\downloads\\OpenAI.Codex_26.924.2738.0_x64__2p2nqsd0c76g0.msix"],
      [300, "Restarting Codex with AppUserModelId: OpenAI.Codex_2p2nqsd0c76g0!App"],
      [400, "Restart requested. Installed version: 26.924.2738.0"],
      [500, "Probing for a visible main window (up to 30 s)..."],
      [700, "Window probe OK: Codex main window is visible."],
    ],
    expect: { ok: true, windowMissing: false, finalPercent: 100, remedy: null },
  },

  "slow-install": {
    // 演示核心难点：Add-AppxPackage 期间日志完全静默，进度条必须靠爬升继续动，
    // 且不能越过下一个里程碑（78）。真实静默期可达数分钟，这里压缩到 8 秒。
    title: "长时间静默：Add-AppxPackage 期间 8 秒无日志，进度靠有界爬升继续前进",
    steps: [
      [0, "Worker started for package: C:\\cache\\OpenAI.Codex_26.924.2738.0_x64__2p2nqsd0c76g0.msix"],
      [400, "Closed 1 Codex Desktop process(es)."],
      [300, "Installing package with Add-AppxPackage..."],
      [8000, "Install command completed."],
      [300, "Removed superseded package file: C:\\cache\\OpenAI.Codex_26.924.2738.0_x64__2p2nqsd0c76g0.msix"],
      [300, "Restart requested. Installed version: 26.924.2738.0"],
      [300, "Probing for a visible main window (up to 30 s)..."],
      [500, "Window probe OK: Codex main window is visible."],
    ],
    expect: { ok: true, windowMissing: false, finalPercent: 100, remedy: null, creptDuringSilence: true },
  },

  "cleanup-warning": {
    title: "清理告警：安装包删不掉，但安装本身成功（应为警告而不是失败）",
    steps: [
      [0, "Worker started for package: C:\\cache\\OpenAI.Codex_26.924.2738.0_x64__2p2nqsd0c76g0.msix"],
      [300, "Closed 0 Codex Desktop process(es)."],
      [300, "Installing package with Add-AppxPackage..."],
      [700, "Install command completed."],
      // 这句是 worker 里 catch 块的原话（Write-InstallLog "Package cache cleanup failed: {0}"），
      // 里面的中文异常消息来自 Windows，也正是「日志必须写 UTF-8」要保证能读出来的那类内容。
      [300, "Package cache cleanup failed: 拒绝访问。"],
      [300, "Restart requested. Installed version: 26.924.2738.0"],
      [300, "Probing for a visible main window (up to 30 s)..."],
      [500, "Window probe OK: Codex main window is visible."],
    ],
    expect: { ok: true, windowMissing: false, finalPercent: 100, remedy: null, expectWarning: true },
  },

  "window-missing": {
    // 官方加密资源搬迁 bug：Codex 起来了但主窗口没出现。这是唯一需要人工介入的结局，
    // 必须给出补救提示与健康快照。
    title: "窗口探针失败：Codex 重启了但没有主窗口（官方加密资源搬迁 bug）",
    steps: [
      [0, "Worker started for package: C:\\cache\\OpenAI.Codex_26.924.2738.0_x64__2p2nqsd0c76g0.msix"],
      [300, "Closed 1 Codex Desktop process(es)."],
      [300, "Installing package with Add-AppxPackage..."],
      [700, "Install command completed."],
      [300, "Removed superseded package file: C:\\cache\\OpenAI.Codex_26.924.2738.0_x64__2p2nqsd0c76g0.msix"],
      [300, "Restart requested. Installed version: 26.924.2738.0"],
      [300, "Probing for a visible main window (up to 30 s)..."],
      [900, "WINDOW_PROBE=FAILED: Codex restarted but NO main window appeared within 30 s."],
      [200, "This is the signature of the official encrypted-resource relocation bug."],
      [200, "Relocation health snapshot:"],
      [150, "  component win-cli    state=Missing"],
      [150, "  component win-rg     state=Missing"],
      [150, "  component wsl-cli    state=Ok"],
      [150, "  component wsl-rg     state=Ok"],
      [150, "  component cua_node   state=Missing"],
      [150, "  bundled plugins materialized: False"],
      [300, "Remedy: run docs/codex-desktop-encrypted-copy-fix/repair-codex-desktop-bundles.ps1 (from the repo root) with pwsh, then relaunch Codex."],
    ],
    expect: { ok: false, windowMissing: true, finalPercent: 100, remedy: true, expectHealthSnapshot: true },
  },

  downgrade: {
    // 回退那一跑：日志多一句 "(downgrade allowed)" 和多一条「回退已生效」的里程碑。
    // 这条用例专门盯住前者 —— 解析层以前只认不带括号的原话，于是回退时进度条
    // 卡在 12%（关闭进程）一动不动，直到最后才跳到 100%，看起来就是卡死了。
    title: "版本回退：允许降级的一跑也要走完整条进度（含降级生效里程碑）",
    steps: [
      [0, "Worker started for package: C:\\cache\\OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0.msix"],
      [300, "Closed 1 Codex Desktop process(es)."],
      [300, "Installing package with Add-AppxPackage (downgrade allowed)..."],
      [900, "Install command completed."],
      [300, "Downgrade verified. Installed version: 26.901.6511.0"],
      [300, "No superseded package file to remove; keeping cached installers for rollback."],
      [300, "Restart requested. Installed version: 26.901.6511.0"],
      [300, "Probing for a visible main window (up to 30 s)..."],
      [500, "Window probe OK: Codex main window is visible."],
    ],
    expect: { ok: true, windowMissing: false, finalPercent: 100, remedy: null, expectDowngradeMilestone: true },
  },

  "downgrade-refused": {
    // 最需要看清的一种失败：Windows 拒绝降级（-ForceUpdateFromAnyVersion 没被接受）。
    // worker 顶层的 trap 会写下 FATAL 行，tail 必须**立刻**把它当成错误抛出去，
    // 而不是傻等 12 分钟再报一句「安装超时」——那样真实原因就被埋掉了。
    title: "回退被拒：Windows 不接受降级，FATAL 立刻上报而不是等超时",
    steps: [
      [0, "Worker started for package: C:\\cache\\OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0.msix"],
      [300, "Closed 1 Codex Desktop process(es)."],
      [300, "Installing package with Add-AppxPackage (downgrade allowed)..."],
      [900, "Install command completed."],
      [300, "FATAL: Downgrade did not take effect: '26.924.2738.0' is still installed while '26.901.6511.0' was requested. Windows refused to install a lower package version. Package file kept: C:\\cache\\OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0.msix"],
    ],
    expect: {
      failure: /Downgrade did not take effect/,
      finalPercent: 100,
      // 必须在上面的 FATAL 行之后很快抛出，绝不能等到 12 分钟超时。
      maxElapsedMs: 3000,
    },
  },
  "elevated-ok": {
    // 需要管理员权限的包（新版 Codex 声明了以 localSystem 运行的打包服务，
    // 否则 Add-AppxPackage 回 0x80073D28）。worker 在拉起提权子进程之前先写一行，
    // 用户对着 UAC 弹窗的时候界面上显示的就是它 —— 不能是一动不动的 12%。
    //
    // "Elevated install worker exited with code 0." 与 "Elevated install verified..." 是
    // 提权结束后 worker 自己写的两行；解析层刻意不为它们建阶段（它们落在 78% 的安装
    // 之后，没有更靠后的里程碑可占）。
    title: "需要提权：请求管理员权限 → 提权子进程装包 → 校验 → 重启 → 窗口探针成功",
    steps: [
      [0, "Worker started for package: C:\\cache\\OpenAI.Codex_26.928.3736.0_x64__2p2nqsd0c76g0.msix"],
      [400, "Requesting administrator privileges (a UAC prompt will appear)..."],
      // UAC 弹窗期间没有任何日志 —— 真实情况下用户要想几秒到几分钟。
      [2500, "Closed 2 Codex Desktop process(es)."],
      [300, "Installing package with Add-AppxPackage..."],
      [900, "Install command completed."],
      [200, "Elevated install worker exited with code 0."],
      [200, "Elevated install verified. Installed version: 26.928.3736.0"],
      [300, "Removed superseded package file: C:\\cache\\OpenAI.Codex_26.924.2738.0_x64__2p2nqsd0c76g0.msix"],
      [300, "Restart requested. Installed version: 26.928.3736.0"],
      [300, "Probing for a visible main window (up to 30 s)..."],
      [500, "Window probe OK: Codex main window is visible."],
    ],
    expect: { ok: true, windowMissing: false, finalPercent: 100, remedy: null, expectElevatingMilestone: true },
  },

  "elevation-declined": {
    // 用户在 UAC 弹窗上点了「否」。提权子进程根本没起来，worker 自己写下 FATAL
    // （原始异常消息是系统本地化的，「操作已被用户取消。」单看它不知道发生了什么）。
    // tail 必须**立刻**把它当成错误抛出去，绝不能等满 12 分钟的超时 —— 那会把
    // 「你刚取消了授权」说成「安装超时」，用户完全不知道自己做错了什么。
    title: "提权被拒：UAC 点了否，FATAL 立刻上报而不是等超时",
    steps: [
      [0, "Worker started for package: C:\\cache\\OpenAI.Codex_26.928.3736.0_x64__2p2nqsd0c76g0.msix"],
      [400, "Requesting administrator privileges (a UAC prompt will appear)..."],
      [800, "FATAL: Elevation was declined or could not start (操作已被用户取消。). Nothing was installed and Codex was not closed."],
    ],
    expect: {
      failure: /Elevation was declined/,
      finalPercent: 100,
      maxElapsedMs: 3000,
      expectElevatingMilestone: true,
    },
  },
};

// ---------- 驱动 ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

/** 按预定节奏把日志追加进文件，模拟 worker 一边干活一边写日志。 */
async function feedLog(logPath, steps) {
  for (const [delay, message] of steps) {
    await sleep(delay);
    appendFileSync(logPath, `[${stamp()}] ${message}\n`);
  }
}

async function runScenario(name) {
  const scenario = SCENARIOS[name];
  const logPath = join(tmpdir(), `codex-simulate-${name}-${Date.now()}.log`);
  writeFileSync(logPath, "");

  console.log(`\n=== 场景 ${name} ===`);
  console.log(scenario.title);
  console.log("");

  const events = [];
  const startedAt = Date.now();
  const record = (event) => events.push({ t: Date.now() - startedAt, ...event });

  // 真实管线：tailInstallLog 每 350ms 轮询日志文件，把日志行翻译成进度事件。
  //
  // worker 自己报的失败（顶层的 trap 写下 FATAL 行）会让 tail **抛错**，所以这里要接住 ——
  // 「抛错」对失败场景来说才是正确结局，不是异常。
  const feeding = feedLog(logPath, scenario.steps);
  let result = null;
  let failure = null;
  try {
    result = await codex.tailInstallLog(logPath, record);
  } catch (error) {
    failure = error;
  }
  const elapsedMs = Date.now() - startedAt;
  await feeding;

  // 时间线里只打有信息量的进度事件，普通日志行略过（有几条就打几行太吵）。
  for (const event of events) {
    if (event.kind === "phase") {
      console.log(`  ${String(event.t).padStart(6)}ms  ${String(event.percent).padStart(3)}%  ${event.label}`);
    } else if (event.kind === "warning") {
      console.log(`  ${String(event.t).padStart(6)}ms  ⚠ ${event.message}`);
    }
  }

  const phaseEvents = events.filter((event) => event.kind === "phase");
  const warnings = events.filter((event) => event.kind === "warning");
  const logLines = events.filter((event) => event.kind === "log").length;

  // ---------- 断言 ----------
  const problems = [];

  // 进度条绝不能回退：回退比不动更伤信任。
  let previous = -1;
  for (const event of phaseEvents) {
    if (event.percent < previous) problems.push(`进度回退：${previous}% → ${event.percent}%`);
    previous = event.percent;
  }

  const finalPercent = phaseEvents.length > 0 ? phaseEvents[phaseEvents.length - 1].percent : -1;
  if (finalPercent !== scenario.expect.finalPercent) {
    problems.push(`最终进度应为 ${scenario.expect.finalPercent}%，实际 ${finalPercent}%`);
  }

  if (scenario.expect.failure) {
    // 期望的结局是抛错。这里同时盯住「抛得对不对」和「抛得够不够快」：
    // 报错晚于 12 分钟就等于没报（超时消息会把真实原因盖掉）。
    if (!failure) {
      problems.push("期望 tail 抛错上报失败，实际正常返回了");
    } else if (!scenario.expect.failure.test(failure.message)) {
      problems.push(`失败消息没带上真实原因：${failure.message.split("\n")[0]}`);
    } else if (elapsedMs > scenario.expect.maxElapsedMs) {
      problems.push(`失败上报太慢：${elapsedMs}ms > ${scenario.expect.maxElapsedMs}ms`);
    }
  } else if (failure) {
    // 这一支必须和下面分开写。tail 抛错时 result 仍是 null，而下面每一条断言都要读
    // result 的字段 —— 合在一起会在 `result.ok` 上抛 TypeError，整个进程当场死掉：
    // 刚攒下的 problems（包括这一条）不会打印，后面所有场景也不会再跑。
    // 「跑出个 TypeError，看不出哪个场景错了」比「多写一个 else if」贵得多。
    problems.push(`不该抛错，实际抛了：${failure.message.split("\n")[0]}`);
  } else {
    if (result.ok !== scenario.expect.ok) problems.push(`ok 应为 ${scenario.expect.ok}，实际 ${result.ok}`);
    if (result.windowMissing !== scenario.expect.windowMissing) {
      problems.push(`windowMissing 应为 ${scenario.expect.windowMissing}，实际 ${result.windowMissing}`);
    }
    if (Boolean(result.remedy) !== Boolean(scenario.expect.remedy)) {
      problems.push(`remedy 期望${scenario.expect.remedy ? "有" : "无"}，实际 ${result.remedy ?? "无"}`);
    }
    if (scenario.expect.expectHealthSnapshot && result.healthSnapshot.length !== 5) {
      problems.push(`期望 5 条健康快照，实际 ${result.healthSnapshot.length} 条`);
    }
    if (scenario.expect.expectDowngradeMilestone) {
      const verified = phaseEvents.filter((event) => event.label === "回退已生效");
      if (verified.length === 0) problems.push("没有出现「回退已生效」里程碑");
      // 降级里程碑必须落在「安装完成」(78) 与「重启」之间，否则要么被吞掉、要么看起来在倒退。
      const percent = verified[0]?.percent ?? 0;
      if (percent <= 78 || percent >= 90) problems.push(`「回退已生效」百分比应在 78~90 之间，实际 ${percent}`);
      const installing = phaseEvents.filter((event) => event.label === "Windows 正在安装 Codex");
      if (installing.length === 0) problems.push("带 (downgrade allowed) 的那行没有推进到「正在安装」阶段");
    }
  }

  if (scenario.expect.expectElevatingMilestone) {
    // 提权阶段必须落在关闭(12)与安装(20)之间：写小了会被 12 吞掉（用户看不到
    // 「在等 UAC」，只看到进度条卡住），写大了会让后面的安装里程碑看起来在倒退。
    const elevating = phaseEvents.filter((event) => event.phase === "elevating");
    if (elevating.length === 0) problems.push("没有出现「正在请求管理员权限」阶段");
    const percent = elevating[0]?.percent ?? 0;
    if (percent <= 12 || percent >= 20) problems.push(`提权阶段百分比应在 12~20 之间，实际 ${percent}`);
    // 提权成功之后必须能接着走到安装，而不是停在提权那一步。
    if (scenario.expect.ok) {
      const installing = phaseEvents.filter((event) => event.label === "Windows 正在安装 Codex");
      if (installing.length === 0) problems.push("提权之后没有推进到安装阶段");
    }
  }

  if (scenario.expect.expectWarning && warnings.length === 0) problems.push("期望出现清理告警，实际没有");
  if (logLines === 0) problems.push("没有转发任何日志行，界面日志区会是空的");

  // 静默期爬升：Add-AppxPackage 期间没有任何日志，进度必须仍在前进，
  // 且不能越过下一个里程碑 78%（越过就等于在没完成时宣称完成了）。
  if (scenario.expect.creptDuringSilence) {
    const crept = phaseEvents.filter(
      (event) => event.percent > 20 && event.percent < 78 && event.label === "Windows 正在安装 Codex",
    );
    if (crept.length === 0) problems.push("静默期进度没有推进，进度条会卡死");
    const maxCrept = Math.max(...crept.map((event) => event.percent), 0);
    if (maxCrept >= 78) problems.push(`静默期爬升越过里程碑：${maxCrept}% ≥ 78%`);
    console.log(`\n  静默期爬升：20% → ${maxCrept}%（上限 76%，未越过 78% 里程碑，共 ${crept.length} 次推进）`);
  }

  console.log(`\n  日志行 ${logLines} 条，进度事件 ${phaseEvents.length} 个，告警 ${warnings.length} 个`);
  if (failure) {
    console.log(`  第 ${elapsedMs}ms 抛出失败：${failure.message.split("\n")[0]}`);
  } else {
    console.log(`  ok=${result.ok} windowMissing=${result.windowMissing} remedy=${result.remedy ? "有" : "无"}`);
    if (result.version) console.log(`  收尾健康自检读到版本：${result.version}`);
  }

  if (problems.length > 0) {
    console.error("\n  ✗ 场景失败：");
    for (const problem of problems) console.error(`    - ${problem}`);
  } else {
    console.log("  ✓ 场景通过");
  }

  rmSync(logPath, { force: true });
  return problems.length === 0;
}

// ---------- 入口 ----------

async function main() {
  const index = process.argv.indexOf("--scenario");
  const names = index >= 0 ? [process.argv[index + 1]] : Object.keys(SCENARIOS);

  console.log("安装流程模拟（不下载、不安装、不修改本机 Codex）");
  console.log("日志措辞取自 install-codex-msix-and-restart.ps1 的真实 Write-InstallLog 调用");

  const results = [];
  for (const name of names) {
    if (!SCENARIOS[name]) {
      console.error(`\n未知场景：${name}。可用：${Object.keys(SCENARIOS).join(", ")}`);
      app.exit(1);
      return;
    }
    results.push(await runScenario(name));
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} 个场景通过`);
  app.exit(passed === results.length ? 0 : 1);
}

app.whenReady().then(main).catch((error) => {
  console.error("✗ 模拟异常：", error);
  app.exit(1);
});
