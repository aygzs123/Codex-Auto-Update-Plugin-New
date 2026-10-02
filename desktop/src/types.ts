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
  defaultDownloadDirectory: string;
  logsDirectory: string;
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
