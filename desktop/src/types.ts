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
  /** 是否值得给出「修复」入口。由主进程按 parse.cjs 的规则判定。 */
  needsRepair: boolean;
  raw: string;
}

export type SignatureStatus = "verified" | "warning";

export interface SignatureReport {
  status: SignatureStatus;
  publisher: string;
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
  /** 已安装但主窗口没出现 —— 官方加密资源搬迁 bug 的特征。 */
  windowMissing: boolean;
  remedy: string | null;
  healthSnapshot: Array<{ name: string; state: string }>;
  logPath: string;
  version: string | null;
  health: HealthReport | null;
}

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
  /** 窗口没出现时脚本给出的说明（官方 bug 的特征描述）。 */
  probeMessage: string | null;
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
