// 安装需要管理员权限（HRESULT 0x80073D28）。
//
// 用户实际撞到的失败：
//
//   安装失败：FATAL: 部署失败，原因是 HRESULT: 0x80073D28, 该程序包安装失败，
//   因为需要管理员权限。请联系一名管理员以安装此程序包。
//
// 原因不在这个仓库里：新版 Codex 的 AppxManifest.xml 声明了一个以 localSystem 运行的
// 打包服务（`<desktop6:Extension Category="windows.service">`），Windows 于是要求
// **管理员上下文**才能 Add-AppxPackage。已安装的 26.901.6511.0 没有这个服务，
// 所以这道门槛是这次升级才第一次出现的，而且以后每一版都会有。
//
// 两条用户已经定下的边界：
//   桌面端 —— 需要时自动提权：仍然一键，但不再静默，接受弹一次 UAC。
//   自动化 —— 不弹，只如实报告：后台不能挂在一个无人值守的 UAC 弹窗上。
//
// 这份测试钉的是「提权长在哪个位置、参数怎么传、失败怎么说」，因为这几件事坏掉的方式
// 都很安静：
//   · 提权要是挪到 launcher 上，界面会永久停在「正在安装」（ps.cjs 没有超时，
//     而 tail 的 12 分钟超时是 launcher 退出之后才开始的）；
//   · 提权子进程要是漏了 -LogPath，桌面端 tail 的日志一个字都不涨，用户等满 12 分钟
//     看到「安装超时」，而安装其实成功了；
//   · 自动化那边要是让 worker 在后台异步失败，调用点只看「有没有拉起来」，会报成功。

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const repo = join(root, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");
const readPlugin = (...parts) =>
  readFileSync(join(repo, "plugins", "codex-ms-desktop-updater", ...parts), "utf8");

const moduleText = readPlugin("scripts", "CodexStoreUpdater.psm1");
const worker = readPlugin("scripts", "install-codex-msix-and-restart.ps1");
const checkScript = readPlugin("scripts", "check-codex-update.ps1");
const maintenanceScript = readPlugin("scripts", "run-automatic-maintenance.ps1");
const codexSource = read("electron", "codex.cjs");
const parseSource = read("electron", "parse.cjs");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- 探测：什么样的包需要提权 ----------

test("模块：按 Category 属性值认打包服务，不认命名空间前缀", () => {
  // windows.service 是架构规定好的 Category 取值；desktop6 只是当前碰巧用了哪个
  // 命名空间前缀。将来换成 desktop7，认前缀的写法会一声不吭地失效，
  // 表现就是「又回去报 0x80073D28」。
  assert.match(
    moduleText,
    /Category\\s\*=\\s\*"windows\\\.service"/,
    "识别条件必须是 Category 属性值 windows.service",
  );
  // 5.1 下 [System.IO.Compression.ZipFile] 不是自动加载的，少了 Add-Type，
  // 下面那行抛「Unable to find type」，而失败要开放会把异常吞掉 ——
  // 于是每个包都被判成「不用提权」，功能一声不吭地全废。
  assert.match(moduleText, /Add-Type -AssemblyName System\.IO\.Compression\.FileSystem/, "必须显式加载压缩程序集");
  // 句柄要关：worker 判完之后还要在同一个进程里用 Add-AppxPackage 打开这个文件。
  assert.match(moduleText, /\$archive\.Dispose\(\)/, "读完必须释放 zip 句柄");
  assert.match(moduleText, /Test-CodexPackageRequiresElevation, /, "探测函数必须在 Export-ModuleMember 里（check-codex-update.ps1 要用）");
});

test("模块：bundle 要透过内层 .msix 看清单", () => {
  // .msixbundle 里装的是若干个完整的 .msix（嵌套的 zip），不是一批名叫
  // AppxManifest.xml 的条目。只枚举外层的话，bundle 的清单一条都看不见 ——
  // 而 Get-ExtensionRank 把 msixbundle 排在 msix 之上，商店提供 bundle 时会优先选它。
  assert.match(moduleText, /msix\|appx/, "要枚举内层 .msix/.appx 条目");
  assert.match(
    moduleText,
    /Test-CodexArchiveRequiresElevation -Archive \$innerArchive/,
    "内层包要当一个独立的 zip 打开再看它的清单",
  );
});

// ---------- 桌面端：提权发生在 worker 里，不在 launcher 里 ----------

test("桌面端：一键更新与回退都带上 -AllowElevation", () => {
  // 用户选择的是「需要时自动提权」，而不是「遇到这种包就失败」。回退走的是同一个
  // install_codex IPC，所以两条路都要有 —— 漏掉回退的话，缓存里那两个包（都带服务）
  // 谁也装不回去，回退功能等于废掉。
  assert.match(
    codexSource,
    /flags: allowDowngrade\s*\?\s*\["-AllowElevation", "-AllowDowngrade", KEEP_ALL_CACHE\]\s*:\s*\["-AllowElevation", KEEP_ALL_CACHE\]/,
    "installCodex 必须无条件带 -AllowElevation",
  );
  // 无条件 = 两个分支里都有，不能只写在降级那一支上。
  const flags = codexSource.match(/flags: allowDowngrade[\s\S]*?\],/)[0];
  const elevationCount = (flags.match(/"-AllowElevation"/g) ?? []).length;
  assert.equal(elevationCount, 2, `两个分支都要有 -AllowElevation，实际 ${elevationCount} 处`);
});

