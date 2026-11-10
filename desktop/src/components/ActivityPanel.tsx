import { useEffect, useRef } from "react";
import type { Activity } from "../types";
import { formatBytes, formatDuration, formatSpeed } from "../lib/format";

/**
 * 长任务的进度与真实日志。
 *
 * 下载阶段显示不确定进度条 + 已下载字节数：脚本用的 curl -sS / Invoke-WebRequest
 * 都不输出百分比，总字节数也无从得知，所以这里不编造百分比。
 */
export function ActivityPanel({ activity }: { activity: Activity }) {
  const logRef = useRef<HTMLDivElement>(null);
  const lineCount = activity.logs.length;

  useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lineCount]);

  return (
    <section className="panel activity-card">
      <div className="progress-line">
        <span>{activity.label}</span>
        <strong>{activity.indeterminate ? "进行中" : `${activity.percent}%`}</strong>
      </div>
      <div className={`progress-track ${activity.indeterminate ? "indeterminate" : ""}`}>
        <div
          className="progress-fill"
          style={activity.indeterminate ? undefined : { width: `${activity.percent}%` }}
        />
      </div>

      {activity.id === "download" && typeof activity.bytes === "number" && activity.bytes > 0 && (
        <div className="subline">
          <span>已下载 {formatBytes(activity.bytes)}</span>
          {(() => {
            // 平均速度（累计字节 / 累计用时）。脚本推的是累计值，这样算不会在日志稀疏时
            // 抖成 0；刚刚起步、用时还不够时不显示，而不是编一个数字。
            const speed = formatSpeed(activity.bytes, activity.elapsedMs ?? 0);
            return speed ? <span>速度 {speed}</span> : null;
          })()}
          {typeof activity.elapsedMs === "number" && <span>用时 {formatDuration(activity.elapsedMs)}</span>}
        </div>
      )}

      {activity.warning && <p className="error-text soft">{activity.warning}</p>}

      {lineCount > 0 && (
        <details className="log-details" open={activity.id === "install"}>
          <summary>安装日志（{lineCount} 行）</summary>
          <div className="log" ref={logRef}>
            {activity.logs.map((entry, index) => (
              <div key={`${index}-${entry.line}`}>
                {entry.at && <span className="log-time">{entry.at.slice(11)} </span>}
                {entry.line}
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
