// 内置 PowerShell 脚本的文本契约解析。
//
// 这些脚本是仓库里已有的、插件与 CI 共用的脚本，exe 只是复用它们，不修改其输出
// 格式。所以「输出格式 = 契约」这件事在解析层集中处理一次，并用 parse.test.cjs 钉住。
// 这里不依赖 electron，可以直接用 node 跑测试。
//
// 四个契约来源：
//   check-codex-desktop-health.ps1   退出码 0/1/2/3 + [OK   ] name path + OVERALL=
//   check-codex-update.ps1           Update available: / Downloaded package: / .partial
//   install-codex-msix-and-restart.ps1  [时间] 消息（worker 写日志文件）
//   repair-codex-desktop-bundles.ps1    自由文本输出

// ---------- 健康检查 ----------

const HEALTH_STATES = { OK: "ok", MISS: "missing", PART: "partial", ERR: "error" };

/**
 * 解析 check-codex-desktop-health.ps1 的输出。
 *
 * 退出码是主要状态来源，文本用于补齐明细：
 *   0 健康 / 1 降级 / 2 未安装 / 3 探测到进程但没有主窗口
 */
function parseHealth(stdout, exitCode) {
  const text = String(stdout || "");
  const result = {
    installed: exitCode !== 2,
    exitCode,
    packageFullName: null,
    version: null,
    installLocation: null,
    overall: exitCode === 2 ? "not-installed" : "unknown",
    components: [],
    pluginsMaterialized: null,
    appUserModelId: null,
    probeResult: null,
    probeMessage: null,
    raw: text,
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const overall = trimmed.match(/^OVERALL=(\S+)$/);
    if (overall) {
      result.overall = overall[1];
      continue;
    }

    const pkg = trimmed.match(/^Package\s*:\s*(.+)$/);
    if (pkg) {
      result.packageFullName = pkg[1].trim();
      continue;
    }

    const version = trimmed.match(/^Version\s*:\s*(.+)$/);
    if (version) {
      result.version = version[1].trim();
      continue;
    }

    // 包实际落在哪个盘由包自己报。用户可以把它装在 D:（应用卷），所以这里
    // 一个字符都不许改，界面直接照原样显示。
    const location = trimmed.match(/^Location\s*:\s*(.+)$/);
    if (location) {
      result.installLocation = location[1].trim();
      continue;
    }

    const appId = trimmed.match(/^AppUserModelId\s*:\s*(.+)$/);
    if (appId) {
      result.appUserModelId = appId[1].trim();
      continue;
    }

    const plugins = trimmed.match(/^Plugins\s*:\s*(.+)$/);
    if (plugins) {
      result.pluginsMaterialized = /^materialized/i.test(plugins[1].trim());
      continue;
    }

    const probe = trimmed.match(/^RESULT=(\S+)$/);
    if (probe) {
      result.probeResult = probe[1];
      continue;
    }

    // [OK   ] win-cli      C:\...\bin\8e5b6932251c2c1c
    // [MISS ] win-rg       C:\...  <- staging/repair leftovers: 2
    // 方括号内的状态符号是右对齐补空格的（"OK   " 共 5 字符），所以不能要求它无空格。
    const component = trimmed.match(/^\[([^\]]{1,8})\]\s+(\S+)\s+(.*)$/);
    if (component) {
      const symbol = component[1].trim().toUpperCase();
      let detail = component[3].trim();
      let leftovers = 0;
      const note = detail.split(/\s*<-\s*/);
      if (note.length === 2) {
        detail = note[0].trim();
        const count = note[1].match(/(\d+)/);
        leftovers = count ? Number(count[1]) : 0;
      }
      result.components.push({
        state: HEALTH_STATES[symbol] || "unknown",
        symbol,
        name: component[2],
        path: detail,
        leftovers,
      });
      continue;
    }

    // 探测失败时脚本会给出这几句说明，保留下来当作提示。
    if (/^WARNING:/.test(trimmed) || /^This is the signature of/.test(trimmed)) {
      result.probeMessage = result.probeMessage ? `${result.probeMessage} ${trimmed}` : trimmed;
    }
  }

  return result;
}

