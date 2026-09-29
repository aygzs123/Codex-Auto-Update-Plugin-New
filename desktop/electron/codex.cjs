// 领域层：把内置 PowerShell 脚本包成 exe 的功能，并向渲染进程汇报真实进度。
//
// 这一层只依赖 electron 的路径 API，PowerShell 调用全部走 ps.cjs，文本解析全部走
// parse.cjs。脚本本身是仓库里插件与 CI 共用的那一份，exe 只复用、不改写。

const { app } = require("electron");
const { createHash } = require("node:crypto");
const {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} = require("node:fs");
const { join, extname } = require("node:path");

const ps = require("./ps.cjs");
const {
  parseHealth,
  healthNeedsRepair,
  parseUpdateCheck,
  parseCachedPackages,
  partialNameFor,
  parseInstallLogLine,
  installLogTerminal,
  creepPercent,
} = require("./parse.cjs");

// ---------- 路径 ----------

// 内置脚本随安装包分发（electron-builder extraResources → resources/scripts）。
// 开发态没有 extraResources，用仓库里同步生成的同一份目录。
// 注意不能用 asar 内的路径：PowerShell 无法执行 app.asar 里的 .ps1。
function scriptRoot() {
  return app.isPackaged
    ? join(process.resourcesPath, "scripts")
    : join(__dirname, "..", "resources", "scripts");
}

function bundledScript(name) {
  const script = join(scriptRoot(), name);
  if (!existsSync(script)) throw new Error(`未找到内置脚本：${script}（请先运行 npm run sync:scripts）`);
  return script;
}

// 下载缓存与日志放用户数据目录：安装目录可能在 Program Files 下不可写，
// 而且这些本来就是用户级数据。
function downloadsRoot() {
  return join(app.getPath("userData"), "downloads");
}

function logsRoot() {
  return join(app.getPath("userData"), "logs");
}

function expandEnvironment(value) {
  return String(value).replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);
}

/** 用户在高级设置里留空表示「用默认缓存目录」。 */
function resolveDownloadDirectory(configured) {
  const value = String(configured || "").trim();
  return value ? expandEnvironment(value) : downloadsRoot();
}

// ---------- 状态与更新检查 ----------

/** 读取当前 Codex 安装状态与健康明细。退出码是状态而不是错误，见 parse.cjs。 */
async function getStatus({ probe = false } = {}) {
  const { code, stdout, stderr } = await ps.captureScript(bundledScript("check-codex-desktop-health.ps1"), {
    flags: probe ? ["-Probe"] : [],
    values: probe ? { "-ProbeSeconds": 30 } : {},
  });
  const health = parseHealth(stdout, code);
  // 探测失败时脚本把说明写在 stdout，但真正的异常栈在 stderr，一并留给界面排查。
  if (health.overall === "unknown" && stderr.trim()) health.raw = `${stdout}\n${stderr}`;
  return { ...health, needsRepair: healthNeedsRepair(health) };
}

/** 只查询版本信息，不下载。CheckOnly 模式不会写下载缓存。 */
async function checkUpdate({ downloadDirectory } = {}) {
  const directory = resolveDownloadDirectory(downloadDirectory);
  const { code, stdout, stderr } = await ps.captureScript(bundledScript("check-codex-update.ps1"), {
    flags: ["-CheckOnly", "-NoProxy"],
    values: { "-DownloadDirectory": directory },
  });
  if (code !== 0) throw new Error(ps.describeFailure({ code, stdout, stderr }));
  return { ...parseUpdateCheck(stdout), downloadDirectory: directory };
}

// ---------- 下载 ----------

/**
 * 观测 <文件名>.partial 的增长来汇报真实下载字节数。
 *
 * 这是唯一可得的进度信号：Save-CodexPackage 用 curl -sS（-s 关掉了进度表）或
 * Invoke-WebRequest（进度走 progress 流，stdout 看不到），两条路都不输出百分比。
 * 总字节数无从得知，所以只报已下载量，界面用不确定进度条，不编造百分比。
 */