test("worker：提权分支排在「Worker started」之前，且只做关 + 装", () => {
  // 提权子进程要是也写一遍 "Worker started for package"（对应 4% 的「准备安装」），
  // 界面会在已经走到「正在请求管理员权限」（14%）之后又收到一条 4% 的旧阶段：
  // 百分比被 Math.max 挡住不会退，措辞却跳回去了。
  const elevatedBranch = worker.indexOf("if ($ElevatedWorker) {");
  const workerStarted = worker.indexOf('Write-InstallLog ("Worker started for package:');
  assert.ok(elevatedBranch >= 0, "worker 要有 -ElevatedWorker 分支");
  assert.ok(elevatedBranch < workerStarted, "提权子进程分支必须排在 Worker started 之前");

  // 切到分支的结尾用正则而不是 indexOf("\n}\n")：CI 是 CRLF 检出，本地是 LF。
  const branchMatch = worker.slice(elevatedBranch).match(/^if \(\$ElevatedWorker\) \{([\s\S]*?)\r?\n\}/);
  assert.ok(branchMatch, "提权子进程分支要有闭合的块");
  const branchBody = branchMatch[1];
  assert.match(branchBody, /Invoke-CodexInstallSteps/, "提权子进程要真的装包");
  // 从**提权**进程发 explorer.exe shell:AppsFolder 激活请求行为不确定（可能起不来，
  // 也可能把 Codex 拉成管理员进程）。所以重启与探测必须留在非提权的 worker 里。
  assert.doesNotMatch(branchBody, /explorer\.exe|Test-CodexDesktopWindowUp/, "提权子进程不得负责重启与窗口探测");
});

test("worker：提权在关掉 Codex 之前判定", () => {
  // 装不上就不该先把人家正在编辑的窗口关了。只看 worker 那段 ——
  // 提权子进程分支里也有一次同样的调用，拿全文比会指到它。
  const body = worker.slice(worker.indexOf('Write-InstallLog ("Worker started for package:'));
  const checked = body.indexOf("Test-CodexPackageRequiresElevation -Path $resolvedPackagePath");
  const closes = body.indexOf("Invoke-CodexInstallSteps -PackageName $PackageName");
  assert.ok(checked >= 0, "worker 要判定包需不需要提权");
  assert.ok(closes >= 0, "worker 要调用抽出来的安装步骤");
  assert.ok(checked < closes, "判定必须排在关 Codex / 装包之前");
});

