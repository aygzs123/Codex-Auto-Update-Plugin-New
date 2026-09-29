// 真机验证「打开 Codex」：真的启动一次 Codex 并走完「等主窗口出现」的整套流程。
//
// 为什么会需要这个脚本：这条路径的 bug 长得很特殊 —— 主进程发了启动请求就返回成功，
// 而屏幕上什么都没有，看起来就是「点了没反应」。渲染冒烟测试用桩覆盖不了它（桩永远
// 会「成功」），单元测试只能钉住接线，唯一能证明「真的能启动、真的会如实报结论」的
// 办法就是在真机上跑一遍。
//
// 副作用：会启动 Codex（这正是被测行为）。不下载、不安装、不写任何配置。
// 因此刻意不进 verify:render / npm test 链路，需要时手动跑：
//
//   npm run verify:launch
//
// 退出码：0 = 主窗口出现；3 = 进程在跑但窗口没出现（官方 bug 特征，脚本会提示修复）；
// 其余 = 真机环境问题（未安装 / PowerShell 失败）。

const { app } = require("electron");
const codex = require("../electron/codex.cjs");

const started = Date.now();

app.whenReady().then(async () => {
  console.log("真机验证：启动 Codex 并等待主窗口（不下载、不安装）\n");

  try {
    const result = await codex.launchCodex({}, (event) => {
      const elapsed = `${String((Date.now() - started) / 1000).padStart(5)}s`;
      if (event.kind === "phase") console.log(`  ${elapsed} [阶段 ${String(event.percent).padStart(3)}%] ${event.label}`);
      if (event.kind === "log") console.log(`  ${elapsed} [日志] ${event.line}`);
    });

    console.log("");
    console.log(`  版本        ：${result.version ?? "未知"}`);
    console.log(`  AppUserModelId：${result.appUserModelId ?? "未知"}`);
    console.log(`  主窗口出现  ：${result.windowVisible}`);
    console.log(`  建议修复    ：${result.health?.needsRepair}`);
    if (result.probeMessage) console.log(`  脚本诊断    ：${result.probeMessage}`);
    console.log(`  用时        ：${((Date.now() - started) / 1000).toFixed(1)}s`);

    if (result.windowVisible) {
      console.log("\n✓ 主窗口已出现：启动请求与窗口出现都成立。");
      app.exit(0);
      return;
    }
    console.log("\n✗ 进程在运行，但主窗口没有出现 —— 官方加密资源搬迁 bug 的特征。");
    console.log("  用界面上的「修复资源副本并重新启动」，或跑 docs/codex-desktop-encrypted-copy-fix/repair-codex-desktop-bundles.ps1。");
    app.exit(3);
  } catch (error) {
    console.error(`\n✗ 启动失败：${error.message}`);
    app.exit(1);
  }
});
