// 「复制诊断信息」要复制的文本。
//
// 这个功能的全部意义是**让同事报障时不必截图**：他点一下，粘到聊天窗口里，我这边就能看到
// 版本、结论、资源副本、日志路径。所以文本必须能脱离界面单独读懂 —— 每一行都要带自己的
// 标签，不能出现「见上图」这种东西；也不能只有结论没有依据（写过「健康：异常」而不写是哪个
// 组件，等于什么都没说）。
//
// 只读、不联网、不涉及任何隐私内容：全是本机版本号与路径，没有用户名之外的任何东西
//（路径里带的用户名是按需的 —— 没有它，日志路径就没法定位）。

import type { CachedPackageList, HealthReport, Settings, UpdateReport } from "../types";
import { formatBytes, formatClock, formatStamp, healthComponentText, healthOverallText, healthStateText } from "./format";

export interface DiagnosticsInput {
  status: HealthReport | null;
  update: UpdateReport | null;
  /** 上次检查更新的时刻（毫秒时间戳），从没查过就是 null。 */
  lastCheckAt: number | null;
  cachedPackages: CachedPackageList | null;
  settings: Settings | null;
  /** 当前实际生效的缓存目录，由 effectiveDownloadDirectory 算好传进来。 */
  cacheDirectory: string;
  /** 最近一次安装留下的日志路径，没有安装过就是 null。 */
  installLogPath: string | null;
}

/**
 * 更新结论。三种状态分开说，尤其是「未检查」——
 * 写成「已是最新」会把「还没查过」伪装成一个好消息，正好是排查时最误导人的那种写法。
 */
function updateVerdict(update: UpdateReport | null): string {
  if (!update) return "未检查";
  if (update.updateAvailable === false) return `已是最新${update.installedVersion ? `（${update.installedVersion}）` : ""}`;
  if (update.updateAvailable === true) return `可更新到 ${update.availableVersion ?? "未知版本"}`;
  return "无法判定";
}

export function diagnosticsText(input: DiagnosticsInput): string {
  const { status, update, lastCheckAt, cachedPackages, settings, cacheDirectory, installLogPath } = input;
  const lines: string[] = ["Codex Updater 诊断信息", `生成时间：${formatStamp(Date.now())}`];

  lines.push(`已安装：${status?.installed ? `是（${status.version ?? "版本未知"}）` : "否"}`);
  if (status?.installLocation) lines.push(`安装位置：${status.installLocation}`);

  lines.push(`更新结论：${updateVerdict(update)}`);
  const clock = formatClock(lastCheckAt);
  if (clock) lines.push(`上次检查：${clock}`);

  // 整机结论与逐项状态都写：只说整机的 degraded，对方还得再问我一次是哪个组件。
  const overall = healthOverallText(status?.overall);
  lines.push(`健康结论：${status?.overall ?? "未知"}${overall ? `（${overall}）` : ""}`);
  for (const component of status?.components ?? []) {
    lines.push(`  · ${healthComponentText(component.name)}：${healthStateText(component.state)}`);
  }
  if (status?.probeResult) lines.push(`窗口探针：${status.probeResult}`);

  // 这三个都可能是「没测过」，如实写「未检测」而不是留空 —— 空行会被当成「没有这一项」。
  lines.push(`插件资源：${status?.pluginsMaterialized == null ? "未检测" : status.pluginsMaterialized ? "已物化" : "尚未物化"}`);
  if (status?.appUserModelId) lines.push(`AppUserModelId：${status.appUserModelId}`);

  lines.push(`缓存目录：${cacheDirectory || "未知"}`);
  // 个数和占用一起写：缓存不再自动清理之后，「同事说 C 盘满了」这条线索的第一站就是这里。
  // 只写个数没法判断严重程度（3 个包可能占了 2.4 GB），只写占用则看不出还有没有可退的版本。
  const cachedBytes = (cachedPackages?.packages ?? []).reduce((sum, pkg) => sum + (pkg.sizeBytes || 0), 0);
  lines.push(
    `缓存里的安装包：${
      cachedPackages ? `${cachedPackages.packages.length} 个，共 ${formatBytes(cachedBytes)}` : "未枚举"
    }`,
  );
  // 缓存保留策略也要写：看到这份文本的人得知道「不清理」是当前的设计，不是出了故障。
  lines.push("缓存保留策略：不自动清理（由用户在「安装包缓存」卡片里手动清空）");
  lines.push(`自定义缓存目录：${(settings?.downloadDirectory ?? "").trim() || "（未设置，用默认）"}`);
  lines.push(`最近一次安装日志：${installLogPath || "本次运行还没有安装记录"}`);

  return lines.join("\n");
}