/**
 * 健康结果是否需要在界面上给出「修复」入口。
 *
 * 只看 bundle 状态和窗口探测结果 —— 这两者是 repair-codex-desktop-bundles.ps1
 * 真正能修的东西（它物化的正是那五个 bundle）。
 *
 * 刻意不看 PluginsMaterialized：本机实测健康输出里 Plugins 是
 * "NOT materialized (bundled plugins stale)" 而 OVERALL 仍是 ok，修复脚本也完全
 * 不碰插件。把它当修复触发条件，会让每个用户都常驻看到一个修不好的横幅。
 * 这个信息照常展示，只是不驱动动作。
 */
function healthNeedsRepair(health) {
  if (!health || !health.installed) return false;
  if (health.probeResult === "window-not-visible") return true;
  return health.components.some((component) => component.state !== "ok");
}

// ---------- 更新检查 ----------

/**
 * 解析 check-codex-update.ps1 的输出。
 *
 * 关键输出：
 *   Installed version: 26.901.6511.0 | not installed or not visible to Get-AppxPackage
 *   Available version: 26.902.100.0
 *   Selected package: OpenAI.Codex_26.902.100.0_x64__2p2nqsd0c76g0.msix
 *   Update available: True | False
 *   Downloaded package: <path>        （仅在真正下载时出现）
 *   No newer package was found. Skipping download.
 */
function parseUpdateCheck(stdout) {
  const result = {
    installedVersion: null,
    availableVersion: null,
    fileName: null,
    updateAvailable: null,
    downloadedPath: null,
    skipped: false,
    removedCacheFiles: [],
    querying: false,
  };

  const lines = String(stdout || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;

    if (/^Querying Codex package links/.test(trimmed)) result.querying = true;
    if (/^No newer package was found\./.test(trimmed)) result.skipped = true;

    const installed = trimmed.match(/^Installed version\s*:\s*(.+)$/);
    if (installed) {
      const value = installed[1].trim();
      // 这一行在未安装时是一句说明而不是版本号，不能当作版本。
      result.installedVersion = /^not installed/i.test(value) ? null : value;
      continue;
    }

    const available = trimmed.match(/^Available version\s*:\s*(.+)$/);
    if (available) {
      result.availableVersion = available[1].trim();
      continue;
    }

    const selected = trimmed.match(/^Selected package\s*:\s*(.+)$/);
    if (selected) {
      result.fileName = selected[1].trim();
      continue;
    }

    const update = trimmed.match(/^Update available\s*:\s*(True|False)$/i);
    if (update) {
      result.updateAvailable = /^true$/i.test(update[1]);
      continue;
    }

    const downloaded = trimmed.match(/^Downloaded package\s*:\s*(.+)$/);
    if (downloaded) {
      result.downloadedPath = downloaded[1].trim();
      continue;
    }

    // 「Removed N superseded package file(s)」后面跟缩进的两空格路径行。
    const removed = trimmed.match(/^Removed\s+(\d+)\s+superseded/);
    if (removed) {
      for (let offset = 1; offset <= Number(removed[1]); offset++) {
        const candidate = lines[index + offset];
        if (candidate && /^\s{2}\S/.test(candidate)) result.removedCacheFiles.push(candidate.trim());
        else break;
      }
    }
  }

  return result;
}

/**
 * 解析 list-cached-codex-packages.ps1 的输出：缓存目录里现存的安装包清单。
 *
 * 形状沿用 `Removed N ...` 那一套（计数行 + N 行两空格缩进）—— 那是这个仓库里唯一有
 * 先例的「变长列表」文本格式。每行用管道分隔，路径放在**最后**一个字段并按 6 段切分：
 * 路径里出现 `|` 的可能性极低，但真出现时这样切不会让字段错位。
 *
 * 输出示例：
 *   Download directory: C:\Users\me\AppData\Roaming\Codex Updater\downloads
 *   Installed version: 26.924.2738.0        （未安装时是 "not installed"）
 *   Cached package count: 2
 *     26.924.2738.0|x64|876123456|2026-09-28T13:26:56Z|installed|C:\...\OpenAI.Codex_26.924.2738.0_x64__2p2nqsd0c76g0.msix
 */