function watchDownload(directory, fileName, emit) {
  const partial = join(directory, partialNameFor(fileName));
  let lastBytes = 0;
  const started = Date.now();
  const timer = setInterval(() => {
    try {
      const bytes = statSync(partial).size;
      if (bytes !== lastBytes) {
        lastBytes = bytes;
        emit({ kind: "download-bytes", bytes, elapsedMs: Date.now() - started });
      }
    } catch {
      // .partial 还没出现，或已被改名成最终文件（下载完成）。两种情况都不用处理。
    }
  }, 400);
  return () => clearInterval(timer);
}

/**
 * 下载最新 Codex 安装包。返回：
 *   { status: "latest" }                                已是最新，未下载
 *   { status: "downloaded", path, version, fileName }    已下载
 */
async function downloadCodex({ downloadDirectory } = {}, emit = () => {}) {
  const directory = resolveDownloadDirectory(downloadDirectory);
  mkdirSync(directory, { recursive: true });

  emit({ kind: "phase", id: "download", phase: "querying", label: "正在查询官方分发源", percent: 0 });

  let stopWatching = null;
  let announcedDownload = false;
  let stdout = "";

  const { done } = ps.streamScript(
    bundledScript("check-codex-update.ps1"),
    {
      flags: ["-DownloadOnly", "-NoProxy"],
      values: { "-DownloadDirectory": directory },
      onStdoutLine: (line) => {
        stdout += `${line}\n`;
        // 文件名在下载开始前就公布了，据此才能开始盯 .partial。
        const selected = line.match(/^Selected package\s*:\s*(.+)$/);
        if (selected && !stopWatching) {
          stopWatching = watchDownload(directory, selected[1].trim(), emit);
        }
        if (/^Downloaded package\s*:/.test(line) && !announcedDownload) {
          announcedDownload = true;
          emit({ kind: "phase", id: "download", phase: "downloaded", label: "安装包已下载", percent: 100 });
        }
        if (/^No newer package was found\./.test(line)) {
          emit({ kind: "phase", id: "download", phase: "latest", label: "已是最新版本，无需下载", percent: 100 });
        }
      },
    },
  );

  const { code, error } = await done;
  stopWatching?.();

  const report = parseUpdateCheck(stdout);
  if (error) throw new Error(`无法启动 PowerShell：${error.message}`);
  if (code !== 0) throw new Error(ps.describeFailure({ code, stdout, stderr: "" }));

  if (report.downloadedPath) {
    return {
      status: "downloaded",
      path: report.downloadedPath,
      version: report.availableVersion,
      fileName: report.fileName,
    };
  }

  // 没有 downloadedPath：要么已是最新，要么脚本判断无需下载。回退到目录扫描，
  // 覆盖「缓存里已经有同名包，Save-CodexPackage 直接返回而不下载」的情况。
  if (report.updateAvailable === false || report.skipped) {
    return { status: "latest", installedVersion: report.installedVersion, version: report.availableVersion };
  }

  const cached = fileNameFromCache(directory, report.fileName);
  if (cached) return { status: "downloaded", path: cached, version: report.availableVersion, fileName: report.fileName };

  throw new Error("下载结束但没有找到 MSIX 安装包");
}

function fileNameFromCache(directory, fileName) {
  if (fileName && existsSync(join(directory, fileName))) return join(directory, fileName);
  if (!existsSync(directory)) return null;
  const packages = readdirSync(directory)
    .map((name) => join(directory, name))
    .filter((path) => [".msix", ".msixbundle"].includes(extname(path).toLowerCase()))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return packages[0] || null;
}

