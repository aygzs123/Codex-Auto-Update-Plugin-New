// 主进程 codex.cjs / parse.cjs 返回值与推送事件在前端的类型镜像。
// 两边不一致时 TypeScript 会在调用处报错，所以这里保持与主进程字段一一对应。

export interface HealthComponent {
  state: "ok" | "missing" | "partial" | "error" | "unknown";
  symbol: string;
  name: string;
  path: string;
  leftovers: number;
}

export interface HealthReport {
  installed: boolean;
  exitCode: number;
  packageFullName: string | null;
  version: string | null;
  /** 包实际安装到的目录，由 Get-AppxPackage 现取（可能是 D:\WindowsApps\...）。 */
  installLocation: string | null;
  /** ok | degraded | not-installed | unknown */
  overall: string;
  components: HealthComponent[];
  pluginsMaterialized: boolean | null;
  appUserModelId: string | null;
  /** window-visible | window-not-visible | null（未探测） */
  probeResult: string | null;
  probeMessage: string | null;
  /**
   * 窗口没出现时，脚本按证据给出的判定；判不出来就是 "unknown"，老脚本/没探测则是 null。
   * 界面上的文案与「要不要给修复入口」都由它决定（见 src/lib/diagnosis.ts）。
   */
  startupDiagnosis: StartupDiagnosis;
  /**
   * 是否值得给出「修复」入口。由主进程按 parse.cjs 的规则判定：
   * 窗口没出现（探针说的）**或** 有未完成的物化残留。
   */
  needsRepair: boolean;
  /**
   * 有未完成物化残留（`state === "partial"`）的组件名，判据同样在主进程（parse.cjs 的
   * healthRepairTargets）。界面上的资源修复横幅由**它**驱动，不由 needsRepair 驱动 ——
   * 后者的探针分支是另一回事，那档由健康面板自己的说明承担。
   *
   * 刻意只认 partial：目标目录不在但留着 `.staging`/`.repair` 残留，是「物化试过、
   * 没跑完」的证据。裸 missing 是首次启动前的常态（本机 2026-10-02 的 wsl-cli 就是），
   * error 是 MSIX 自身源文件缺失、修复脚本从同一份源复制因而救不了。
   */
  repairTargets: string[];
  raw: string;
}

export type SignatureStatus = "verified" | "warning";

export interface SignatureReport {
  status: SignatureStatus;
  publisher: string;
  /** 期望的发布者：正常取自已安装的 Codex，本机没装时取 verify.cjs 里登记的常量。 */
  expectedPublisher: string;
  authenticode: string;
  sha256: string;
  message: string;
}

export interface UpdateReport {
  installedVersion: string | null;
  availableVersion: string | null;
  fileName: string | null;
  updateAvailable: boolean | null;
  downloadedPath: string | null;
  skipped: boolean;
  /**
   * 这次检查顺带从下载缓存里剪掉的旧包（脚本按「保留最近两个」剪枝）。
   *
   * 即便只是 `-CheckOnly` 不下载，脚本也会执行剪枝 —— 所以检查完可能真的少了文件，
   * 「版本历史」卡片要跟着刷新，否则它列的是已经不在磁盘上的包。
   */
  removedCacheFiles: string[];
  downloadDirectory: string;
}

/**
 * 下载缓存里的一个安装包。
 *
 * `relation` 由 PowerShell 侧用 [version] 比较后给出：版本比较只留一处实现，
 * 免得 JS 这边再写一份、两边对「26.9 和 26.10 谁大」给出不同答案。
 */
export interface CachedPackage {
  version: string;
  architecture: string;
  sizeBytes: number;
  /** ISO 8601（UTC），由脚本格式化后输出，渲染时直接用。 */
  modifiedAt: string;
  /** installed（就是当前这一版）| older（可回退到的版本）| newer（已下载但比当前新）。 */
  relation: "installed" | "older" | "newer" | "unknown";
  path: string;
  /**
   * 是否被用户固定。固定的包不会被自动剪枝删掉（主进程把它写进缓存目录的
   * `.codex-pins.json`，PowerShell 剪枝时会跳过）。
   */
  pinned?: boolean;
}

