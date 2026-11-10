// Codex 装在哪个盘：解析、显示、以及「不许假设系统盘」这条不变量。
//
// 背景是用户直接问的两个问题：「高级设置不能设置 Codex 的安装位置吗，好像默认会安装
// 到 C 盘下」「更新识别能否做到全局识别，例如我是安装在 D 盘下的能不能识别到」。
//
// 答案是：位置由 Windows 决定（改不了，所以界面把它**显示出来**），而识别一直是全局的
// —— 因为包是通过 Get-AppxPackage 找到的，安装位置是现取的，从不按盘符猜。
//
// 「不按盘符猜」这件事最容易在后续改动里悄悄丢掉：开发机上 Codex 就在 C 盘，写死
// C:\Program Files\WindowsApps 跑起来一切正常，只有在用户的 D 盘上才炸。所以这里
// 用「生产代码里一个盘符路径字面量都不许有」把它钉死。

const assert = require("node:assert/strict");
const { readFileSync, readdirSync, existsSync, statSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const repo = join(root, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const healthScript = readFileSync(
  join(repo, "plugins", "codex-ms-desktop-updater", "scripts", "check-codex-desktop-health.ps1"),
  "utf8",
);
const moduleText = readFileSync(
  join(repo, "plugins", "codex-ms-desktop-updater", "scripts", "CodexStoreUpdater.psm1"),
  "utf8",
);
const mainSource = read("electron", "main.cjs");
const settingsSource = read("src", "components", "AdvancedSettings.tsx");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** 递归收集目录下的文本文件；目录不存在时返回空数组（生成目录可能还没构建）。 */
function collectSources(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map((entry) => join(dir, String(entry)))
    .filter((file) => statSync(file).isFile())
    .filter((file) => !file.endsWith(".map") && !file.endsWith(".png") && !file.endsWith(".ico"));
}

test("生产代码里没有任何盘符路径字面量（安装位置不许按系统盘猜）", () => {
  // 这几处才是真正跑给用户看的代码：脚本、渲染进程、主进程。
  // 测试文件里的 C:\ 是夹具（真实捕获的输出），不算。
  const dirs = [
    join(repo, "plugins", "codex-ms-desktop-updater", "scripts"),
    join(root, "src"),
    join(root, "electron"),
  ];
  const offenders = [];
  for (const dir of dirs) {
    for (const file of collectSources(dir)) {
      const text = readFileSync(file, "utf8");
      text.split(/\r?\n/).forEach((line, index) => {
        // 注释里出现盘符是允许的（说明性文字），只要不是可执行的路径字面量。
        // 这里放过整行都是注释的情况，代码行里的盘符一律算违规。
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return;
        if (trimmed.startsWith("#")) return;
        // 盘符前面必须是「非单词字符」（行首、引号、空格、括号…）。少了这一条，
        // 正则里的 `package:\s*` 会被当成 E 盘路径 —— 冒号前的那个字母正好是单词尾。
        if (/(^|[^\w])[A-Za-z]:\\{1,2}/.test(line)) {
          offenders.push(`${file.replace(repo, "")}:${index + 1}  ${trimmed.slice(0, 90)}`);
        }
      });
    }
  }
  assert.deepEqual(offenders, [], `生产代码里出现了写死的盘符路径：\n  ${offenders.join("\n  ")}`);
});

test("健康脚本：安装位置取自包自己的 InstallLocation，而不是拼出来的路径", () => {
  assert.match(healthScript, /Write-Host \("Location : \{0\}" -f \$health\.InstallLocation\)/);
  // 取值必须来自 Get-AppxPackage 解析出的对象。
  assert.match(moduleText, /InstallLocation = \$package\.InstallLocation/);
  assert.match(moduleText, /InstallLocation = \$pkg\.InstallLocation/);
});

test("主进程：安装目录由主进程自己解析，不给渲染进程传路径的口子", () => {
  assert.match(mainSource, /"open_install_location"/, "命令白名单里要有这一项");
  // 这颗按钮以前打开的是 Windows 设置里的「新的应用将保存到」，而用户问的是
  // 「打开 window 存储位置为什么不是打开路径的」—— 他问得对：那颗按钮的字面意思、
  // 以及这张卡片上显示的那个路径，都指向「打开这个目录」，它却把人送去别处。
  //
  // 现在「打开安装目录」确实打开目录；Windows 设置只保留一个入口 —— 应用迁移能力检测
  // 发现「尚未安装」时，界面才给一颗「打开 Windows 存储设置」的按钮，URI 写死在主进程里，
  // 而且只能是「新内容的保存位置」这一页（ms-settings:storagesense 是存储感知，会删旧文件，
  // 跟装到哪个盘毫无关系）。
  const settingsUris = mainSource.match(/ms-settings:[a-z]+/g) || [];
  assert.deepEqual([...new Set(settingsUris)], ["ms-settings:savelocations"], "只许打开「新内容的保存位置」");
  assert.equal(settingsUris.length, 1, "ms-settings 只应出现在唯一的命令分支里");
  assert.doesNotMatch(mainSource, /openExternal\(args\./, "不许把渲染进程传来的参数直接交给 openExternal");

  // 路径必须来自主进程：安装位置随版本变化（目录名里带版本号），写不进下面那个静态白名单，
  // 但「渲染进程把路径传回来、主进程照开」正是白名单要挡住的那件事，不能又开一个口子。
  const body = mainSource.match(/case "open_install_location": \{([\s\S]*?)\r?\n    \}/);
  assert.ok(body, "找不到 open_install_location 的实现");
  assert.match(body[1], /lastInstallLocation/, "路径必须取自 get_status 那次解析的结果");
  assert.doesNotMatch(body[1], /args\.path/, "不许接收渲染进程传来的路径");
  assert.match(
    mainSource,
    /lastInstallLocation = status\?\.installLocation \?\? null/,
    "get_status 要顺手把安装位置记下来",
  );
  // 打开目录用 openPath（落到 Explorer），不是 openExternal（那是一条协议）。
  assert.match(body[1], /shell\.openPath\(target\)/, "打开目录要用 openPath");

  // open_path 的白名单只能有本应用自己的目录，而且必须是**穷举**的一组：
  // 每一项都来自主进程自己（app.getPath / 应用自己的根目录），或者来自设置里那个
  // 「缓存目录」——它同时也是下载器实际写入的目录，回退功能正是把安装包留在那里。
  // 关键是最后一条：白名单里不许出现渲染进程随命令传进来的 args.path。
  assert.match(
    mainSource,
    /const allowed = new Set\(\[\s*codex\.logsRoot\(\),\s*codex\.downloadsRoot\(\),\s*codex\.resolveDownloadDirectory\(readSettings\(\)\.downloadDirectory\),\s*app\.getPath\("userData"\),\s*\]\)/,
    "open_path 的白名单只能有本应用自己的目录",
  );
  assert.doesNotMatch(mainSource, /allowed\.add\(/, "白名单不许在运行时被塞进渲染进程给的路径");
  assert.doesNotMatch(mainSource, /allowed\.has\([^)]*args/, "白名单判定用的必须是命令参数以外的东西");
});

test("界面：安装位置原样放进只读输入框，不拼接也不截断", () => {
  // 唯一允许的加工是「没有值时的占位文案」。
  assert.match(settingsSource, /value=\{installLocation \?\? "/, "有值时必须是原样的 installLocation");
  assert.match(settingsSource, /readOnly/);
  // 界面说明真实位置来源及系统限制，无需向普通用户展示命令名称。
  assert.match(settingsSource, /Windows 报告的实际安装位置/);
  assert.match(settingsSource, /MSIX 应用由系统存放在该卷的 WindowsApps/);
  // 应用本体迁移是真实能力，但前提是 Windows 认识那个卷；说明里不能承诺「一定能搬」。
  assert.match(settingsSource, /Move-AppxPackage|迁移条件/);
  // 按钮做它字面上说的事：打开安装目录。用户原话：「打开 window 存储位置为什么不是
  // 打开路径的」—— 那颗按钮以前打开的是 Windows 设置页，跟这一行显示的路径没关系。
  assert.match(settingsSource, /打开安装目录/);
  assert.match(settingsSource, /onClick=\{onOpenInstallLocation\}/);
  // 它不接收路径参数：路径由主进程解析（见上面那条）。组件这一侧也只能是「空手」回调。
  assert.match(settingsSource, /onOpenInstallLocation: \(\) => void;/);
  // 未安装时才出现的 Windows 设置入口，同样不带参数，URI 由主进程写死。
  assert.match(settingsSource, /打开 Windows 存储设置/);
  assert.match(settingsSource, /onOpenStorageSettings: \(\) => void;/);

  // 目标来自用户选择的文件夹，重新检测后清空旧目标，执行时传递完整选择供主进程复核。
  assert.match(settingsSource, /id="pick-app-directory"/);
  assert.match(settingsSource, /setSelection\(null\)/);
  assert.match(settingsSource, /if \(selection\?\.volumePath\) onMove\(selection\)/);
  // 点完「检测迁移条件」要有一处立刻换字，不能只把结果堆在下方区块里。
  assert.match(settingsSource, /detect-state/);
  assert.match(settingsSource, /检测完成/);
});

// ---------- 「打开缓存目录」打开的必须是真实的那个目录 ----------
//
// 和「安装位置不许按盘符猜」是同一类 bug：路径必须是现取的真实值，不能是某个默认值。
//
// 回归：三个入口（打开缓存目录的命令、高级设置里的链接、「版本历史」卡片底部）以前各写各的，
// 其中两处直接读 settings.defaultDownloadDirectory。用户在高级设置里把缓存换到 D 盘
// 之后，那两颗按钮仍然打开 C 盘的默认目录 —— 与卡片里列出来的包、以及 worker 实际
// 剪枝的目录都对不上。而开发机上 settings.downloadDirectory 恰好是空、默认目录又恰好
// 就是真实目录，所以这个 bug 在开发机上一点都看不出来，只能靠夹具把三级区分开。
test("缓存目录：优先级是「枚举解析结果 > 设置原始值 > 默认目录」", () => {
  const store = read("src", "state", "app.ts");
  const body = store.match(
    /export function effectiveDownloadDirectory\(state: \{[\s\S]*?\}\): string \{([\s\S]*?)\n\}/,
  );
  assert.ok(body, "找不到 effectiveDownloadDirectory 的实现");
  // 函数体里没有类型标注，可以直接当 JS 跑 —— 这样测的是真实实现，不是它的文本。
  const resolve = new Function("state", body[1]);

  const DEFAULT_DIR = "C:\\Users\\me\\AppData\\Roaming\\Codex Updater\\downloads";
  // 用户在高级设置里填的原始值（带没展开的环境变量），和主进程解析后的最终路径。
  const RAW_SETTING = "%USERPROFILE%\\Codex 缓存";
  const RESOLVED = "C:\\Users\\me\\Codex 缓存";

  // 三级互不相同，所以每个断言都只能由对应的那一级满足 —— 这就是这个夹具存在的意义。
  assert.equal(
    resolve({
      settings: { downloadDirectory: RAW_SETTING, defaultDownloadDirectory: DEFAULT_DIR },
      cachedPackages: { downloadDirectory: RESOLVED },
    }),
    RESOLVED,
    "有枚举结果时必须用它：那是主进程按「自定义值 → 展开 %VAR% → 回退默认」算出的最终路径",
  );
  assert.equal(
    resolve({
      settings: { downloadDirectory: RAW_SETTING, defaultDownloadDirectory: DEFAULT_DIR },
      cachedPackages: null,
    }),
    RAW_SETTING,
    "枚举还没回来时退回设置里的原始值（不是默认目录）",
  );
  assert.equal(
    resolve({
      settings: { downloadDirectory: "", defaultDownloadDirectory: DEFAULT_DIR },
      cachedPackages: null,
    }),
    DEFAULT_DIR,
    "没配自定义目录时才用默认目录",
  );
  assert.equal(
    resolve({
      settings: { downloadDirectory: "   ", defaultDownloadDirectory: DEFAULT_DIR },
      cachedPackages: { downloadDirectory: "" },
    }),
    DEFAULT_DIR,
    "空白值等同于没配：两边都要按「空即无效」处理，别只 trim 设置那一侧",
  );
  assert.equal(
    resolve({ settings: null, cachedPackages: null }),
    "",
    "设置都还没读到时给空串，不要漏出 undefined（调用方会直接拿它当路径打开）",
  );
});

test("缓存目录：三个入口都用共享判据，组件不许自己去解析", () => {
  const app = read("src", "App.tsx");
  // 三处入口：菜单动作的打开缓存目录、VersionHistory 的回退卡片、StorageSettings
  // （它再把同一个值传给 AdvancedSettings / CacheSettings 的「打开缓存目录」链接）。
  // App 里只算一次，多张卡片共用同一个值，避免同一件事在不同卡片上给出两种答案。
  assert.match(
    app,
    /const cacheDirectory = effectiveDownloadDirectory\(\{ settings, cachedPackages \}\)/,
    "App 里应当只算一次共享判据",
  );
  const uses = app.match(/effectiveDownloadDirectory\(/g) || [];
  assert.equal(uses.length, 2, `App.tsx 应只有「打开缓存目录」动作与共享变量两处，实际 ${uses.length} 处`);
  assert.match(app, /cacheDirectory=\{cacheDirectory\}/, "卡片必须拿到 App 算好的 cacheDirectory");
  // 必须剥掉注释再查：两个组件的文档注释里都写着「由 App 按 effectiveDownloadDirectory
  // 算好传进来」这句话本身 —— 不剥注释，负向断言就会因为注释而恒假（正向断言则会恒真）。
  const stripComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  // 缓存目录那一行搬去了 CacheSettings（它和「占了多少」是同一个问题的两半），
  // AdvancedSettings 与 VersionHistory 仍然有「打开缓存目录」的链接，StorageSettings
  // 负责把同一个值继续往下传，所以四者都得继续接收这个 prop、都不许自己解析。
  for (const name of ["CacheSettings.tsx", "AdvancedSettings.tsx", "VersionHistory.tsx", "StorageSettings.tsx"]) {
    const text = stripComments(read("src", "components", name));
    assert.ok(
      !/effectiveDownloadDirectory/.test(text),
      `${name} 不该自己调 effectiveDownloadDirectory —— 判据只能有一处，否则又会各写各的`,
    );
    assert.match(text, /cacheDirectory/, `${name} 要接收 App 传进来的 cacheDirectory`);
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
