import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Logo } from "./Icons";

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
 * 窗口控制：macOS 那三颗红绿灯。
 *
 * 看到的是 12px 的圆点，真正可点的区域是 32×28 —— 圆点本身在触摸板/小屏上太小，
 * 只画一个小圆点会得到一个「看得见、点不中」的按钮。图标只在悬停时浮现，
 * 与 mac 的行为一致，同时让第一次用的人悬停就知道哪个是关闭。
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
    <div className="window-controls traffic" aria-label="窗口控制">
      <button
        type="button"
        className="window-control red"
        aria-label="关闭窗口"
        title="关闭窗口"
        onClick={() => void controls?.close()}
      >
        <span className="tl-dot" aria-hidden="true" />
        <span className="tl-glyph" aria-hidden="true">
          <CloseIcon />
        </span>
      </button>
      <button
        type="button"
        className="window-control yellow"
        aria-label="最小化"
        title="最小化"
        onClick={() => void controls?.minimize()}
      >
        <span className="tl-dot" aria-hidden="true" />
        <span className="tl-glyph" aria-hidden="true">
          <MinimizeIcon />
        </span>
      </button>
      <button
        type="button"
        className="window-control green"
        aria-label={maximized ? "向下还原" : "最大化"}
        title={maximized ? "向下还原" : "最大化"}
        onClick={() => void controls?.maximize()}
      >
        <span className="tl-dot" aria-hidden="true" />
        <span className="tl-glyph" aria-hidden="true">
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </span>
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
 * 整个窗口只有这一条可拖动；红绿灯在左（mac 的位置），状态胶囊在右。状态胶囊由 App
 * 传进来 —— 「已安装 X · 已是最新」与启动自动检查的结论同源，判据只有 store 里那一份。
 */
export function TitleBar({
  onAction,
  busy = false,
  statusSlot,
}: {
  onAction: (action: string) => void;
  busy?: boolean;
  statusSlot?: ReactNode;
}) {
  const dragHandlers = useWindowDrag();
  // onAction 与 busy 曾经服务于顶栏的下拉菜单；现在命令入口都在页面里，但主进程
  // 的原生菜单（Ctrl+R / Ctrl+I）仍然会通过 App 的 runAction 进来。保留参数是为了
  // 让这层壳继续是「唯一标题栏」这件事不变形，同时以后加窗口级菜单时不必改签名。
  void onAction;
  void busy;

  return (
    <header className="topbar" {...dragHandlers}>
      <WindowControls />
      <div className="titlebar-title">
        <Logo size={16} className="tb-logo" />
        <span>Codex Updater</span>
      </div>
      <div className="titlebar-right">{statusSlot}</div>
    </header>
  );
}
