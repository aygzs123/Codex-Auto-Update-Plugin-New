import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

// 用 SVG 而不是字体符号画图标：− □ × 这些字符的基线和对齐随字体变化，塞进小尺寸
// 里必然歪，而且「还原」态需要的双矩形根本没有对应字符。
function MinimizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1 5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="1.1" y="1.1" width="7.8" height="7.8" rx="1.4" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.6" y="2.9" width="6.5" height="6.5" rx="1.3" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path
        d="M3.1 2.6V2A1.4 1.4 0 0 1 4.5.6h4a1.4 1.4 0 0 1 1.4 1.4v4a1.4 1.4 0 0 1-1.4 1.4h-.6"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 左上角的三颗 mac 圆点。
 *
 * 纯装饰：真正的窗口操作在最右边那组按钮上。把它们做成按钮会和右侧重复，而且
 * 12px 的圆点本身也不是合格的点击目标（真正能点的区域在右侧 32×28 的按钮里）。
 * `aria-hidden` + 不参与 drag 排除，滚动/拖动标题栏时一切照旧。
 */
function TrafficLights() {
  return (
    <div className="traffic" aria-hidden="true">
      <span className="traffic-dot red" />
      <span className="traffic-dot yellow" />
      <span className="traffic-dot green" />
    </div>
  );
}

/**
 * 窗口控制：最小化 / 最大化（还原）/ 关闭。
 *
 * 固定在最右边，顺序按 Windows 的惯例（而不是 mac 的红黄绿）。按钮的可点区域是
 * 32×28 —— 只画一个 10px 的图标会得到一个「看得见、点不中」的按钮。
 *
 * 状态以主进程推送为准：双击标题栏最大化不会经过这里，本地猜测会停在错误图标上。
 */
function WindowControls() {
  const controls = typeof window !== "undefined" ? window.desktop?.window : undefined;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!controls) return;
    let active = true;
    void controls.isMaximized().then((value) => {
      if (active) setMaximized(Boolean(value));
    });
    const unsubscribe = controls.onStateChange((state) => setMaximized(Boolean(state?.maximized)));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [controls]);

  return (
    <div className="window-controls" aria-label="窗口控制">
      <button
        type="button"
        className="window-control minimize"
        aria-label="最小化"
        title="最小化"
        onClick={() => void controls?.minimize()}
      >
        <MinimizeIcon />
      </button>
      <button
        type="button"
        className="window-control maximize"
        aria-label={maximized ? "向下还原" : "最大化"}
        title={maximized ? "向下还原" : "最大化"}
        onClick={() => void controls?.maximize()}
      >
        {maximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button
        type="button"
        className="window-control close"
        aria-label="关闭窗口"
        title="关闭窗口"
        onClick={() => void controls?.close()}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function useWindowDrag() {
  const dragging = useRef(false);
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !window.desktop?.drag) return;
    const target = event.target as HTMLElement;
    if (target.closest("button,input,a,.window-controls,details,summary")) return;
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    window.desktop.drag.start(event.screenX, event.screenY);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragging.current) window.desktop?.drag.move(event.screenX, event.screenY);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    window.desktop?.drag.end();
  };
  const onDoubleClick = () => void window.desktop?.window.maximize();
  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick };
}

/**
 * 标题栏。
 *
 * 整个窗口只有这一条可拖动。左侧是三颗 mac 圆点（装饰），右侧是最小化 / 最大化 /
 * 关闭，中间留白用于拖动 —— 视觉上保留 mac 的辨识度，操作习惯仍按 Windows 走。
 */
export function TitleBar({ actions }: { actions?: ReactNode }) {
  const dragHandlers = useWindowDrag();

  return (
    <header className="topbar" {...dragHandlers}>
      <div className="topbar-left">
        <TrafficLights />
      </div>
      <div className="topbar-actions">
        {actions}
        <WindowControls />
      </div>
    </header>
  );
}