// ---------- 签名校验 ----------

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** 校验安装包的 Authenticode 签名与 SHA-256。路径经 env 传入，不拼进代码。 */
async function verifySignature({ path }) {
  const target = String(path || "");
  if (!existsSync(target)) throw new Error(`安装包不存在：${target}`);
  const hash = await sha256(target);

  let report;
  try {
    const { stdout } = await ps.runCode(
      "$sig = Get-AuthenticodeSignature -LiteralPath $env:CODEX_VERIFY_PATH; " +
        "[pscustomobject]@{ status = [string]$sig.Status; subject = if ($null -eq $sig.SignerCertificate) { '' } else { [string]$sig.SignerCertificate.Subject } } | ConvertTo-Json -Compress",
      { env: { CODEX_VERIFY_PATH: target } },
    );
    report = JSON.parse(stdout.trim());
  } catch (error) {
    return { status: "warning", publisher: "未知", authenticode: "校验失败", sha256: hash, message: error.message };
  }

  const isOpenAi = String(report.subject || "").toLowerCase().includes("openai");
  if (report.status !== "Valid" || !isOpenAi) {
    return {
      status: "warning",
      publisher: report.subject || "未知",
      authenticode: report.status,
      sha256: hash,
      message: "签名无效或发布者不是 OpenAI，请不要继续安装",
    };
  }
  return { status: "verified", publisher: report.subject, authenticode: "已验证", sha256: hash, message: "OpenAI 签名有效，文件可信" };
}

// ---------- 安装 ----------

const INSTALL_TIMEOUT_MS = 12 * 60 * 1000;
const WORKER_START_TIMEOUT_MS = 60 * 1000;

/**
 * 安装已下载的 MSIX。
 *
 * install-codex-msix-and-restart.ps1 的非 -Worker 分支只做一件事：用
 * Start-Process 拉起一个隐藏的 detached worker，然后立刻返回。所以：
 *   - 父进程的退出码只说明 worker 有没有被拉起来，不代表安装结果
 *   - worker 的 stdout/stderr 全部丢失，唯一可观测通道是它写的日志文件
 * 因此这里的做法是启动父进程后转入日志 tail，把日志行翻译成进度事件。
 *
 * 刻意不传 -SkipLaunch：worker 会在安装后自动启动 Codex 并探测主窗口，
 * 这既是一键安装该有的收尾，也顺带验证了安装结果（探测失败正是加密资源
 * 搬迁 bug 的特征）。窗口探测最多再等 30 秒。
 */
async function installCodex({ path, allowDowngrade, downloadDirectory }, emit = () => {}) {
  const target = String(path || "");
  if (!existsSync(target)) throw new Error(`安装包不存在：${target}`);

  mkdirSync(logsRoot(), { recursive: true });
  // 每次运行用独立日志文件，避免与上一轮的残留内容交错。
  const logPath = join(logsRoot(), `install-${Date.now()}.log`);

  emit({ kind: "phase", id: "install", phase: "starting", label: "正在启动安装程序", percent: 0 });

  const { code, stdout, stderr } = await ps.captureScript(bundledScript("install-codex-msix-and-restart.ps1"), {
    // 降级开关只由界面上的回退入口打开。默认路径（一键更新）保持不带它 ——
    // 不带时 Windows 会拒绝安装版本号更低的包，这正是一键更新该有的严格性。
    flags: allowDowngrade ? ["-AllowDowngrade"] : [],
    values: {
      "-PackagePath": target,
      "-LogPath": logPath,
      // 装完之后 worker 要在**缓存目录**里剪枝（保留最近 2 个），目录由 main 解析好传进来。
      // 拿不到就退回默认缓存根目录 —— 那正是 resolveDownloadDirectory("") 的语义，
      // 也就是「用户没自定义过缓存目录」时安装包真正所在的地方。
      "-DownloadDirectory": String(downloadDirectory || "") || resolveDownloadDirectory(""),
    },
  });
  if (code !== 0) throw new Error(ps.describeFailure({ code, stdout, stderr }));

  return tailInstallLog(logPath, emit);
}

/**
 * 列出下载缓存里现存的安装包，供界面判断「能不能回退、退到哪一版」。
 *
 * 只读，走一个独立的内置脚本而不是在 JS 里 readdir：文件名的版本号格式（以及
 * installed/older/newer 的比较）在 CodexStoreUpdater.psm1 里已经有一份权威实现，
 * 在 JS 里照抄一份正则，两边迟早会对不上。脚本输出的文本契约由 parse.cjs 解析，
 * 与其它脚本一致。
 */
