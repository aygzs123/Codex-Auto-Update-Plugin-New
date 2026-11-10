import { Icon } from "./Icons";

export type ViewId = "overview" | "diagnostics" | "history" | "settings";

const NAV: Array<{ id: ViewId; label: string; icon: "grid" | "activity" | "clock" | "settings" }> = [
  { id: "overview", label: "概览", icon: "grid" },
  { id: "diagnostics", label: "诊断", icon: "activity" },
  { id: "history", label: "版本历史", icon: "clock" },
  { id: "settings", label: "设置", icon: "settings" },
];

/**
 * 左侧导航。
 *
 * 这四页替代了原来「一页堆到底 + 顶栏两个下拉菜单」的结构：菜单项要展开才看得见，
 * 而「系统通知 → 打开应用」这类动作恰恰需要一眼就能找到。导航常驻，当前页高亮。
 *
 * 「版本历史」可以被设置里的开关整张关掉 —— 那时导航项也一起收起，否则点进去
 * 只有一个「已隐藏」的空页。缓存里的安装包与失败告警里的回退入口都不受影响。
 */
export function Sidebar({
  view,
  onNavigate,
  showVersionHistory,
  cacheCount,
  statusLabel,
  statusTone,
}: {
  view: ViewId;
  onNavigate: (view: ViewId) => void;
  showVersionHistory: boolean;
  cacheCount: number;
  /** 底部那一行状态，由 App 按同一套健康判据算好传进来。 */
  statusLabel: string;
  statusTone: "green" | "orange" | "gray";
}) {
  return (
    <aside className="sidebar" aria-label="主导航">
      {/* 这里不再放产品名：顶栏的品牌位已经换成三颗圆点，侧栏再重复一遍就多了一块
          和「工作台」导航抢视线的标题。产品名留在关于页与窗口标题里。 */}
      <nav className="nav">
        <span className="nav-label">工作台</span>
        {NAV.map((item) => {
          const hidden = item.id === "history" && !showVersionHistory;
          if (hidden) return null;
          return (
            <button
              type="button"
              key={item.id}
              data-nav={item.id}
              className={`nav-item ${view === item.id ? "active" : ""}`}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => onNavigate(item.id)}
            >
              <Icon name={item.icon} size={16} />
              <span>{item.label}</span>
              {item.id === "history" && cacheCount > 0 && <span className="nav-badge">{cacheCount}</span>}
            </button>
          );
        })}
      </nav>

      <div className="sb-foot">
        <div className="sb-foot-row">
          <span className="dot" style={{ background: toneColor(statusTone), boxShadow: `0 0 0 3px ${toneSoft(statusTone)}` }} />
          <strong>{statusLabel}</strong>
          <span className="ver">v{__APP_VERSION__}</span>
        </div>
        <div className="sb-foot-sub">安装包来自 Microsoft Store</div>
      </div>
    </aside>
  );
}

function toneColor(tone: "green" | "orange" | "gray") {
  if (tone === "green") return "var(--green)";
  if (tone === "orange") return "var(--orange)";
  return "var(--text-4)";
}

function toneSoft(tone: "green" | "orange" | "gray") {
  if (tone === "green") return "var(--green-soft)";
  if (tone === "orange") return "var(--orange-soft)";
  return "var(--tile)";
}
