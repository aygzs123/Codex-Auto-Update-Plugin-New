import type { ProgressEvent } from "./types";

export {};

declare global {
  interface Window {
    desktop?: {
      invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
      onMenuAction(callback: (action: string) => void): () => void;
      onProgress(callback: (payload: ProgressEvent) => void): () => void;
      window: {
        minimize(): Promise<void>;
        maximize(): Promise<void>;
        close(): Promise<void>;
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
