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