async function listCachedPackages({ downloadDirectory } = {}) {
  const directory = resolveDownloadDirectory(downloadDirectory);
  const { code, stdout, stderr } = await ps.captureScript(bundledScript("list-cached-codex-packages.ps1"), {
    values: { "-DownloadDirectory": directory },
  });
  if (code !== 0) throw new Error(ps.describeFailure({ code, stdout, stderr }));
  return parseCachedPackages(stdout);
}

/**
 * 跟随安装日志直到出现终止状态。
 *
 * 日志由 worker 的 Write-InstallLog 追加（[System.IO.File]::AppendAllText + UTF-8 无 BOM），
 * 是「整行 + 换行」写入，但读取时仍可能撞上半行，所以保留 pending 缓冲，只处理到最后一个换行。
 */
async function tailInstallLog(logPath, emit) {
  let offset = 0;
  let pending = "";
  let current = { phase: "starting", percent: 0, label: "正在启动安装程序" };
  let phaseStartedAt = Date.now();
  const startedAt = Date.now();
  let workerStarted = false;
  let remedy = null;
  let windowMissing = false;
  let terminal = null;
  let terminalSeenAt = 0;
  let lastLineAt = Date.now();
  // worker 顶层 trap 报出来的失败原因（FATAL 行）。它才是用户该看到的那句话。
  let failureMessage = null;
  const healthSnapshot = [];

  // 探针失败后，脚本还要接着写健康快照和补救提示（见 install-codex-msix-and-restart.ps1：
  // WINDOW_PROBE=FAILED 在前，Relocation health snapshot / Remedy 在后）。所以撞到终止标记
  // 不能立刻收工，得再等一小段把这些诊断行收进来 —— 否则最需要诊断的那条路径上，
  // 诊断信息必然被丢掉。成功路径后面没有内容，不必等。
  const DIAGNOSTIC_QUIET_MS = 1200;
  const DIAGNOSTIC_GRACE_MS = 6000;

  const lines = () => {
    if (!existsSync(logPath)) return;
    const buffer = readFileSync(logPath);
    if (buffer.length <= offset) return;
    pending += buffer.subarray(offset).toString("utf8");
    offset = buffer.length;

    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      lastLineAt = Date.now();
      const event = parseInstallLogLine(line);
      emit({ kind: "log", line: event.message, at: event.at });

      // 带 phase 的事件都要推进阶段，不能只认 stage 类型：probe-failed 带着
      // phase="failed" 和「Codex 已安装，但主窗口没有出现」，漏掉它界面就会在失败时
      // 显示 100% +「正在确认 Codex 窗口」，等于把失败说成还没结束。
      // 阶段变了要发，**阶段没变但措辞变了也要发**。
      //
      // 同一阶段下有多个里程碑：verifying 既有「安装完成，正在校验版本」(78) 也有
      // 「回退已生效」(80)，cleanup 下还有三条不同措辞。只认阶段变化的话，后一条的
      // 文案永远到不了界面 —— 回退时用户就看不到那句确认降级真的生效了的话，
      // 只看到进度从 78 直接跳到 86。
      if (event.phase && (event.phase !== current.phase || event.label !== current.label)) {
        current = { phase: event.phase, percent: Math.max(event.percent, current.percent), label: event.label };
        phaseStartedAt = Date.now();
        emit({ kind: "phase", id: "install", ...current, warning: event.warning });
      } else if (event.phase) {
        current.percent = Math.max(event.percent, current.percent);
      }

      if (event.type === "probe-failed") windowMissing = true;
      if (event.type === "fatal") failureMessage = event.message;
      if (event.type === "remedy") remedy = event.remedy;
      if (event.type === "health-component") healthSnapshot.push({ name: event.name, state: event.state });
      if (event.type === "warning" || event.warning) {
        emit({ kind: "warning", message: event.message });
      }

      const seen = installLogTerminal(event);
      if (seen && !terminal) {
        terminal = seen;
        terminalSeenAt = Date.now();
      }
    }
  };

  while (true) {
    lines();

    if (terminal) {
      const settled =
        terminal !== "window-missing" ||
        Date.now() - lastLineAt >= DIAGNOSTIC_QUIET_MS ||
        Date.now() - terminalSeenAt >= DIAGNOSTIC_GRACE_MS;
      if (settled) {
        // worker 自己报的失败：日志里那行 FATAL 就是真实原因，直接把它当成错误抛出去。
        // 少了这一条，失败只能等满 12 分钟超时才会浮现，而超时消息说的是「安装超时」——
        // 真正的原因（Windows 拒绝降级、安装包损坏、路径不对）反倒被埋在最底下。
        if (terminal === "failed") {
          // 原因写在第一行：界面上报错只显示首行，而用户要看的正是这一句。
          throw new Error(`安装失败：${failureMessage ?? "worker 未给出原因"}\n完整日志：${logPath}`);
        }

        // 正常路径下终止行本身就是 done 阶段（已发过），这里只兜底。
        if (current.percent < 100) {
          emit({ kind: "phase", id: "install", phase: "done", percent: 100, label: current.label });
        }
        const health = await getStatus().catch(() => null);
        return {
          ok: terminal === "success" && !windowMissing,
          windowMissing,
          remedy,
          healthSnapshot,
          logPath,
          version: health?.version ?? null,
          health,
        };
      }
      await sleep(350);
      continue;
    }

    if (!workerStarted && !existsSync(logPath)) {
      if (Date.now() - startedAt > WORKER_START_TIMEOUT_MS) {
        throw new Error(
          "安装 worker 未启动（60 秒内没有生成安装日志）。这通常意味着 PowerShell 无法拉起子进程；请改用 Windows PowerShell 5.1 重试。",
        );
      }
    } else {
      workerStarted = true;
    }

    if (Date.now() - startedAt > INSTALL_TIMEOUT_MS) {
      const tail = readTail(logPath);
      throw new Error(`安装超时（超过 12 分钟）。最后一次日志：\n${tail}`);
    }

    // 日志静默期（Add-AppxPackage 可能安静地跑几分钟）也要让进度条前进，
    // 但爬升被限制在下一里程碑之前，不会出现回退或提前完成。
    if (workerStarted && current.phase !== "done") {
      const next = nextMilestone(current.percent);
      const crept = creepPercent(current.percent, next, Date.now() - phaseStartedAt);
      if (crept > current.percent) {
        current.percent = crept;
        emit({ kind: "phase", id: "install", ...current });
      }
    }

    await sleep(350);
  }
}

