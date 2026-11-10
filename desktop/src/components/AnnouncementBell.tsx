import { useEffect, useRef, useState } from "react";
import type { GithubReleaseInfo } from "../types";
import { Icon } from "./Icons";

/** Release 正文是 Markdown，这里只取一小段纯文本，不整段铺进界面。 */
function excerpt(markdown: string, limit = 160): string {
  const text = String(markdown || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function formatDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/**
 * 顶栏的更新公告入口。
 *
 * 形式是一枚铃铛：有新的更新器版本时显示红点，点开是 Release 的时间线。
 * 公告不铺在概览页里 —— 那里要留给「要不要更新」的结论，公告是第二层信息。
 *
 * 时间线由两段拼成：打包进应用的 CHANGELOG 历史（本地优先）+ GitHub 上更新的 Release。
 * 正文以 CHANGELOG 为准 —— 历史 Release 用的是通用模板，读起来是几句一样的英文客套话。
 *
 * 关掉的公告按 tag 落盘（`dismissedTips`），只影响这条时间线。
 */
export function AnnouncementBell({
  announcements,
  hasUpdate,
  dismissedTips,
  onDismiss,
  onOpenRelease,
}: {
  announcements: GithubReleaseInfo[];
  hasUpdate: boolean;
  dismissedTips: string[];
  onDismiss: (id: string) => void;
  onOpenRelease: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const visible = announcements.filter((entry) => !dismissedTips.includes(entry.tag));
  // 红点只表示「有更新器新版本」。历史公告是时间线，不构成「有更新」。
  const showDot = hasUpdate && visible.length > 0;

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="bell" ref={rootRef}>
      <button
        type="button"
        className="bell-button"
        aria-label="更新公告"
        aria-expanded={open}
        title="更新公告"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="bell" size={16} />
        {showDot && <span className="bell-dot" aria-hidden="true" />}
      </button>

      {open && (
        <section className="bell-panel" aria-label="更新公告">
          <header className="bell-head">
            <div>
              <strong>更新公告</strong>
              <p>按发布时间倒序 · 来自 CHANGELOG 与 GitHub Release</p>
            </div>
            <button type="button" className="bell-close" aria-label="关闭公告" onClick={() => setOpen(false)}>
              <Icon name="close" size={14} />
            </button>
          </header>

          {visible.length === 0 ? (
            <p className="bell-empty">暂无更新公告。</p>
          ) : (
            <ol className="timeline">
              {visible.map((entry) => (
                <li className="timeline-item" key={entry.tag}>
                  <span className="timeline-dot" aria-hidden="true" />
                  <div className="timeline-body">
                    <div className="timeline-head">
                      <strong>v{entry.version}</strong>
                      {entry.version === __APP_VERSION__ && (
                        <span className="pill compact" data-tone="accent">
                          当前版本
                        </span>
                      )}
                      <time dateTime={entry.publishedAt ?? undefined}>{formatDate(entry.publishedAt)}</time>
                    </div>
                    {entry.body.trim() && <p>{excerpt(entry.body)}</p>}
                    <div className="timeline-actions">
                      {entry.url && (
                        <button type="button" className="link" onClick={() => onOpenRelease(entry.url)}>
                          查看 Release
                          <Icon name="chevron" size={11} />
                        </button>
                      )}
                      <button type="button" className="link subtle" onClick={() => onDismiss(entry.tag)}>
                        不再显示
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}
