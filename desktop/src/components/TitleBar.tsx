import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

// command 标记这一项会真跑一条命令，因而「有命令在跑」时要置灰。
// 打开目录不带这个标记：它只弹一个资源管理器窗口，永远秒回，而且正是在安装/自检
// 跑着的时候最有用（用户想去看日志）。把它一起禁掉是帮倒忙。
const MENU_GROUPS = [
  {
    label: "操作",
    items: [
      { label: "检查更新", action: "check", command: true },
      { label: "一键安装 / 更新", action: "install", command: true },
      { label: "打开 Codex", action: "launch", command: true },
    ],
  },
  {
    label: "诊断",
    items: [
      { label: "健康自检（含窗口探测）", action: "health", command: true },
      { label: "修复资源副本", action: "repair", command: true },
      { label: "打开日志目录", action: "open-logs", command: false },
      { label: "打开缓存目录", action: "open-cache", command: false },
    ],
  },
] as const;

// 用 SVG 而不是字体符号画图标：− □ × 这些字符的基线和对齐随字体变化，塞进小尺寸
// 里必然歪，而且「还原」态需要的双矩形根本没有对应字符。
function MinimizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0 5h10" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.6" y="0.6" width="8.8" height="8.8" rx="1.4" stroke="currentColor" strokeWidth="1.2" fill="none" />
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
      <path d="M0.8 0.8l8.4 8.4M9.2 0.8L0.8 9.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

// 真正能关掉窗口的就是这三个，放在顶栏右上角。内容区卡片标题栏上那三个 mac 圆点
// 是纯装饰（见 styles.css 的 .window-head::before），不承担任何窗口操作 ——
// 卡片在滚动容器里，往下滚就跟着走了，靠它关窗口是关不掉的。
function WindowControls() {
  const controls = typeof window !== "undefined" ? window.desktop?.window : undefined;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!controls) return;
    let active = true;
    void controls.isMaximized().then((value) => {
      if (active) setMaximized(Boolean(value));
    });
    // 双击标题栏最大化也会走到这里，所以状态以主进程推送为准，不在本地猜测。
    const unsubscribe = controls.onStateChange((state) => setMaximized(Boolean(state?.maximized)));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [controls]);

  return (
    <div className="window-controls" aria-label="窗口控制">
      <button type="button" className="window-control" aria-label="最小化" title="最小化" onClick={() => void controls?.minimize()}>
        <MinimizeIcon />
      </button>
      <button
        type="button"
        className="window-control"
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
    if (target.closest("button,input,a,.app-menu,.top-actions,.window-controls,details,summary")) return;
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

export function TitleBar({ onAction, busy = false }: { onAction: (action: string) => void; busy?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const dragHandlers = useWindowDrag();

  return (
    <header className="topbar" {...dragHandlers}>
      {/* 顶栏只放品牌和菜单；窗口按钮在最右侧（WindowControls），
          mac 那三个圆点在内容区卡片里，是装饰。 */}
      <div className="brand">
        <span className="brand-mark">cx</span>
        <strong>Codex Updater</strong>
      </div>

      <nav className="app-menu" aria-label="应用菜单">
        {MENU_GROUPS.map((group) => (
          <div
            className="menu-group"
            key={group.label}
            onMouseEnter={() => setOpen(group.label)}
            onMouseLeave={() => setOpen((current) => (current === group.label ? null : current))}
          >
            <button
              type="button"
              className={`menu-trigger ${open === group.label ? "active" : ""}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setOpen(open === group.label ? null : group.label)}
            >
              {group.label}
            </button>
            {open === group.label && (
              <div className="menu-popover">
                {group.items.map((item) => {
                  // 有命令在跑时把命令项置灰，而不是「点了没反应」：菜单不关，
                  // 鼠标停在上面能看到 title 说明为什么点不动。
                  const disabled = busy && item.command;
                  return (
                    <button
                      type="button"
                      key={item.action}
                      disabled={disabled}
                      title={disabled ? "有命令正在执行，等它结束再操作" : undefined}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => {
                        setOpen(null);
                        onAction(item.action);
                      }}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </nav>

      <div className="top-actions">
        <span>Windows · x64</span>
      </div>
      <WindowControls />
    </header>
  );
}