export interface CachedPackageList {
  /**
   * 枚举脚本回传的最终缓存目录。**可能为 null**：parse.cjs 只在输出里真的出现
   * `Download directory:` 那一行时才填，脚本没跑成、输出被截断、或对上的是旧版脚本时
   * 都是 null。这里跟 installedVersion 一样如实声明，别写成 string ——
   * effectiveDownloadDirectory 本来就是按「可能是空」写的（先判 resolved 再回退设置）。
   */
  downloadDirectory: string | null;
  /** 未安装时为 null。 */
  installedVersion: string | null;
  packages: CachedPackage[];
}

/** 缓存快照的读取状态。ready 才代表「这份列表是这一轮真实读到的」。 */
export type CacheScanStatus = "idle" | "scanning" | "ready" | "error";

/** 一个磁盘位置的总量 / 剩余。由主进程用 fs.statfs 读取，缺路径时为 null。 */
export interface StorageLocation {
  path: string;
  totalBytes: number;
  freeBytes: number;
}

export interface StorageInfo {
  download: StorageLocation | null;
  /** Codex 应用本体所在卷；未安装时为 null。 */
  install: StorageLocation | null;
}

export interface CacheMigrationFile {
  name: string;
  sizeBytes: number;
}

/** 迁移预检结果。真正执行前必须再跑一次，不能把这份结果当授权。 */
export interface CacheMigrationPlan {
  sourceDirectory: string;
  targetDirectory: string;
  files: CacheMigrationFile[];
  totalBytes: number;
  freeBytes: number;
  /** 目标目录里已存在同名文件；执行时逐个校验，内容相同则跳过，不同则中止。 */
  conflicts: string[];
}

export interface CacheMigrationProgress {
  copiedFiles: number;
  totalFiles: number;
  copiedBytes: number;
  totalBytes: number;
  currentFile: string;
}

export interface CacheMigrationResult {
  ok: boolean;
  cancelled: boolean;
  sourceDirectory: string;
  targetDirectory: string;
  copiedCount: number;
  copiedBytes: number;
  skippedCount: number;
  /** 已切换设置但源目录仍有残留时如实列出，不虚报释放空间。 */
  cleanedCount: number;
  cleanupFailures: Array<{ name: string; message: string }>;
}

/** Codex 应用本体迁移能力检测结果。 */
export interface AppVolume {
  /** AppxVolume 的 PackageStorePath，例如 D:\WindowsApps。 */
  path: string;
  label: string;
  isSystemVolume: boolean;
  freeBytes: number;
  totalBytes: number;
}

export interface AppMigrationCapability {
  installed: boolean;
  version: string | null;
  installLocation: string | null;
  packageVolume: string | null;
  /** Windows 是否报告该包可移动。检测通过不等于执行一定成功，执行仍以部署服务结果为准。 */
  movable: boolean;
  reason: string;
  volumes: AppVolume[];
  /**
   * 检测本身失败（脚本没跑起来、输出解析不了）。和「没装 Codex」是两件事：
   * 两者都给 installed=false，但界面不能把执行失败说成「尚未安装」。
   * 主进程正常返回时不带这个字段。
   */
  failed?: boolean;
}

/**
 * GitHub Release 里的一个资产（安装包）。
 *
 * `digest` 是 GitHub 自己算的 `sha256:<hex>`；应用内下载完必须拿它比对，所以这里
 * 原样保留。没有摘要的资产不能下载 —— 无法校验不等于校验通过。
 */
export interface GithubAsset {
  name: string;
  size: number;
  url: string;
  digest: string;
}

/**
 * GitHub Release 里的一个版本条目。
 *
 * `tag` 是识别公告与新版本的唯一 id（例如 `desktop-v0.3.0`）；`body` 是 Release 正文，
 * 界面上截成一小段「更新公告」，不整段铺开。
 */
export interface GithubReleaseInfo {
  version: string;
  tag: string;
  name: string;
  body: string;
  url: string;
  publishedAt: string | null;
  assets: GithubAsset[];
}

/** 主进程 get_github_updates 的结果。网络失败时 error 有值，数据可能是上次成功读到的。 */
export interface GithubUpdates {
  /** 比当前运行版本新的最新一条；没有就是 null。 */
  updater: GithubReleaseInfo | null;
  /** 最近的更新公告，按发布时间倒序。旧版磁盘缓存里可能没有这个字段。 */
  announcements?: GithubReleaseInfo[];
  error: string | null;
  /** true 表示这是磁盘上的旧结果，本次没有真的连上 GitHub。 */
  stale?: boolean;
}

