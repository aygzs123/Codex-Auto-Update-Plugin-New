import type { ProgressEvent } from "../types";

// 这个应用只在 Electron 里运行。刻意不提供浏览器 fallback：原型阶段每个命令都带一个
// 返回假数据的 fallback，结果是界面在没有真实功能的情况下看起来一切正常。宁可明确报错。

export function isElectronRuntime(): boolean {
  return typeof window !== "undefined" && typeof window.desktop?.invoke === "function";
}

export async function invokeCommand<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const desktop = typeof window !== "undefined" ? window.desktop : undefined;
  if (!desktop) throw new Error("此功能需要在桌面应用中运行");
  return desktop.invoke<T>(command, args);
}

export function subscribeProgress(callback: (event: ProgressEvent) => void): () => void {
  const desktop = typeof window !== "undefined" ? window.desktop : undefined;
  return desktop ? desktop.onProgress(callback) : () => {};
}

export function subscribeMenuAction(callback: (action: string) => void): () => void {
  const desktop = typeof window !== "undefined" ? window.desktop : undefined;
  return desktop ? desktop.onMenuAction(callback) : () => {};
}

/** 后台模式的定时复查。主进程只说「该查了」，查什么由 store 决定。 */
export function subscribeBackgroundCheck(callback: () => void): () => void {
  const desktop = typeof window !== "undefined" ? window.desktop : undefined;
  return desktop ? desktop.onBackgroundCheck(callback) : () => {};
}