test("worker：提权子进程的参数必须完整且逐个补引号", () => {
  // 子进程是新进程，开关不会自己跟过去。尤其是 -LogPath：少了它，提权子进程会落回
  // 插件目录下的默认日志，桌面应用 tail 的那个文件一个字都不涨 —— 用户等满 12 分钟
  // 只看到「安装超时」，而安装其实成功了。
  const start = worker.indexOf("function Invoke-CodexElevatedInstall");
  assert.ok(start >= 0, "worker 要有拉起提权子进程的函数");
  // 同样用 \r?\n 收尾：CI 是 CRLF 检出，本地是 LF。
  const fnMatch = worker.slice(start).match(/^function Invoke-CodexElevatedInstall \{[\s\S]*?\r?\n\}/);
  assert.ok(fnMatch, "提权子进程那段函数要有闭合的块");
  const elevatedFunction = fnMatch[0];
  assert.match(elevatedFunction, /"-File", \$PSCommandPath/, "子进程要跑同一个脚本");
  assert.match(elevatedFunction, /"-ElevatedWorker"/, "子进程要进提权模式");
  assert.match(elevatedFunction, /"-LogPath", \$LogPath/, "必须把 -LogPath 传下去");
  assert.match(elevatedFunction, /"-PackagePath", \$PackagePath/, "必须把包路径传下去");
  assert.match(
    elevatedFunction,
    /if \(\$AllowDowngrade\) \{\s*\$elevatedArguments \+= "-AllowDowngrade"/,
    "回退时要透传 -AllowDowngrade，否则子进程会用严格模式装一个更低的版本（Windows 拒绝）",
  );

  // 5.1 的 -ArgumentList 收到数组只会用空格拼起来、不加引号，而本应用的日志目录固定叫
  // %APPDATA%\Codex Updater\logs —— 那个空格每个用户都有。
  assert.match(elevatedFunction, /\$quotedElevatedArguments -join " "/, "参数要补引号后拼成单个字符串");
  assert.doesNotMatch(elevatedFunction, /-ArgumentList \$elevatedArguments/, "不能把裸数组交给 Start-Process");
  assert.match(elevatedFunction, /-Verb RunAs/, "要用 RunAs 提权");

  // -Verb RunAs 走的是 ShellExecuteEx，拿回来的退出码不可靠 —— 它只能记录，不能当判据。
  assert.match(worker, /Elevated install did not take effect/, "装没装上要以版本校验收场");
});

test("worker：探测失灵时按 0x80073D28 兜底重试", () => {
  // 探测认不出来的情况是有的（清单读不出来、包结构没见过）。有这条兜底，
  // 「探测失灵」的代价只是多弹一次 UAC，而不是让用户看到一个生 HRESULT。
  assert.match(worker, /0x80073D28/, "Add-AppxPackage 报 0x80073D28 时要改成提权重试");
});

test("worker：提权被取消要说清楚，且原有日志措辞一字未动", () => {
  assert.match(worker, /Elevation was declined or could not start/, "UAC 被拒绝要给出能直接读的原因");
  assert.match(worker, /Codex was not closed/, "要说清楚什么都没改动");
  // 措辞被 desktop/tests/parse.test.cjs 逐字钉着（那里有注释说明「不要改成近义表述」），
  // 把这段抽成函数时不能顺手改写。
  assert.match(
    worker,
    /Write-InstallLog "Installing package with Add-AppxPackage\.\.\."\r?\n/,
    "严格安装那条日志措辞不能变",
  );
  assert.match(
    worker,
    /Write-InstallLog "Installing package with Add-AppxPackage \(downgrade allowed\)\.\.\."/,
    "降级那条日志措辞不能变",
  );
  assert.match(worker, /Write-InstallLog "Install command completed\."/, "收尾那条日志措辞不能变");
});

// ---------- 界面进度 ----------

test("解析层：提权是一个独立阶段，且落在关闭与安装之间", () => {
  assert.match(
    parseSource,
    /match: \/\^Requesting administrator privileges\/, phase: "elevating", percent: 14,/,
    "提权阶段要认 worker 写的那行日志",
  );
  // 百分比是取最大值单调前进的：写小了会被 closing(12) 吞掉（用户看不到「在等 UAC」，
  // 只看到进度条卡住），写大了会让后面的 installing(20) 看起来在倒退。
  const stages = parseSource.slice(parseSource.indexOf("const INSTALL_STAGES"));
  const closing = Number(stages.match(/phase: "closing", percent: (\d+)/)[1]);
  const elevating = Number(stages.match(/phase: "elevating", percent: (\d+)/)[1]);
  const installing = Number(stages.match(/phase: "installing", percent: (\d+)/)[1]);
  assert.ok(closing < elevating && elevating < installing, `提权阶段必须在 ${closing} 与 ${installing} 之间`);

  // 爬升的里程碑也必须有 14：少了它，12 的下一个里程碑就是 20，进度条会在 UAC
  // 还挂着等人点的时候自己爬到 18。
  const milestones = codexSource
    .match(/const MILESTONES = \[([^\]]+)\]/)[1]
    .split(",")
    .map((value) => Number(value.trim()));
  assert.ok(milestones.includes(elevating), "MILESTONES 必须包含提权阶段");
  assert.deepEqual(milestones, [...milestones].sort((a, b) => a - b), "里程碑必须递增");
});

