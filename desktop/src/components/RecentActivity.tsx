import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../state/app";
import { formatClock } from "../lib/format";
import type { ViewId } from "./Sidebar";

type Tone = "green" | "orange" | "gray" | "accent";

interface Entry {
  key: string;
  tone: Tone;
  title: string;
  detail: string;
  time: string | null;
}

/**
 * 「最近活动」。
 *
 * store 里没有一张通用的事件表 —— 加一张会侵入所有命令的写入路径，而那些路径被
 * 一组按源码文本切片的测试钉着。这里改成**从已有结果派生**：update / installResult /
 * launchResult / healthDetail 本身就是每条命令留下的结论，活动列表要做的只是把它们
 * 按「最后一次看到变化」的时间排出来。
 *
 * 时间用本地观察到的时刻，不是伪造的时间戳：界面启动时已经存在的结论标成「启动时」，
 * 启动之后才出现的变化才记当前时钟。拿一条查不到来源的时间糊上去，比不写更糟。
 */
export function RecentActivity({ onNavigate }: { onNavigate: (view: ViewId) => void }) {
  const { status, update, lastCheckAt, installResult, launchResult, healthDetail } = useAppStore();
  const installClock = useSeenClock(installResult);
  const launchClock = useSeenClock(launchResult);
  const healthClock = useSeenClock(healthDetail);

  const entries: Entry[] = [];
  const lastCheckClock = formatClock(lastCheckAt);

  if (update && status?.installed) {
    const upToDate = update.updateAvailable === false;
    entries.push({
      key: "update",
      tone: upToDate ? "green" : "accent",
      title: upToDate ? "已是最新版本" : `发现新版本 ${update.availableVersion ?? ""}`.trim(),
      detail: `当前已安装 ${status.version ?? "未知版本"}`,
      time: lastCheckClock,
    });
  }

  if (installResult) {
    entries.push({
      key: "install",
      tone: installResult.ok ? (installResult.windowMissing ? "orange" : "green") : "orange",
      title: installResult.ok
        ? `安装完成${installResult.version ? ` · ${installResult.version}` : ""}`
        : "安装未完成",
      detail: installResult.ok
        ? installResult.windowMissing
          ? "已安装，但主窗口没有出现"
          : "Codex 已安装并启动"
        : "查看诊断里的原始输出",
      time: installClock,
    });
  }

  if (launchResult) {
    entries.push({
      key: "launch",
      tone: launchResult.windowVisible ? "green" : "orange",
      title: launchResult.windowVisible ? "Codex 已启动" : "Codex 窗口没有出现",
      detail: launchResult.version ? `版本 ${launchResult.version}` : "启动请求已发出",
      time: launchClock,
    });
  }

  if (healthDetail) {
    const ok = healthDetail.components.filter((component) => component.state === "ok").length;
    entries.push({
      key: "health",
      tone: healthDetail.overall === "ok" ? "green" : healthDetail.overall === "degraded" ? "orange" : "gray",
      title: "健康自检完成",
      detail: `资源副本 ${ok} / ${healthDetail.components.length} 完整`,
      time: healthClock,
    });
  }

  return (
    <section className="card">
      <div className="card-head">
        <h3>最近活动</h3>
        <button type="button" className="link" onClick={() => onNavigate("diagnostics")}>
          诊断
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="timeline-empty">还没有记录。检查更新或安装一次后，这里会列出结果。</p>
      ) : (
        <ul className="timeline">
          {entries.map((entry) => (
            <li className="tl-item" data-tone={entry.tone} key={entry.key}>
              <span className="tl-dot" aria-hidden="true" />
              <div className="tl-body">
                <strong>{entry.title}</strong>
                <span>{entry.detail}</span>
              </div>
              <time>{entry.time ?? "启动时"}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 某个结果第一次出现时记下钟点；启动时就已经在的值不编造时间。 */
function useSeenClock(value: unknown): string | null {
  const [clock, setClock] = useState<string | null>(null);
  const seen = useRef<unknown>(undefined);
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      seen.current = value;
      return;
    }
    if (value && value !== seen.current) {
      seen.current = value;
      setClock(formatClock(Date.now()));
    }
  }, [value]);

  return clock;
}
