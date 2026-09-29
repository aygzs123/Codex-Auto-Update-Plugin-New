import type { HealthReport } from "../types";
import { healthComponentText, healthStateText } from "../lib/format";

const OVERALL_TEXT: Record<string, string> = {
  ok: "资源完整",
  degraded: "部分资源缺失",
  "not-installed": "未安装",
  unknown: "无法判定",
};

/**
 * 健康诊断。
 *
 * 数据全部来自 check-codex-desktop-health.ps1 的真实输出（五个资源副本目录 +
 * 插件物化状态），不是静态文案。窗口探测会真正启动 Codex 并等主窗口出现，是唯一
 * 能直接复现「进程在跑但没有窗口」那个官方 bug 的手段。
 */
export function HealthPanel({
  health,
  probing,
  repairing,
  busy,
  onProbe,
  onRepair,
}: {
  health: HealthReport | null;
  probing: boolean;
  repairing: boolean;
  /** 「有命令在跑」（含安装、检查更新）。置灰用共享判据，不只是本地这两个标志位。 */
  busy: boolean;
  onProbe: () => void;
  onRepair: () => void;
}) {
  const probeFailed = health?.probeResult === "window-not-visible";

  return (
    <section className="panel health-card">
      <div className="health-head">
        <div>
          <p className="mini-label">Diagnostics</p>
          <h3>健康诊断</h3>
          <p className="tab-detail">
            检查 Codex 启动所需的五个资源副本是否完整。窗口自检会真正启动 Codex 并等待主窗口出现，
            用来复现「进程在运行但窗口不出现」的问题。
          </p>
        </div>
        <span className={`verdict ${health?.overall ?? "unknown"}`}>
          {health ? OVERALL_TEXT[health.overall] ?? health.overall : "尚未自检"}
        </span>
      </div>

      {health?.installed && health.components.length > 0 && (
        <div className="health-grid">
          {health.components.map((component) => (
            <div className={`health-row ${component.state}`} key={component.name}>
              <span className="health-dot" />
              <div className="health-labels">
                <strong>{healthComponentText(component.name)}</strong>
                <small title={component.path}>{component.path || "—"}</small>
              </div>
              <span className="health-state">
                {healthStateText(component.state)}
                {component.leftovers > 0 && <em> · 残留 {component.leftovers}</em>}
              </span>
            </div>
          ))}
        </div>
      )}

      {!health?.installed && health && <p className="field-help">尚未检测到已安装的 Codex Desktop，安装后再运行自检。</p>}

      {/* 只在已安装时才提插件物化：新机器上压根没有插件可物化，这条提示纯属噪音。 */}
      {health?.installed && health.pluginsMaterialized === false && (
        <p className="field-help">
          插件资源尚未物化（bundled plugins stale）。这是 Codex 首次启动时自行处理的，不影响安装，
          也不在资源修复的范围内。
        </p>
      )}

      {health?.probeResult && (
        // 用 soft 而不是硬错误样式：窗口没出现是被诊断出来的已知故障，界面同时给出了
        // 修复入口，它不是「这个应用坏了」。硬错误色留给真正的意外失败 ——
        // 渲染冒烟测试也正是用 .error-text:not(.soft) 判定「界面是否显示了错误」。
        <p className={probeFailed ? "error-text soft" : "field-help"}>
          {probeFailed
            ? "窗口自检：Codex 进程已启动，但等待期内没有出现主窗口。这正是官方加密资源搬迁 bug 的特征，可以用下面的修复重建资源副本。"
            : "窗口自检：主窗口已正常出现。"}
        </p>
      )}

      {health?.probeMessage && probeFailed && <pre className="raw-output">{health.probeMessage}</pre>}

      <div className="dash-actions">
        <button type="button" className="button" disabled={busy} onClick={onProbe}>
          {probing ? "自检中…" : "运行健康自检"}
        </button>
        <button type="button" className="button" disabled={busy} onClick={onRepair}>
          {repairing ? "修复中…" : "修复资源副本"}
        </button>
      </div>
    </section>
  );
}
