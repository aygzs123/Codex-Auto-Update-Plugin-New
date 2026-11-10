// 应用内自更新（更新器更新自己）的接线契约。
//
// 这是整个项目里唯一一条「下载一个可执行文件并运行它」的链路，所以测试只钉死
// 三条不可放宽的边界，其余（进度、按钮文案）交给 verify:render：
//
//   1. 下载地址只认本仓库 Release 的下载前缀 —— 否则这条命令就成了任意 URL 下载器；
//   2. 必须带 GitHub 计算的 sha256 摘要，装之前还要再比一次大小/摘要；
//   3. 安装只跑自己 updates 目录里的 .exe，且**不请求提权**（提权会卡死无人值守场景）。
//
// 另外钉住「版本固定已彻底移除」：pinToGithubRelease / codex-pin / PinSettings
// 一旦回流，就会重新出现两套「该装哪个版本」的判据。

const assert = require("node:assert/strict");
const { readFileSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const main = read("electron", "main.cjs");
const preload = read("electron", "preload.cjs");
const app = read("src", "state", "app.ts");
const appView = read("src", "App.tsx");
const types = read("src", "types.ts");
const electronTypes = read("src", "electron.d.ts");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** 取出 main.cjs 里某个函数体（按 `function name(...)` 到同缩进的 `}` 粗略切）。 */
function section(source, needle, span = 4000) {
  const start = source.indexOf(needle);
  assert.notEqual(start, -1, `找不到 ${needle}`);
  return source.slice(start, start + span);
}

// ---------- 主进程：下载 ----------

test("下载只接受本仓库 Release 的下载前缀", () => {
  assert.match(main, /const APP_UPDATE_PREFIX = `https:\/\/github\.com\/\$\{GITHUB_REPO\}\/releases\/download\/`;/);
  const resolve = section(main, "async function resolveAppUpdateAsset");
  assert.match(resolve, /if \(!url\.startsWith\(APP_UPDATE_PREFIX\)\) throw/, "前缀不匹配必须拒绝");
});

test("摘要只认主进程自己从 GitHub 拿到的那一份", () => {
  const resolve = section(main, "async function resolveAppUpdateAsset");
  assert.match(resolve, /!\/\^sha256:\[0-9a-f\]\{64\}\$\/i\.test\(digest\)/, "摘要格式不校验证");
  assert.match(resolve, /throw new Error\("这个更新包没有 SHA-256 摘要，无法校验"\)/, "没有摘要必须拒绝，不能当校验通过");
  // 摘要来自 github 数据，而不是 args —— 渲染进程传什么都不能当校验依据。
  assert.doesNotMatch(resolve, /args\?\.sha256|args\.sha256/, "不许接受渲染进程传来的摘要");
  assert.match(resolve, /getGithubUpdates\((?:true|false)\)/, "摘要必须取自主进程的 GitHub 结果");
});

test("下载边下边校验，失败删半截文件，成功后原子改名", () => {
  const download = section(main, "async function downloadAppUpdate(", 3000);
  assert.match(download, /\.part/, "没有临时文件");
  assert.match(download, /sha256 !== asset\.sha256/, "下载完没有比对摘要");
  assert.match(download, /size !== asset\.size/, "没有比对大小");
  assert.match(download, /renameSync\(partial, target\)/, "没有原子改名");
  assert.match(download, /unlinkSync\(partial\)/, "失败时没删 .part");
  assert.match(download, /if \(appUpdateDownloading\) throw/, "没有拦住并发下载");

  const file = section(main, "function downloadAppUpdateFile(", 3000);
  assert.match(file, /createHash\("sha256"\)/, "没有边下边算摘要");
  assert.match(file, /pipeline\(response, meter, createWriteStream\(partialPath/, "没有走流式管道");
  assert.match(file, /request\.abort\(\)/, "超时没有中止请求");
});

// ---------- 主进程：安装 ----------

test("安装只跑 updates 目录里的 .exe（路径包含校验）", () => {
  const install = section(main, "function installAppUpdate(", 1200);
  assert.match(install, /if \(!app\.isPackaged\) throw/, "开发模式不许安装");
  assert.match(install, /if \(target !== join\(root, basename\(target\)\)\) throw/, "缺少路径包含校验");
  assert.match(install, /endsWith\("\.exe"\)/, "没有校验后缀");
  assert.match(install, /existsSync\(target\)/, "没有校验文件存在");
});

test("安装参数是 NSIS 静默更新，且绝不请求提权", () => {
  const install = section(main, "function installAppUpdate(", 1200);
  assert.match(install, /spawn\(target, \["--updated", "\/S", "--force-run"\]/, "NSIS 参数不对");
  assert.match(install, /detached: true/, "安装器必须脱离当前进程");
  assert.match(install, /child\.unref\(\)/);
  assert.match(install, /isQuitting = true;[\s\S]{0,60}app\.quit\(\)/, "安装前要先放行退出流程");

  // 提权会让「点了检查更新」变成一个卡在 UAC 后面的窗口，无人值守时更是永久卡死。
  assert.doesNotMatch(install, /runas|ShellExecute|powershell.*Start-Process.*Verb|sudo-prompt/, "安装链路不许提权");
  assert.doesNotMatch(main, /APP_UPDATE_PREFIX[\s\S]{0,2000}runas/, "下载/安装相关代码里混进了提权");
});

// ---------- 主进程：IPC ----------

test("两条命令都进白名单、都是长命令、都会推进度", () => {
  assert.match(main, /"download_app_update",/, "download_app_update 不在白名单");
  assert.match(main, /"install_app_update",/, "install_app_update 不在白名单");
  const long = main.match(/const LONG_COMMANDS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(long, "找不到 LONG_COMMANDS");
  assert.match(long[1], /"download_app_update"/, "下载中途关窗会留下说不清的中间态");
  assert.match(main, /desktop:app-update/, "没有独立的进度通道");
  assert.match(main, /setProgressBar/, "任务栏进度没有复用");
});

test("预加载暴露 onAppUpdateProgress，且订阅可取消", () => {
  assert.match(preload, /onAppUpdateProgress:/, "预加载没有暴露 onAppUpdateProgress");
  assert.match(preload, /ipcRenderer\.on\("desktop:app-update"/);
  assert.match(preload, /removeListener\("desktop:app-update"/);
  assert.match(electronTypes, /onAppUpdateProgress\(callback: \(payload: \{ received: number; total: number \}\) => void\): \(\) => void;/);
});

// ---------- 渲染进程 ----------

test("store 里检查 → 下载 → 安装三步齐全，失败不污染全局 error", () => {
  for (const name of ["checkAppUpdate", "downloadAppUpdate", "installAppUpdate"]) {
    assert.match(app, new RegExp(`${name}: async`), `store 缺 ${name}`);
  }
  assert.match(app, /invokeCommand<\{ path: string; size: number; sha256: string \}>\("download_app_update", \{\s*url: asset\.url,?\s*\}\)/);
  assert.match(app, /invokeCommand\("install_app_update", \{ path \}\)/);
  // 更新器的检查失败要留在「关于」卡片里：全局 error 是 Codex 安装链路的报错位。
  assert.match(app, /appUpdate: \{ \.\.\.state\.appUpdate, phase: "error", error: github\.error/, "检查失败没落到 appUpdate");
  // 没有 .exe 资产时明确报错，而不是让按钮点了不反应。
  assert.match(app, /没有可下载的 \.exe 安装包/);
});

test("首屏订阅更新包进度，并在卸载时退订", () => {
  assert.match(appView, /connectAppUpdateProgress\(\)/, "App 没有订阅更新包进度");
  assert.match(app, /export function connectAppUpdateProgress\(\)/, "store 没有导出 connectAppUpdateProgress");
  // CI 是 CRLF 检出、本地是 LF，先统一换行再按行切片，否则这边永远本地绿、CI 红。
  const effect = section(appView.replace(/\r\n/g, "\n"), "useEffect(() => {\n    void bootstrap();", 900);
  assert.match(effect, /offAppUpdate\(\)/, "卸载时没有退订");
});

test("「关于」卡片有检查更新入口，文案交代校验与 SmartScreen", () => {
  const about = section(appView, "function AboutUpdate()", 7000);
  assert.match(about, /checkAppUpdate/, "没有检查更新按钮");
  assert.match(about, /downloadAppUpdate/, "没有下载入口");
  assert.match(about, /installAppUpdate/, "没有安装入口");
  assert.match(about, /SHA-256/, "文案没有说明下载后会校验");
  assert.match(about, /SmartScreen/, "文案没有提示未签名安装包的 SmartScreen");
  // 当前版本必须是这块的主角，而不是缩在页脚的一行小字。
  assert.match(about, /className="about-update-version"/, "没有独立的版本行");
  assert.match(about, /<span className="ver">v\{__APP_VERSION__\}<\/span>/, "版本号没有单独渲染");
  // 查过且是最新时按钮必须换文案：还是「检查更新」会让人以为上次没生效。
  assert.match(about, /upToDate \? "重新检查" : "检查更新"/, "已是最新时按钮文案没有变化");
  assert.match(about, /data-tone=\{badge\.tone\}/, "状态胶囊没有跟随阶段变色");
  assert.match(appView, /<AboutUpdate \/>/, "「关于」里没有挂上检查更新");
  assert.match(types, /type AppUpdatePhase = "idle" \| "checking" \| "downloading" \| "ready" \| "installing" \| "error";/);
});

// ---------- 版本固定已彻底移除 ----------

test("全仓不再有 pinToGithubRelease / codex-pin-v / PinSettings", () => {
  // 「固定 Codex 版本」那套东西的残留。注意不能直接搜 codex-pin —— 缓存目录里的
  // `.codex-pins.json`（逐包固定，防自动剪枝）是另一件事，长得像但用途相反。
  const offenders = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        if (name === "node_modules" || name === "dist" || name === "release" || name === "downloads") continue;
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx|cjs|mjs|json|md)$/.test(name)) continue;
      // 测试自己会提到这些名字，跳过 tests 目录本身。
      if (path.includes(`${join("desktop", "tests")}`)) continue;
      const text = readFileSync(path, "utf8");
      if (/pinToGithubRelease|codex-pin-v|PinSettings/.test(text)) offenders.push(path.slice(root.length + 1));
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], `这些文件还留着版本固定的残留：${offenders.join(", ")}`);
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