/** clear-cached-codex-packages.ps1 的结果，见 parse.cjs 的 parseClearedPackages。 */
export interface ClearedPackageList {
  /** 与 CachedPackageList 同理，可能为 null。 */
  downloadDirectory: string | null;
  clearedCount: number;
  clearedBytes: number;
  /**
   * 没能删掉的（多半是被杀毒软件或一个正在跑的安装进程占着）。非空时界面要如实说出来，
   * 而不是只报「已清空」—— 否则用户会以为空间已经回来了。
   */
  failedPaths: string[];
}

/** 用户在原生确认框里点了「取消」。取消是正常选择，不是失败。 */
export interface ClearCancelled {
  cancelled: true;
}

export type ClearCacheResult = ClearedPackageList | ClearCancelled;

export function isClearCancelled(result: ClearCacheResult): result is ClearCancelled {
  return (result as ClearCancelled).cancelled === true;
}

export type DownloadResult =
  | { status: "latest"; installedVersion?: string | null; version?: string | null }
  | { status: "downloaded"; path: string; version: string | null; fileName: string | null };

export interface InstallResult {
  ok: boolean;
  /**
   * 已安装但主窗口没出现 —— 这是**事实**，不含原因。
   * 原因看 startupDiagnosis：它可能说「还在落缓存」、可能说「就是那个搬迁 bug」，
   * 也可能说「判不出来」。
   */
  windowMissing: boolean;
  /**
   * 三档判定之一。用 `?` 是因为这个字段是后加的：主进程回退桩与老结果里没有它，
   * 界面必须容忍 undefined（按「判不出来」处理）。
   */
  startupDiagnosis?: StartupDiagnosis;
  remedy: string | null;
  healthSnapshot: Array<{ name: string; state: string }>;
  logPath: string;
  version: string | null;
  health: HealthReport | null;
}

/**
 * 窗口探针没等到主窗口时的判定。
 *
 *   still-preparing  还在把运行时物化到本地缓存（等一会儿就好，别修）
 *   relocation-bug   官方的加密资源搬迁 bug（这才该修）
 *   unknown          现有证据判不出原因（只说事实，不指控）
 */
export type StartupDiagnosis = "still-preparing" | "relocation-bug" | "unknown" | null;

/**
 * 「打开 Codex」的结果。
 *
 * 带上 windowVisible 而不是只回一个 ok：启动请求发出去不等于窗口会出现，而这个
 * 区别正是用户唯一能看见的东西（没窗口 = 屏幕上什么都没有）。顺带把探测时的健康
 * 报告一起带回来，界面可以直接刷新，不必让用户再点一次「健康自检」。
 */
export interface LaunchResult {
  ok: boolean;
  windowVisible: boolean;
  version: string | null;
  appUserModelId: string | null;
  /** 窗口没出现时脚本给出的原始说明（脚本 stdout 里的诊断句）。 */
  probeMessage: string | null;
  /** 原因判定，见 StartupDiagnosis。 */
  startupDiagnosis: StartupDiagnosis;
  health: HealthReport | null;
}

