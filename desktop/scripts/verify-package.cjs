// 打包产物验收：app.asar 的索引必须自洽，而且打出来的 exe 必须真的能起来。
//
// 存在的原因（2026-10-02）：electron-builder 打出的 app.asar 里，
// electron/codex.cjs 的 size 比实际写进去的内容少记了 1 字节，于是排在它后面的
// 每一条偏移都整体错位 1 字节。package.json 恰好是数据区最后一条，错位 1 字节
// 正好把收尾的 `}` 挤出窗口 —— Electron 报 "Unable to parse .../package.json"，
// 进程退出码 1，用户双击毫无反应（没有窗口、没有日志、没有对话框之外的信息）。
//
// 当时没有任何检查能发现它，两个盲区叠在一起：
//   1. verify-render.cjs --packaged 只从 asar 里读 dist/ 和 resources/scripts，
//      而 dist/ 排在错位点之前，读出来完全正常；真正被撑破的 package.json
//      它碰都不碰（它在跑自己的 main，app.asar 的 package.json 只是个普通文件）。
//   2. 打包出来的 exe 从来没有被真的启动过一次 —— CI 构建完就直接传 Release 了。
//
// 所以这里补两层，缺一不可：
//
//   一、结构自洽。asar 的数据区是紧凑排布的，没有对齐填充，所以「所有条目声明的
//   size 之和」必须恰好等于「文件长度 - 数据区起点」。少一个字节就说明写入的内容
//   和索引记的不是同一份 —— 这正是上次那 1 字节的形状，而且它一定会在某个条目上
//   表现为整体错位。再确认根 package.json 能解析、有 main，把「用户看到的症状」
//   也直接钉住。
//
//   二、端到端。真的把 exe 拉起来，确认它没有立刻退出。结构检查是推演出来的，
//   这一条是事实：坏成上次那样时它的退出码就是 1。
//
// 用法：npm run verify:package（需要先 npm run electron:build）

const { spawn } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const desktopRoot = join(__dirname, "..");
const unpackedDir = join(desktopRoot, "release", "win-unpacked");
const asarPath = join(unpackedDir, "resources", "app.asar");
const exePath = join(unpackedDir, "Codex Updater.exe");

// 起来之后活够这么久才算「能打开」。应用要等 PowerShell 健康检查回来才渲染，
// 但进程本身在窗口创建前就已经稳定，8 秒足够区分「立刻退出」和「正常运行」。
const ALIVE_MS = 8000;

const problems = [];

function fail(message) {
  problems.push(message);
}

// ---------- 一、asar 结构自洽 ----------

// asar 头部是 Chromium 的 Pickle，套了两层长度前缀，逐字段数偏移很容易数错
// （我自己第一版就数错了）。这里只用最外层的 u32 头部长度，再在头部区间里
// 用花括号夹出 JSON —— 头部 JSON 一定是这段区间里从第一个 { 到最后一个 }。
// 不依赖 @electron/asar：它是 electron-builder 的传递依赖，直接 require 等于
// 把验收脚本挂在别人的依赖树上，而这段格式是稳定的公开约定。
function readAsarIndex(file) {
  const buffer = readFileSync(file);
  if (buffer.length < 16) throw new Error("app.asar 太短，不是合法的 asar");
  const dataStart = 8 + buffer.readUInt32LE(4);
  if (dataStart <= 0 || dataStart > buffer.length) {
    throw new Error(`asar 头部声明的数据区起点 ${dataStart} 越界（文件长 ${buffer.length}）`);
  }
  const region = buffer.subarray(8, dataStart);
  const from = region.indexOf(0x7b); // '{'
  const to = region.lastIndexOf(0x7d); // '}'
  if (from < 0 || to < from) throw new Error("asar 头部区间里找不到 JSON");
  const header = JSON.parse(region.subarray(from, to + 1).toString("utf8"));
  return { buffer, header, dataStart };
}

