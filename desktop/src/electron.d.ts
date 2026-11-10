import type { ProgressEvent } from "./types";

export {};

declare global {
  /** 构建时由 vite.config.ts 从 package.json 注入，界面里的版本号只认这一处。 */
  const __APP_VERSION__: string;

  interface Window {
    desktop?: {
      invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
      onMenuAction(callback: (action: string) => void): () => void;
      onProgress(callback: (payload: ProgressEvent) => void): () => void;
      /** 更新器自身安装包的下载进度（独立于 Codex 安装链路）。 */
      onAppUpdateProgress(callback: (payload: { received: number; total: number }) => void): () => void;
      /** 后台模式下主进程每 6 小时敲一次，界面据此重跑一次静默检查。 */
      onBackgroundCheck(callback: () => void): () => void;
      /** 系统配色变化时主进程推来的解析结果（light / dark）。 */
      onThemeUpdated(callback: (payload: { resolved: "light" | "dark"; preference: string }) => void): () => void;
      /** 当前缓存目录的文件发生变化。界面收到后重新扫描，不自带数据。 */
      onCacheChanged(callback: () => void): () => void;
      /** 缓存迁移的复制进度。 */
      onCacheMigrationProgress(callback: (payload: import("./types").CacheMigrationProgress) => void): () => void;
      window: {
        minimize(): Promise<void>;
        maximize(): Promise<void>;
        close(): Promise<void>;
        /** 真正退出应用，而不是藏到托盘。 */
        quit(): Promise<void>;
        /** 最大化状态下要显示「还原」图标，所以需要读一次当前状态。 */
        isMaximized(): Promise<boolean>;
        onStateChange(callback: (state: { maximized: boolean }) => void): () => void;
      };
      drag: {
        start(screenX: number, screenY: number): void;
        move(screenX: number, screenY: number): void;
        end(): void;
      };
    };
  }
}