/** 下一个里程碑百分比，用于限制爬升上限。 */
const MILESTONES = [4, 12, 20, 78, 86, 90, 94, 100];
function nextMilestone(percent) {
  return MILESTONES.find((value) => value > percent) ?? 100;
}

function readTail(logPath, maxLines = 8) {
  try {
    return readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n");
  } catch {
    return "（无法读取安装日志）";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- 启动与修复 ----------

/**
 * 启动 Codex **并确认主窗口真的出现了**。
 *
 * MSIX 应用不能用 exe 路径启动，只能走 AppUserModelId（explorer.exe
 * shell:AppsFolder\<PFN>!<AppId>）。但「发出启动请求」和「窗口出现」是两件事：
 * Codex Desktop 有个官方 bug —— 进程起来了、主窗口永远不出现（加密资源搬迁失败，
 * 见 docs/codex-desktop-encrypted-copy-fix）。原来的实现在这里 fire-and-forget，
 * 于是启动请求发出去就返回成功，界面上报「已请求启动 Codex」，而用户屏幕上什么都
 * 没有 —— 看起来就是「点了没反应」，且失败原因完全丢失。
 *
 * 所以这里复用健康脚本的 -Probe（插件、CI 与「健康自检」按钮用的同一份实现），
 * 启动后等主窗口，把结论如实报回去；进程在、窗口不在时连补救入口一起给出来。
 */
async function launchCodex({ probeSeconds = 20 } = {}, emit = () => {}) {
  const seconds = Number(probeSeconds) > 0 ? Math.round(Number(probeSeconds)) : 20;
  emit({ kind: "phase", id: "launch", phase: "starting", label: "正在启动 Codex", percent: 20 });

  const output = [];
  const errors = [];
  let announced = false;
  const { done } = ps.streamScript(bundledScript("check-codex-desktop-health.ps1"), {
    flags: ["-Probe"],
    values: { "-ProbeSeconds": seconds },
    onStdoutLine: (line) => {
      output.push(line);
      // 脚本在真正开始等窗口之前会打印这一行，拿它当「已经发出启动请求」的信号。
      // 等窗口这段时间脚本没有任何输出，界面必须自己给出进展，否则又是一次
      // 「点了没反应」。
      if (!announced && /^Probing for a visible main window/.test(line)) {
        announced = true;
        emit({
          kind: "phase",
          id: "launch",
          phase: "probing",
          label: `正在等待主窗口出现（最多 ${seconds} 秒）`,
          percent: 70,
        });
        emit({
          kind: "log",
          line: `已发出启动请求，等待主窗口。若 ${seconds} 秒内没有出现，就是官方已知的加密资源搬迁问题，可用「修复资源副本」处理。`,
        });
      }
    },
    onStderrLine: (line) => errors.push(line),
  });

  const { code, error } = await done;
  if (error) throw new Error(`无法启动 PowerShell：${error.message}`);

  const stdout = output.join("\n");
  const health = parseHealth(stdout, code);
  // 退出码 2 是唯一真正的失败：这台机器上没装 Codex，启动无从谈起。
  if (health.overall === "not-installed" || code === 2) {
    throw new Error("找不到已安装的 Codex，请先点「一键安装 Codex」。");
  }

  // 没有 RESULT= 行说明探测根本没跑完（脚本中途抛错），绝对不能当成「窗口没出现」——
  // 那等于把一次工具故障说成用户的 Codex 坏了，把人引去修一个不存在的资源问题。
  // 这个分支真被踩到过：AppId 绑定在 PowerShell 5.1 下抛错，探测一直断在这里。
  if (!health.probeResult) {
    throw new Error(`窗口探测没有跑完，无法判断 Codex 是否启动。\n${ps.describeFailure({ code, stdout, stderr: errors.join("\n") })}`);
  }

  const windowVisible = health.probeResult === "window-visible";
  emit({
    kind: "phase",
    id: "launch",
    phase: windowVisible ? "done" : "failed",
    label: windowVisible ? "Codex 已启动" : "进程已启动，但没有出现主窗口",
    percent: 100,
  });

  return {
    ok: windowVisible,
    windowVisible,
    version: health.version,
    appUserModelId: health.appUserModelId,
    probeMessage: health.probeMessage,
    health: { ...health, needsRepair: healthNeedsRepair(health) },
  };
}

/**
 * 修复加密资源搬迁导致的「进程在跑但没有主窗口」。
 * 只重写用户目录下的资源副本，不修改已安装的 MSIX 本体。
 */
async function repairBundles(_args = {}, emit = () => {}) {
  emit({ kind: "phase", id: "repair", phase: "repairing", label: "正在重建资源副本", percent: 0 });
  const output = [];
  const { done } = ps.streamScript(bundledScript("repair-codex-desktop-bundles.ps1"), {
    onStdoutLine: (line) => {
      output.push(line);
      emit({ kind: "log", line });
    },
  });
  const { code, error } = await done;
  if (error) throw new Error(`无法启动 PowerShell：${error.message}`);
  if (code !== 0) throw new Error(ps.describeFailure({ code, stdout: output.join("\n"), stderr: "" }));
  emit({ kind: "phase", id: "repair", phase: "done", label: "资源副本已重建", percent: 100 });
  return { ok: true, output: output.join("\n") };
}

module.exports = {
  scriptRoot,
  bundledScript,
  downloadsRoot,
  logsRoot,
  resolveDownloadDirectory,
  getStatus,
  checkUpdate,
  downloadCodex,
  verifySignature,
  installCodex,
  listCachedPackages,
  tailInstallLog,
  launchCodex,
  repairBundles,
  fileNameFromCache,
};