function parseCachedPackages(stdout) {
  const result = { downloadDirectory: null, installedVersion: null, packages: [] };

  const lines = String(stdout || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;

    const directory = trimmed.match(/^Download directory\s*:\s*(.+)$/);
    if (directory) {
      result.downloadDirectory = directory[1].trim();
      continue;
    }

    const installed = trimmed.match(/^Installed version\s*:\s*(.+)$/);
    if (installed) {
      const value = installed[1].trim();
      // 与 parseUpdateCheck 同一套约定：未安装时这一行是说明文字，不是版本号。
      result.installedVersion = /^not installed/i.test(value) ? null : value;
      continue;
    }

    const count = trimmed.match(/^Cached package count\s*:\s*(\d+)$/);
    if (count) {
      for (let offset = 1; offset <= Number(count[1]); offset++) {
        const candidate = lines[index + offset];
        if (!candidate || !/^\s{2}\S/.test(candidate)) break;
        const fields = candidate.trim().split("|");
        if (fields.length < 6) continue;
        result.packages.push({
          version: fields[0],
          architecture: fields[1],
          sizeBytes: Number(fields[2]) || 0,
          modifiedAt: fields[3],
          // installed | older | newer —— 由 PowerShell 侧用 [version] 比较得出，
          // 见 CodexStoreUpdater.psm1 的 Get-CachedCodexPackages。
          relation: fields[4],
          path: fields.slice(5).join("|"),
        });
      }
    }
  }

  return result;
}

/** 下载中用于观测进度的临时文件名。Save-CodexPackage 先写 <名字>.partial 再改名。 */
function partialNameFor(fileName) {
  return fileName ? `${fileName}.partial` : null;
}

// ---------- 安装日志 ----------

// 安装 worker 是 Start-Process 拉起的隐藏进程，stdout 完全丢失，唯一可观测的通道
// 就是它写的日志文件。所以日志行就是进度事件的唯一来源。
//
// 注意 Add-AppxPackage 那一步可能安静地跑几分钟，期间没有任何日志行。所以这里给出
// 每个阶段的 percent 只是「里程碑下界」，实际的进度条由调用方在该阶段内做时间爬升，
// 不能假装日志会持续汇报。
const INSTALL_STAGES = [
  { match: /^Worker started for package:\s*(.+)$/, phase: "preparing", percent: 4, label: "准备安装" },
  { match: /^Closed (\d+) Codex Desktop process/, phase: "closing", percent: 12, label: "关闭正在运行的 Codex" },
  // 提权那条路（install-codex-msix-and-restart.ps1 的 Invoke-CodexElevatedInstall 写的）。
  // 14 必须落在 closing(12) 与 installing(20) 之间：百分比是取最大值单调前进的，
  // 写小了会被 12 吞掉（用户就看不到「在等 UAC」这句，只看到进度条卡住），
  // 写大了会让后面的安装里程碑看起来在倒退。
  { match: /^Requesting administrator privileges/, phase: "elevating", percent: 14, label: "正在请求管理员权限（请在 UAC 弹窗中允许）" },
  // 回退那一跑写的是 "Installing package with Add-AppxPackage (downgrade allowed)..."，
  // 比这行的原话多一个括号。以前只认原话，于是**回退时进度条卡在 12% 不动**，
  // 一路到「安装完成」才跳到 100% —— 看起来像卡死了。
  { match: /^Installing package with Add-AppxPackage(?: \(downgrade allowed\))?\.\.\.$/, phase: "installing", percent: 20, label: "Windows 正在安装 Codex" },
  { match: /^Install command completed\.$/, phase: "verifying", percent: 78, label: "安装完成，正在校验版本" },
  // 降级专属的一行。它排在「Install command completed」之后、清理之前，百分比必须落在
  // 两者之间 —— 进度条的百分比是取最大值单调前进的，这里写小了会被吞掉、写大了会让
  // 后面的清理里程碑看起来在倒退。
  { match: /^Downgrade verified\./, phase: "verifying", percent: 80, label: "回退已生效" },
  { match: /^Removed superseded package file:/, phase: "cleanup", percent: 86, label: "清理旧安装包" },
  { match: /^No superseded package file to remove/, phase: "cleanup", percent: 86, label: "安装包保留下来供回退使用" },
  { match: /^Package cache cleanup failed/, phase: "cleanup", percent: 86, label: "安装包清理失败（不影响使用）", warning: true },
  { match: /^Restart requested\. Installed version:\s*(.+)$/, phase: "restarting", percent: 90, label: "正在启动 Codex" },
  { match: /^Probing for a visible main window/, phase: "probing", percent: 94, label: "正在确认 Codex 窗口" },
  { match: /^Window probe OK/, phase: "done", percent: 100, label: "安装完成，Codex 已启动" },
  { match: /^Skip launch requested\./, phase: "done", percent: 100, label: "安装完成" },
];

