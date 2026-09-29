// 后端联调检查：在真实的 Electron 运行时里跑 codex.cjs，确认内置脚本能被找到、
// PowerShell 桥接能调用、解析层对得上脚本的真实输出。
//
// 为什么不放进 `npm test`：check_update 要访问 store.rg-adguard.net，是有网络的
// 集成检查，不适合当单元测试。单独用 `npm run verify:backend` 手动跑。
//
// 刻意不触发下载与安装：那会真的改动本机的 Codex。这里只读。

const { app } = require("electron");
const codex = require("../electron/codex.cjs");

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log(`打包态：${app.isPackaged}`);
  console.log(`脚本目录：${codex.scriptRoot()}`);

  // 1) 五个内置脚本都要找得到。asar 不能执行 .ps1，所以这验证的是 extraResources
  //    （打包态）或同步产物（开发态）确实就位。
  const scriptNames = [
    "CodexStoreUpdater.psm1",
    "check-codex-update.ps1",
    "install-codex-msix-and-restart.ps1",
    "check-codex-desktop-health.ps1",
    "repair-codex-desktop-bundles.ps1",
  ];
  const missing = scriptNames.filter((name) => {
    try {
      codex.bundledScript(name);
      return false;
    } catch {
      return true;
    }
  });
  check("五个内置脚本全部就位", missing.length === 0, missing.length ? `缺失：${missing.join(", ")}` : `共 ${scriptNames.length} 个`);

  // 2) 真实健康检查：走完整链路（ps.cjs → powershell.exe → 解析）。
  const health = await codex.getStatus();
  check("get_status 解析出安装状态", typeof health.installed === "boolean", `installed=${health.installed}`);
  check("get_status 解析出版本号", !health.installed || /^\d+\.\d+/.test(String(health.version)), `version=${health.version}`);
  check(
    "get_status 解析出 5 个资源组件",
    !health.installed || health.components.length === 5,
    `实际 ${health.components.length} 个：${health.components.map((c) => `${c.name}=${c.state}`).join(", ")}`,
  );
  check("get_status 解析出 OVERALL", health.overall !== "unknown", `overall=${health.overall}`);

  // 3) 真实更新检查（需要网络）。
  const update = await codex.checkUpdate({});
  check("check_update 解析出可用版本", /^\d+\.\d+/.test(String(update.availableVersion)), `available=${update.availableVersion}`);
  check("check_update 解析出安装包文件名", /^OpenAI\.Codex_.+\.(msix|msixbundle)$/i.test(String(update.fileName)), `${update.fileName}`);
  check("check_update 给出是否可更新", typeof update.updateAvailable === "boolean", `updateAvailable=${update.updateAvailable}`);
  check(
    "check_update 的已安装版本与 get_status 一致",
    update.installedVersion === health.version,
    `check=${update.installedVersion} / status=${health.version}`,
  );

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
  app.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(main).catch((error) => {
  console.error("✗ 后端联调检查异常：", error);
  app.exit(1);
});