test("主进程：提权期间超时要说「还在等授权」，不是「安装超时」", () => {
  assert.match(
    codexSource,
    /if \(current\.phase === "elevating"\) \{/,
    "提权阶段超时要单独措辞：那是在等用户点 UAC，不是装得慢",
  );
  assert.match(codexSource, /仍在等待管理员授权/, "要给用户一句能照做的提示");
});

// ---------- 自动化：不弹，只如实报告 ----------

test("自动化：不提权时在拉起 worker 之前就如实拒绝", () => {
  // 这一步是必须的，不是锦上添花：worker 是分离进程，调用点只看它有没有被拉起来。
  // 让它在后台异步撞 0x80073D28 失败，自动化这边会**报成功** —— 正是
  // check-codex-update.ps1 里那段注释警告的坑，只是换了个触发方式。
  const refusal = checkScript.indexOf("Test-CodexPackageRequiresElevation -Path $packagePath");
  const invoke = checkScript.indexOf("& $installRestartScript");
  assert.ok(refusal >= 0, "check 脚本要判定包需不需要提权");
  assert.ok(invoke >= 0, "check 脚本仍然要能拉起 worker");
  assert.ok(refusal < invoke, "拒绝必须发生在拉起 worker 之前");

  const refusalBlock = checkScript.slice(refusal, checkScript.indexOf('Write-Host "Starting detached', refusal));
  assert.match(refusalBlock, /ADMIN_PRIVILEGES_REQUIRED/, "要给出一眼能看见的结论");
  assert.match(refusalBlock, /return/, "不启动 worker");

  assert.match(checkScript, /\[switch\]\$AllowElevation/, "要接受 -AllowElevation");
  assert.match(checkScript, /-AllowElevation:\$AllowElevation/, "要把 -AllowElevation 透传给 worker");
});

test("自动化：维护脚本不得自己开提权（后台不许弹 UAC）", () => {
  // 用户选的是「不弹，只如实报告」。这条落点就是这里：维护脚本一个字都不提 -AllowElevation。
  assert.doesNotMatch(maintenanceScript, /AllowElevation/, "自动化那条路必须保持不提权");
  assert.match(maintenanceScript, /check-codex-update\.ps1/, "维护脚本仍然走 check 脚本");
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
