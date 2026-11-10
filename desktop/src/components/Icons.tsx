import type { ReactNode } from "react";

/**
 * 界面里统一用的一小组线性图标。
 *
 * 全部手写在同一个 24×24 视口里、同样的 stroke-width，是为了让侧栏、统计条、
 * 空状态里的图标重量一致 —— 混用图标库最容易在这里露馅：同一个 16px 尺寸下，
 * 有的描边 1.2、有的 2，并排看就像两套设计。
 *
 * 刻意不用字体符号：− □ × 这类字符的基线随字体变化，塞进小尺寸里必然歪。
 */
const ICONS: Record<string, ReactNode> = {
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
    </>
  ),
  activity: <path d="M3 12h4l2.6-7 4.8 14 2.4-7H21" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.4v5l3.2 1.9" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.7 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.7a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.1 4.7a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.3 9c.2.62.78 1.03 1.43 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.97Z" />
    </>
  ),
  check: <path d="m5 12.5 4.2 4.2L19 7" />,
  alert: (
    <>
      <path d="M12 3.6 21 19.2H3L12 3.6Z" />
      <path d="M12 9.4v4.3M12 16.6h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.2M12 7.8h.01" />
    </>
  ),
  download: (
    <>
      <path d="M12 3.5v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M4.5 19.5h15" />
    </>
  ),
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />,
  trash: (
    <>
      <path d="M4.5 6.5h15" />
      <path d="M9 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v1.5" />
      <path d="M6.5 6.5l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12" />
      <path d="M10.2 10.5v6M13.8 10.5v6" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 5.5A2 2 0 0 0 13.5 3.5h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 5.5v5h-5" />
      <path d="M19.4 10.5a7.6 7.6 0 1 0-.6 5.3" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.2 19 6v5.3c0 4.2-2.8 7.4-7 9.5-4.2-2.1-7-5.3-7-9.5V6l7-2.8Z" />
      <path d="m9 12 2.2 2.2L15.4 10" />
    </>
  ),
  chevron: <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  arrow: (
    <>
      <path d="M4.5 12h14" />
      <path d="m13.5 7 5 5-5 5" />
    </>
  ),
  box: (
    <>
      <path d="M3.8 8.2 12 4l8.2 4.2v7.6L12 20l-8.2-4.2V8.2Z" />
      <path d="M3.8 8.2 12 12.3l8.2-4.1M12 12.3V20" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4.5" width="18" height="12.5" rx="2" />
      <path d="M8.5 20.5h7M12 17v3.5" />
    </>
  ),
  hdd: (
    <>
      <rect x="3.2" y="5" width="17.6" height="14" rx="2.4" />
      <path d="M3.2 13.5h17.6M7 16.5h.01M10.5 16.5h.01" />
    </>
  ),
  cpu: (
    <>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
      <rect x="10" y="10" width="4" height="4" rx="1" />
      <path d="M9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5h3.5M3 14.5h3.5M17.5 9.5H21M17.5 14.5H21" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10" width="15" height="10.5" rx="2.2" />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
    </>
  ),
  power: (
    <>
      <path d="M12 3.5v8" />
      <path d="M7 6.6a7.5 7.5 0 1 0 10 0" />
    </>
  ),
  bell: (
    <>
      <path d="M6.2 10.2a5.8 5.8 0 0 1 11.6 0c0 4 1.4 5.6 1.4 5.6H4.8s1.4-1.6 1.4-5.6Z" />
      <path d="M10 19.2a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  logo: (
    <>
      <path d="m9.4 7.2-4.6 4.8 4.6 4.8" />
      <path d="m14.6 7.2 4.6 4.8-4.6 4.8" />
      <path d="m13.2 5.4-2.4 13.2" />
    </>
  ),
};

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {ICONS[name]}
    </svg>
  );
}

/** 应用标识：渐变方块 + 白色代码括号。所有出现 logo 的地方共用同一形状。 */
export function Logo({ size = 46, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`logo ${className}`.trim()} style={{ width: size, height: size }} aria-hidden="true">
      <svg
        width={Math.round(size * 0.56)}
        height={Math.round(size * 0.56)}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m9.4 7.2-4.6 4.8 4.6 4.8" />
        <path d="m14.6 7.2 4.6 4.8-4.6 4.8" />
        <path d="m13.2 5.4-2.4 13.2" />
      </svg>
    </span>
  );
}
