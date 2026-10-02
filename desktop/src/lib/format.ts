/** 把字节数格式化成 MB/GB，用于下载进度。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / 1024 / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** 把毫秒格式化成「1 分 20 秒」。 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`;
}

/**
 * 时间戳 → 「14:32」。
 *
 * 「上次检查」只说当天就够了，写完整日期反而占地方。传 null / undefined / 非法值时返回空串，
 * 调用处据此决定要不要渲染那个节点（渲染成 "Invalid Date" 是最糟的结果）。
 */
export function formatClock(at: number | null | undefined): string {
  if (!at) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 时间戳 → 「2026-10-02 14:32:05」，用于复制出去的诊断信息（那里需要完整时刻）。 */
export function formatStamp(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "未知";
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

const STATE_TEXT: Record<string, string> = {
  ok: "正常",
  missing: "缺失",
  partial: "不完整",
  error: "异常",
  unknown: "未知",
};

export function healthStateText(state: string): string {
  return STATE_TEXT[state] ?? state;
}

const COMPONENT_TEXT: Record<string, string> = {
  "win-cli": "Windows 命令行工具",
  "win-rg": "Windows 搜索工具 (rg)",
  "wsl-cli": "WSL 命令行工具",
  "wsl-rg": "WSL 搜索工具 (rg)",
  cua_node: "Node 运行时",
};

export function healthComponentText(name: string): string {
  return COMPONENT_TEXT[name] ?? name;
}

/**
 * 整机健康结论（ok / degraded / not-installed）→ 一句人话。
 *
 * degraded 只陈述「有的资源副本不在」，不说后果：组件状态预测不了窗口能不能开，两个方向
 * 都不行（2026-09-07 的真实搬迁 bug 里 win-cli 反倒是 ok 的，而 2026-10-02 一台完全正常的
 * 机器上 wsl-cli 就是 missing）。写成「可能无法正常启动」就是那次误诊的轻症版。
 * 能不能开以窗口自检为准。
 *
 * 放在这里而不是 App.tsx：主区那段说明和「复制诊断信息」要写的是同一件事，两处各写一份
 * 迟早会漂移成两种说法。
 */
const OVERALL_TEXT: Record<string, string> = {
  ok: "启动所需资源完整",
  degraded: "部分资源副本不在（是否影响启动以窗口自检为准）",
  "not-installed": "尚未安装",
};

/** 认不出的取值返回 null —— 调用处据此回落到自己的兜底文案，而不是显示一个空字符串。 */
export function healthOverallText(overall: string | null | undefined): string | null {
  return OVERALL_TEXT[overall ?? ""] ?? null;
}
