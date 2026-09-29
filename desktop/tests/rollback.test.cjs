// 版本回退（Codex Desktop 降级到上一版）。
//
// 用户原话：「能新增一个版本回退功能吗？每次 codex 更新完版本可能或多或少会存在问题。」
//
// 在这之前，更新是**只能向前**的，而且不是「没做这个功能」这么简单 —— 三处代码合起来
// 保证了缓存里最多只有一个包，而那个包还是刚装上的新版本：
//
//   1. check-codex-update.ps1 调用 Remove-InstalledCodexPackageFiles，删掉所有
//      「版本 <= 已安装版本」的包 —— 恰好是用户正在用、且已知能用的那一版的安装包；
//   2. 安装 worker 装完之后再删一次自己刚用的那个包；
//   3. 两处安装都是裸的 Add-AppxPackage，Windows 会拒绝安装更低的版本。
//
// 而 rg-adguard 只发最新版（本机实测 Retail / Slow / Fast 三个 ring 都只返回同一个版本），
// 删掉的安装包再也下不回来。所以这个功能要成立，必须同时钉住四件事：
//
//   - 缓存里**留得下**旧包（保留额度 >= 2，且剪枝不再动当前已安装的那一版）；
//   - 允许降级这件事**只**发生在回退路径上（一键更新必须保持严格）；
//   - 降级走的是 -ForceUpdateFromAnyVersion，且校验用相等判定 —— 否则 Windows 拒绝
//     降级时会被报成成功；
//   - 界面上真的有一个点得到的回退按钮，而且它没法被误点成「删除安装包」。
//
// 最后一条尤其重要：旧安装包删掉就再也拿不回来，一颗误点的删除按钮足以让整个功能失效。

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
const listScript = readPlugin("scripts", "list-cached-codex-packages.ps1");
const mainSource = read("electron", "main.cjs");
const codexSource = read("electron", "codex.cjs");
const store = read("src", "state", "app.ts");
const app = read("src", "App.tsx");
const versionHistory = read("src", "components", "VersionHistory.tsx");
const styles = read("src", "styles.css");
const syncScripts = read("scripts", "sync-ps-scripts.mjs");
const verifyRender = read("scripts", "verify-render.cjs");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/**
 * 去掉注释后的源码。
 *
 * 「有没有删除操作」这类断言必须看真正的代码：解释「为什么刻意不做删除按钮」的那段
 * 注释里就有「删除」两个字，不剥注释的话，唯一能通过这个断言的做法是把理由删掉
 * —— 恰好反了。
 *
 * 行尾注释同样要剥。只处理「整行以 // 开头」是不够的：顺手写一句
 * `onClick={...}; // 这里不提供删除入口`，行为一点没变，负向断言就红了 —— 而负向断言
 * 假红比假绿更坏，它会逼着后来人把解释删掉。`[^:]` 那个前缀是为了放过 `https://`。
 */
const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

// ---------- 保留策略 ----------

test("保留额度默认是 2，不是 1", () => {
  // 下限是 2 而不是 1：新装上的那一版的包，作用是**下一次**更新时的回退目标。
  // 只留 1 个（= 只剩刚装上的），下次更新完就没有可退的版本，功能等于不存在。
  assert.match(moduleText, /\[int\]\$KeepCount = 2/, "默认保留额度必须是 2");
  assert.match(
    moduleText,
    /Select-Object -Skip \$KeepCount/,
    "剪枝要按「倒序后跳过最新 N 个」来做，而不是把不高于已安装版本的包全删掉",
  );
  // 旧的函数名带着「installed-or-older」这个正是要被推翻的语义，留着会误导后来人。
  assert.doesNotMatch(moduleText, /function Remove-InstalledCodexPackageFiles/, "旧的清理函数必须删掉");
  assert.match(moduleText, /function Remove-SupersededCodexPackageFiles/, "改名后的清理函数要存在");
  assert.match(moduleText, /Remove-SupersededCodexPackageFiles,/, "新名字要导出");
});