/**
 * 把一行安装日志翻译成进度事件；与任何阶段都不匹配时返回 null（调用方按原始日志展示）。
 *
 * 日志行格式：`[2026-09-28 06:20:31] 消息`
 */
function parseInstallLogLine(line) {
  const raw = String(line || "");
  const stamped = raw.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s?(.*)$/);
  const message = stamped ? stamped[2] : raw;
  const base = { at: stamped ? stamped[1] : null, message };

  if (!message.trim()) return { type: "blank", ...base };

  for (const stage of INSTALL_STAGES) {
    const matched = message.match(stage.match);
    if (matched) {
      return {
        type: "stage",
        ...base,
        phase: stage.phase,
        percent: stage.percent,
        label: stage.label,
        warning: Boolean(stage.warning),
        detail: matched[1] ? matched[1].trim() : null,
      };
    }
  }

  if (/^WINDOW_PROBE=FAILED/.test(message)) {
    return { type: "probe-failed", ...base, phase: "failed", percent: 100, label: "Codex 已安装，但主窗口没有出现" };
  }

  if (/^Relocation health snapshot:/.test(message)) {
    return { type: "health-snapshot", ...base };
  }

  const component = message.match(/^\s*component\s+(\S+)\s+state=(\S+)\s*$/);
  if (component) {
    return { type: "health-component", ...base, name: component[1], state: component[2] };
  }

  const plugins = message.match(/^\s*bundled plugins materialized:\s*(\S+)\s*$/);
  if (plugins) {
    return { type: "health-plugins", ...base, materialized: /^true$/i.test(plugins[1]) };
  }

  // worker 顶层 trap 写的失败行（install-codex-msix-and-restart.ps1）。
  // 它出现在**任何位置**：包的路径不对、包名不对、Windows 拒绝降级，都会走这里。
  // 识别成独立的 fatal 类型，是为了让 tail 能立刻收工并把这句话当成错误原因，
  // 而不是傻等到 12 分钟超时、再报一句和真实原因无关的「安装超时」。
  if (/^FATAL:/.test(message)) {
    return { type: "fatal", ...base, phase: "failed", percent: 100, label: "安装失败" };
  }

  if (/^Remedy:/.test(message)) return { type: "remedy", ...base, remedy: message.replace(/^Remedy:\s*/, "") };
  if (/^This is the signature of the official/.test(message)) return { type: "note", ...base };
  if (/^Could not collect relocation health/.test(message)) return { type: "note", ...base };

  return { type: "log", ...base };
}

/** 判断日志是否已到终止状态，用于结束 tail 循环。 */
function installLogTerminal(parsed) {
  if (!parsed) return null;
  if (parsed.type === "stage" && parsed.phase === "done") return "success";
  if (parsed.type === "probe-failed") return "window-missing";
  if (parsed.type === "fatal") return "failed";
  return null;
}

/**
 * 长阶段内的进度爬升：日志静默时也要让进度条动，但要渐近逼近下界之上限，
 * 绝不越过下一个里程碑（否则会出现「进度 90% 却回退」的假象）。
 */
function creepPercent(phasePercent, nextPercent, elapsedMs) {
  const ceiling = Math.min(nextPercent - 2, 99);
  if (ceiling <= phasePercent) return phasePercent;
  const span = ceiling - phasePercent;
  // 约 150 秒走完 80% 的剩余区间，之后只靠残余缓慢逼近。
  const progress = 1 - Math.exp(-elapsedMs / 90000);
  return Math.min(ceiling, Math.round(phasePercent + span * progress));
}

module.exports = {
  parseHealth,
  healthNeedsRepair,
  parseUpdateCheck,
  parseCachedPackages,
  partialNameFor,
  parseInstallLogLine,
  installLogTerminal,
  creepPercent,
  INSTALL_STAGES,
};