export interface Settings {
  downloadDirectory?: string;
  /**
   * 关窗时留在托盘里继续跑（后台常驻）。默认关 —— 用户没要求过的常驻进程不该自己出现。
   *
   * 三个后台相关的键都可选：老版本 settings.json 里没有它们，读出来是 undefined，
   * 界面按「关」处理。
   */
  minimizeToTray?: boolean;
  /**
   * 开机自动启动（带 --hidden，只常驻托盘、不弹窗）。默认关。
   *
   * 打开后**不会自动安装任何东西**：它只是让更新器自己起来查一次，发现新版本弹一条
   * 系统通知，装不装仍然由人点。
   */
  launchAtLogin?: boolean;
  /**
   * 上一次已经弹过通知的版本号。由主进程写入，防止同一个版本每次开机都提醒一遍。
   * 界面只读，不显示。
   */
  lastNotifiedVersion?: string;
  /**
   * 是否在界面上显示「版本历史」卡片。默认**显示**（字段缺失时按 true 处理）。
   *
   * 只是隐藏卡片，不动磁盘上的任何东西：缓存里的安装包照旧留着，失败告警里的回退入口
   * 也照旧在。要真的腾空间得点「清空缓存」，那是另一个动作。
   */
  showVersionHistory?: boolean;
  /**
   * 用户手动关掉的公告 id（Release tag）。只影响公告时间线，不影响安装与检查更新。
   */
  dismissedTips?: string[];
  /**
   * 主题：跟随系统 / 浅色 / 深色。主进程负责应用（nativeTheme.themeSource），
   * 渲染层只负责发值 —— CSS 的 prefers-color-scheme 会自动跟上。
   */
  theme?: ThemePreference;
  /** 启动时自动检查更新。默认开（字段缺失按 true 处理）。 */
  autoCheck?: boolean;
  /** 自动检查发现新版本后自动下载安装包。默认关。 */
  autoDownload?: boolean;
  /** 发现新版本时弹 Windows 系统通知。默认开。 */
  notifyUpdates?: boolean;
  /** 后台常驻时的复查间隔（小时）：1 / 3 / 6 / 12 / 24。默认 6。 */
  checkIntervalHours?: number;
  /**
   * 自动剪枝保留的安装包份数。0 表示不自动清理（桌面端默认）。
   * 固定（pin）的包不计入删除，永远保留。
   */
  cacheKeepCount?: number;
  defaultDownloadDirectory: string;
  logsDirectory: string;
}

export type ThemePreference = "system" | "light" | "dark";

/**
 * 「关于 → 检查更新」的状态机。
 *
 * idle → checking → ready（有新版）→ downloading → ready（已下载）→ installing
 * 任何一步失败都进 error，可重试。`ready` 同时表示「检查完且已是最新」和「安装包已下载」，
 * 靠 `path` 区分：path 为空 = 没有可装的新版本。
 */
export type AppUpdatePhase = "idle" | "checking" | "downloading" | "ready" | "installing" | "error";

export interface AppUpdateState {
  phase: AppUpdatePhase;
  /** 检查到的新版本号；没有新版本时为 null。 */
  version: string | null;
  received: number;
  total: number;
  /** 已下载并校验通过的安装包路径。 */
  path: string | null;
  error: string | null;
  /** 上一次检查完成的时刻；从未检查过是 null。 */
  checkedAt: number | null;
  /** 本次下载开始的时刻（毫秒），用来算速度与剩余时间。没在下载时为 null。 */
  startedAt: number | null;
}

/** 网络诊断里的一条探测结果。 */
export interface NetworkProbeResult {
  id: string;
  label: string;
  url: string;
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
}

/** check_network 的返回。proxy 是 Chromium 实际采用的代理规则（DIRECT / PROXY ...）。 */
export interface NetworkReport {
  checkedAt: number;
  proxy: string;
  results: NetworkProbeResult[];
}

/** 逐个删除缓存安装包的结果。用户在原生确认框里点「取消」时返回 cancelled。 */
export interface DeleteCachedPackageResult {
  cancelled?: true;
  deleted?: true;
  path?: string;
}

/** 固定 / 取消固定一个缓存安装包的结果。 */
export interface PinnedPackageResult {
  pinned: boolean;
  pinnedPaths: string[];
}

/** 主进程通过 desktop:progress 推送的实时事件。 */
export type ProgressEvent =
  | { kind: "phase"; id: ActivityId; phase: string; label: string; percent: number; warning?: boolean }
  | { kind: "download-bytes"; bytes: number; elapsedMs: number }
  | { kind: "log"; line: string; at?: string | null }
  | { kind: "warning"; message: string };

export type ActivityId = "download" | "install" | "repair" | "launch";

/** 单个长任务在界面上的呈现状态。 */
export interface Activity {
  id: ActivityId;
  label: string;
  percent: number;
  /** 百分比不可知时为 true，界面显示不确定进度条而不是编造数字。 */
  indeterminate: boolean;
  /** 仅下载阶段使用。 */
  bytes?: number;
  elapsedMs?: number;
  logs: Array<{ line: string; at?: string | null }>;
  warning?: string;
}

/** 单页流程的顶层状态。 */
export type Phase = "checking" | "ready" | "working" | "done" | "failed";