test("worker 装完之后不再删掉自己刚用的那个包，改成按保留策略剪枝", () => {
  // 这一条是「下一次更新还有得退」的唯一保证：删掉刚装上的包，等于把下一轮的回退目标
  // 提前销毁。
  assert.doesNotMatch(
    worker,
    /Remove-Item -LiteralPath \$resolvedPackagePath/,
    "worker 不能再删掉自己刚装完的那个安装包",
  );
  assert.match(worker, /Remove-SupersededCodexPackageFiles/, "worker 要按保留策略剪枝");
  // 剪枝必须发生在 worker 里：它是唯一「装完就知道新版本号、且正站在缓存目录里」的地方。
  // 拖到下一次「检查更新」才清，缓存会先多背一个 800 MB 级的包。
  assert.match(worker, /Split-Path -Parent \$resolvedPackagePath/, "剪枝要针对安装包所在的目录");
});

// ---------- 降级开关只在回退路径上 ----------

test("模块：-AllowDowngrade 才带 -ForceUpdateFromAnyVersion", () => {
  const installBlock = moduleText.match(
    /if \(\$AllowDowngrade\) \{\s*Add-AppxPackage -Path \$Path -ForceUpdateFromAnyVersion\s*\}\s*else \{\s*Add-AppxPackage -Path \$Path\s*\}/,
  );
  assert.ok(
    installBlock,
    "Install-CodexPackage 必须是「-AllowDowngrade 时带 -ForceUpdateFromAnyVersion，否则裸 Add-AppxPackage」。" +
      "写成两条独立判断、或者让默认路径也带上这个开关，都会让「一键更新」不再严格。",
  );
  assert.match(moduleText, /\[switch\]\$AllowDowngrade/, "开关要在参数块里声明");
});