// 递归收集所有文件条目。目录（有 files 字段）和软链接（link）不占数据区，跳过。
function collectEntries(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const full = prefix ? `${prefix}/${name}` : name;
    if (entry.files) collectEntries(entry, full, out);
    else if (entry.link === undefined) out.push({ path: full, offset: Number(entry.offset), size: Number(entry.size) });
  }
  return out;
}

function checkAsar() {
  if (!existsSync(asarPath)) {
    fail(`找不到打包产物 ${asarPath}，先跑 npm run electron:build`);
    return;
  }

  let index;
  try {
    index = readAsarIndex(asarPath);
  } catch (error) {
    fail(`app.asar 头部读不出来：${error.message}`);
    return;
  }

  const { buffer, header, dataStart } = index;
  const entries = collectEntries(header, "", []);
  const dataLength = buffer.length - dataStart;

  // 紧凑排布的核心不变式：声明的大小必须严丝合缝铺满数据区。
  // 少了 = 有内容没被记进去（后面所有偏移整体前移）；多了 = 有偏移指向不存在的字节。
  const declaredTotal = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (declaredTotal !== dataLength) {
    fail(
      `app.asar 的索引和数据区对不上：条目声明合计 ${declaredTotal} 字节，数据区实际 ${dataLength} 字节，` +
        `差 ${dataLength - declaredTotal}。这说明写入内容和索引记的不是同一份，排在错位点之后的条目会整体偏移。`,
    );
  }

  // 逐条确认没有越界。上面那条是总量，这条定位到具体是哪个条目开始不对。
  for (const entry of entries) {
    if (entry.offset < 0 || entry.offset + entry.size > dataLength) {
      fail(`app.asar 条目越界：${entry.path} 声明 [${entry.offset}, ${entry.offset + entry.size})，数据区长 ${dataLength}`);
      break;
    }
  }

  // 根 package.json 必须能被 Electron 解析出来，并且指向真正的主进程入口。
  // 上次用户看到的正是这一条失败。
  const manifest = entries.find((entry) => entry.path === "package.json");
  if (!manifest) {
    fail("app.asar 里没有根 package.json，Electron 无法确定入口");
    return;
  }
  const manifestBuffer = buffer.subarray(dataStart + manifest.offset, dataStart + manifest.offset + manifest.size);
  let manifestJson;
  try {
    manifestJson = JSON.parse(manifestBuffer.toString("utf8"));
  } catch (error) {
    fail(`app.asar 里的 package.json 解析失败（Electron 会直接拒绝启动）：${error.message}`);
    return;
  }
  if (!manifestJson.main) fail("app.asar 里的 package.json 没有 main 字段，Electron 找不到入口");
  console.log(`  索引：${entries.length} 个条目，数据区 ${dataLength} 字节，声明合计 ${declaredTotal} 字节（自洽）`);
  console.log(`  入口：main=${manifestJson.main}，版本 ${manifestJson.version}`);
}

// ---------- 二、打包出来的 exe 真的能起来 ----------

function checkLaunch() {
  return new Promise((resolve) => {
    if (!existsSync(exePath)) {
      fail(`找不到 ${exePath}，先跑 npm run electron:build`);
      resolve();
      return;
    }

    const child = spawn(exePath, [], { stdio: "ignore" });
    let settled = false;
    const finish = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (message) fail(message);
      resolve();
    };

    // 立刻退出 = 用户双击时看到的「没反应」。退出码 1 就是 package.json 解析失败那条路。
    child.on("exit", (code, signal) => {
      finish(`打包后的 exe 启动后立刻退出（code=${code}, signal=${signal}）——用户双击时就是「打不开」`);
    });
    child.on("error", (error) => finish(`打包后的 exe 拉不起来：${error.message}`));

    const timer = setTimeout(() => {
      child.kill();
      console.log(`  启动：exe 起来后存活超过 ${ALIVE_MS / 1000} 秒（未被拒绝启动）`);
      finish(null);
    }, ALIVE_MS);
  });
}

(async () => {
  console.log("打包产物验收：");
  checkAsar();
  await checkLaunch();
  if (problems.length > 0) {
    console.error("\n打包产物验收未通过：");
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    process.exit(1);
  }
  console.log("打包产物验收通过。");
})();