test("worker：允许降级的调用与严格调用分成两个分支", () => {
  const installBlock = worker.match(
    /if \(\$AllowDowngrade\) \{[\s\S]*?Add-AppxPackage -Path \$resolvedPackagePath -ForceUpdateFromAnyVersion\s*\}\s*else \{[\s\S]*?Add-AppxPackage -Path \$resolvedPackagePath\s*\}/,
  );
  assert.ok(installBlock, "worker 的安装必须按 AllowDowngrade 分叉，且严格那一支不带 -ForceUpdateFromAnyVersion");
  assert.match(worker, /\[switch\]\$AllowDowngrade/, "worker 要接收 -AllowDowngrade");
  // worker 是自分离出来的**新进程**，开关不会自己跟过去 —— 不显式透传，回退就会
  // 静默退化成一次普通的（被 Windows 拒绝的）安装。
  assert.match(
    worker,
    /if \(\$AllowDowngrade\) \{\s*\$arguments \+= "-AllowDowngrade"/,
    "自分离重启时要把 -AllowDowngrade 透传给 worker",
  );
});

test("worker：降级后的版本校验必须是相等判定", () => {
  // 这条防的是「把失败报成成功」：Windows 拒绝降级时系统里仍然是那个更高的版本，
  // 沿用升级路径那条 `-lt` 恰好为假，于是一次什么都没发生的降级会被报成安装成功。
  assert.match(
    worker,
    /if \(\$installedVersion -ne \$packageMetadata\.Version\) \{\s*throw "Downgrade did not take effect/,
    "降级必须用 -ne 判定并抛出「降级没有生效」",
  );
  assert.match(
    worker,
    /elseif \(\$installedVersion -lt \$packageMetadata\.Version\)/,
    "升级路径的 -lt 判定要退到 elseif，不能和降级判定并列成两条独立 if",
  );
});

// ---------- IPC 接线 ----------

test("主进程：list_cached_packages 在命令白名单里且有实现的 case", () => {
  assert.match(mainSource, /"list_cached_packages",/, "命令白名单里要有 list_cached_packages");
  assert.match(mainSource, /case "list_cached_packages":/, "switch 里要有对应的 case");
  // 白名单和 switch 缺一不可：只加白名单会落到 default 抛「不支持的命令」，
  // 只加 case 会被白名单挡在门外。
  assert.match(mainSource, /return codex\.listCachedPackages\(args\);/, "case 要真的去读缓存清单");
});

test("主进程：install_codex 把参数（含 allowDowngrade）原样交给 codex.cjs", () => {
  const installCase = mainSource.match(/case "install_codex":([\s\S]*?)case "/);
  assert.ok(installCase, "switch 里要有 install_codex 的 case");
  assert.match(installCase[1], /codex\.installCodex\(/, "case 要真的调 installCodex");
  // 参数必须在 codex.cjs 里变成命令行开关，否则「允许降级」到不了 PowerShell。
  assert.match(
    codexSource,
    /flags: allowDowngrade \? \["-AllowDowngrade"\] : \[\]/,
    "codex.cjs 要把 allowDowngrade 翻成 -AllowDowngrade 开关",
  );
  assert.match(
    codexSource,
    /"-DownloadDirectory":/,
    "codex.cjs 要把缓存目录传给脚本，否则 worker 只能反推",
  );

  // 下面这一条必须**真的求值**那个对象字面量，光匹配片段是钉不住的。
  //
  // 原来这里只断言「出现了 ...args」和「出现了 downloadDirectory: codex.resolveDownloadDirectory(」，
  // 两句话都成立 —— 但把顺序反过来写成 { downloadDirectory: ..., ...args }（渲染进程从此
  // 又能覆盖剪枝目录，正是这次修复要堵的那个洞），断言照样全绿。**顺序就是这条安全属性的
  // 全部内容**，而片段匹配对它完全瞎。
  //
  // 求值而不是继续加正则：再写一条 /\.\.\.args,\s*downloadDirectory:/ 也只是把顺序换个方式
  // 写死，改个换行或加个注释就红。这里直接把主进程那段字面量拿出来跑，问它「渲染进程塞
  // 一个 downloadDirectory 进去，谁赢」—— 这才是那条属性本身。
  const literal = installCase[1].match(/installCodex\(\s*(\{[\s\S]*?\})\s*,/);
  assert.ok(literal, "找不到 install_codex 传给 installCodex 的第一个参数（对象字面量）");
  const buildOptions = new Function("args", "codex", "readSettings", `return (${literal[1]});`);

  const resolved = "C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\downloads";
  const rendererArgs = {
    path: "C:\\tmp\\openai.msix",
    allowDowngrade: true,
    downloadDirectory: "C:\\攻击者\\想让它去剪枝的目录",
  };
  const options = buildOptions(rendererArgs, { resolveDownloadDirectory: () => resolved }, () => ({
    downloadDirectory: "C:\\设置里写的目录",
  }));

  assert.equal(
    options.downloadDirectory,
    resolved,
    "剪枝目录必须由主进程解析后覆盖渲染进程传来的值。展开顺序一旦反过来（{ downloadDirectory, ...args }），" +
      "渲染进程就能指定任意目录去剪枝，这个洞就重新打开了",
  );
  // 其余字段仍要原样透传：挑字段就会漏掉后来新加的开关。
  assert.equal(options.path, rendererArgs.path, "path 要原样透传");
  assert.equal(options.allowDowngrade, true, "allowDowngrade 要原样透传（降级只在回退路径上，靠它透到 PowerShell）");
});

test("新脚本进了打包清单：同步脚本与 asar 外的脚本断言都要收录", () => {
  const scriptName = "list-cached-codex-packages.ps1";
  // 同步脚本漏了 → 开发态就找不到脚本；PACKAGED_SCRIPTS 漏了 → 打包后才会有一处
  // 「点回退就报错」的失败，而那时已经发出去了。
  assert.ok(syncScripts.includes(scriptName), `sync-ps-scripts.mjs 要同步 ${scriptName}`);
  const packagedList = verifyRender.match(/const PACKAGED_SCRIPTS = \[([\s\S]*?)\];/);
  assert.ok(packagedList, "找不到 PACKAGED_SCRIPTS");
  assert.ok(
    packagedList[1].includes(scriptName),
    `PACKAGED_SCRIPTS 要收录 ${scriptName}（它专门验脚本落在 app.asar 之外）`,
  );
});

test("枚举脚本是只读的，且输出契约带三行固定字段", () => {
  // 原话是「只读枚举」：它会在应用启动时跑一次，任何写操作都会让「打开界面」带上副作用。
  assert.doesNotMatch(listScript, /Remove-Item|Set-Content|New-Item|Out-File/, "枚举脚本不许写任何东西");
  for (const line of ["Download directory: ", "Installed version: ", "Cached package count: "]) {
    assert.ok(listScript.includes(line), `输出契约缺少 "${line}"（parse.cjs 按它解析）`);
  }
});

// ---------- 渲染进程 ----------

test("回退是一次命令：算进忙判据，且标志位一定在 finally 里清掉", () => {
  const predicate = store.match(/export const isCommandRunning = \(state: \{[\s\S]*?\}\): boolean =>([\s\S]*?);\n/);
  assert.ok(predicate, "找不到 isCommandRunning");
  assert.ok(
    predicate[1].includes("rollingBack"),
    "isCommandRunning 要算上 rollingBack：回退和安装是两条链路，共用 install 活动但不是同一件事",
  );

  const rollback = store.match(/rollback: async \(pkg\) => \{([\s\S]*?)\n  \},/);
  assert.ok(rollback, "找不到 rollback 的实现");
  const body = rollback[1];
  // 不能匹配到第一个 `}` 就收工 —— `set({ rollingBack: false })` 里那个右花括号会
  // 把捕获截断在它自己身上，后面的语句一条都看不到。finally 是函数体的最后一段，
  // 直接取到结尾。
  const finallyBlock = body.match(/finally \{([\s\S]*)$/);
  assert.ok(finallyBlock, "rollback 缺少 finally：中途失败就再也不解锁了");
  assert.match(finallyBlock[1], /rollingBack: false/, "finally 里必须清掉 rollingBack");
  assert.match(finallyBlock[1], /refreshCachedPackages/, "finally 里要刷新缓存清单");
  // 卡片上的按钮不像主按钮那样有 runAction 这个统一闸门兜着，闸门要自己把一道。
  assert.match(body, /if \(isCommandRunning\(get\(\)\)\) return;/, "rollback 自己要挡住「已有命令在跑」");
});

test("回退必须先校验签名，再带着 allowDowngrade 安装", () => {
  const rollback = store.match(/rollback: async \(pkg\) => \{([\s\S]*?)\n  \},/);
  assert.ok(rollback, "找不到 rollback 的实现");
  const body = rollback[1];

  // 这个包在磁盘上可能已经躺了几周，中间谁都能动它。一键安装路径上的那道闸门
  // 在回退路径上同样是硬要求 —— 同一个包，不能因为它是旧版就少检一道。
  const signatureIndex = body.indexOf("verify_download_signature");
  const installIndex = body.indexOf('"install_codex"');
  assert.ok(signatureIndex !== -1, "回退要先校验签名");
  assert.ok(installIndex !== -1, "回退要调用 install_codex");
  assert.ok(signatureIndex < installIndex, "签名校验必须在安装之前");
  assert.match(body, /if \(signature\.status !== "verified"\)/, "校验不通过必须中止，不能往下走");

  assert.match(body, /allowDowngrade: true/, "回退要用 allowDowngrade 打开降级");
  // 降级之后 update 那份「可更新到 X」是照着旧版本算出来的，留着主按钮就会显示一个
  // 已经过期的判断。
  assert.match(body, /update: null/, "回退开始时要清掉过期的更新结论");
});

test("一键更新那条路仍然严格：不带 allowDowngrade", () => {
  const oneClick = store.match(/oneClick: async \(\) => \{([\s\S]*?)\n  \},/);
  assert.ok(oneClick, "找不到 oneClick 的实现");
  assert.match(
    oneClick[1],
    /invokeCommand<InstallResult>\("install_codex", \{ path: download\.path \}\)/,
    "一键安装/更新不能带 allowDowngrade —— 那等于让一条错误的调用把用户悄悄降级",
  );
  assert.doesNotMatch(oneClick[1], /allowDowngrade/, "一键更新路径上不许出现 allowDowngrade");
});

test("主按钮在回退途中说「正在回退…」，不是「正在安装…」", () => {
  // 两条链路共用 install 这个活动 id，所以文案必须额外看 rollingBack，
  // 否则用户会以为自己点错了。
  //
  // 断言的是**那行判断本身**，不是整行逐字。原来把整行源码照抄进正则，于是把同一行里
  // 无关的局部变量 working 改名成 isWorking（行为一字不变）测试就红 —— 那不是「改了措辞
  // 才红」，是「任何重构都红」。真正要钉的是：回退的分支排在安装前面且用词正确。
  const line = app.split("\n").find((text) => text.includes("primaryLabel") && text.includes("rollingBack"));
  assert.ok(line, "找不到「按 rollingBack 决定主按钮文案」的那一行");
  assert.match(line, /rollingBack\s*\?/, "文案要先判回退");
  assert.match(line, /正在回退…/, "回退途中要显示「正在回退…」");
  assert.match(line, /正在安装…/, "安装途中仍然是「正在安装…」");
  assert.ok(
    line.indexOf("正在回退…") < line.indexOf("正在安装…"),
    "回退的分支必须排在安装前面，否则会被安装那一支盖掉",
  );
});

test("版本历史卡片：有回退按钮，但没有删除按钮", () => {
  assert.match(versionHistory, /回退到此版本/, "可回退的那一行要有回退按钮");
  assert.match(versionHistory, /重新安装/, "当前这一版要给「重新安装」（同版本重装同样有用）");
  // 旧版安装包删掉就再也拿不回来，一颗误点的删除按钮足以让整个功能失效。
  // 这条要看剥掉注释的代码：卡片里没有任何删除控件，也接不到任何删除回调。
  const code = stripComments(versionHistory);
  assert.doesNotMatch(code, /删除|Remove|delete/i, "版本历史里不许出现删除控件");
  assert.doesNotMatch(app, /onDelete/, "App 不许给版本历史传删除回调");
  // 置灰要跟共享判据走，不只是本地的 rollingBack —— 安装跑着的时候回退同样不能点。
  assert.match(versionHistory, /disabled=\{busy\}/, "回退按钮要接上共享的 busy");
  assert.match(app, /<VersionHistory/, "App 要渲染版本历史卡片");
});

test("回退入口在失败告警里也有一份", () => {
  // 「刚更新完就出问题」正是这个功能要救的场景，让用户自己去下面的卡片里找入口
  // 是把路绕远了。
  assert.match(app, /const rollbackTarget = cachedPackages\?\.packages\.find\(\(pkg\) => pkg\.relation === "older"\)/);
  assert.match(app, /回退到 \$\{rollbackTarget\.version\}/, "告警里的按钮要写明退回哪一版");
  // 两张 warn 卡（安装后无窗口、启动后无窗口）都要有。
  const warnCards = app.match(/\{rollbackButton\}/g) ?? [];
  assert.equal(warnCards.length, 2, `两张失败告警卡里各要有一颗回退按钮，实际 ${warnCards.length} 处`);
  // 没有可退的包时按钮不出现（空按钮比没有按钮更糟：点下去什么都不会发生）。
  assert.match(app, /const rollbackButton = rollbackTarget && \(/, "没有回退目标时不该渲染按钮");
});

test("窄窗口下回退按钮整行落下，不被挤成多行或溢出", () => {
  // 760px 是主窗口的 minWidth，渲染冒烟测试会在这个宽度上量一遍。
  const media = styles.match(/@media \(max-width: 760px\) \{([\s\S]*?)\n\}/);
  assert.ok(media, "找不到窄屏媒体查询");
  assert.match(media[1], /\.rollback-action/, "窄屏要单独处理回退按钮的宽度");
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
