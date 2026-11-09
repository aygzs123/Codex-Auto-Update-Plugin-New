import type { HealthReport } from "../types";
import { healthComponentText, healthStateText } from "../lib/format";
import { diagnosisCopy } from "../lib/diagnosis";
import { Icon } from "./Icons";

const OVERALL_TEXT: Record<string, string> = {
  ok: "资源完整",
  degraded: "部分资源缺失",
  "not-installed": "未安装",
  unknown: "无法判定",
};

const RING_RADIUS = 23;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * 健康诊断。
 *
 * 数据全部来自 check-codex-desktop-health.ps1 的真实输出（五个资源副本目录 +
 * 插件物化状态），不是静态文案。窗口探测会真正启动 Codex 并等主窗口出现，是唯一
 * 能直接复现「进程在跑但没有窗口」那个官方 bug 的手段。
 *
 * 视觉上从一个环形开始：用户最先要知道的是「几项里几项好」，然后才是逐项细节。
 * 圆环中间那 4/5 不是装饰，它是这张页面唯一一个能一眼读出的结论。
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
  // 没等到窗口时说什么、要不要提修复，全部走唯一映射表 —— 这里不再自己下结论。
  const diagnosis = diagnosisCopy(health?.startupDiagnosis);

  const components = health?.components ?? [];
  const okCount = components.filter((component) => component.state === "ok").length;
  const total = components.length;
  const ratio = total > 0 ? okCount / total : 0;
  const overall = health?.overall ?? "unknown";

  return (
    <section className="health-card">
      <div className="verdict-card card">
        <div className={`ring ${overall}`} data-state={overall} aria-hidden="true">
          <svg width="58" height="58" viewBox="0 0 58 58">
            <circle className="track" cx="29" cy="29" r={RING_RADIUS} />
            <circle
              className="value"
              cx="29"
              cy="29"
              r={RING_RADIUS}
              strokeDasharray={`${(ratio * RING_CIRCUMFERENCE).toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`}
            />
          </svg>
          <span className="ring-label">
            {total > 0 ? `${okCount}/${total}` : "—"}
          </span>
        </div>
        <div className="verdict-copy">
          <span className={`verdict ${overall}`}>
            {health ? OVERALL_TEXT[health.overall] ?? health.overall : "尚未自检"}
          </span>
          <p>
            {health
              ? health.installed
                ? "启动所需资源副本的完整性。窗口自检会真正启动 Codex 并等待主窗口出现。"
                : "尚未检测到已安装的 Codex Desktop，安装后再运行自检。"
              : "运行一次健康自检，读取本机五个资源副本的状态。"}
          </p>
        </div>
        <div className="verdict-aside">
          {health?.installed ? (
            <>
              窗口自检
              <br />
              {health.probeResult === "window-visible"
                ? "主窗口正常"
                : health.probeResult === "window-not-visible"
                  ? "未出现窗口"
                  : "未运行"}
            </>
          ) : null}
        </div>
      </div>

      {health?.installed && components.length > 0 && (
        <>
          <div className="section-head">
            <h3>
              资源副本<span className="sub">{okCount} / {total} 完整</span>
            </h3>
            <span className="sub">只读本机</span>
          </div>
          <div className="comp-list card">
            {components.map((component) => (
              <div className={`comp health-row ${component.state}`} data-state={component.state} key={component.name}>
                <span className="health-dot" />
                <div className="health-labels">
                  <strong>{healthComponentText(component.name)}</strong>
                  <small title={component.path}>{component.path || "—"}</small>
                </div>
                <span className="path">{component.path || "—"}</span>
                <span className="health-state">
                  {healthStateText(component.state)}
                  {component.leftovers > 0 && <em> · 残留 {component.leftovers}</em>}
                </span>
              </div>
            ))}
          </div>
        </>
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
        // 用 soft 而不是硬错误样式：窗口没出现是被诊断出来的结果，界面同时给出了结论与
        // 下一步，它不是「这个应用坏了」。硬错误色留给真正的意外失败 ——
        // 渲染冒烟测试也正是用 .error-text:not(.soft) 判定「界面是否显示了错误」。
        <p className={probeFailed ? "error-text soft" : "field-help"}>
          {probeFailed
            ? `窗口自检：Codex 进程已启动，但等待期内没有出现主窗口。${diagnosis.title}。${diagnosis.body}`
            : "窗口自检：主窗口已正常出现。"}
        </p>
      )}

      {health?.probeMessage && probeFailed && <pre className="raw-output">{health.probeMessage}</pre>}

      <div className="dash-actions actions-row">
        <button
          type="button"
          className="button"
          disabled={busy}
          title={busy ? "有命令正在执行，等它结束再操作" : undefined}
          onClick={onProbe}
        >
          <Icon name="activity" size={14} />
          {probing ? "自检中…" : "运行健康自检"}
        </button>
        {/* 这颗按钮常驻，不跟着判定走：它是个「我想重建就重建」的手动入口，不是结论。
            结论里的修复建议只出现在判定确实指向搬迁 bug 的地方（横幅），免得拿不出证据
            就把人推去修。修复脚本本身幂等，健康时只会打印 SKIP。 */}
        <button
          type="button"
          className="button"
          disabled={busy}
          title={busy ? "有命令正在执行，等它结束再操作" : undefined}
          onClick={onRepair}
        >
          <Icon name="refresh" size={14} />
          {repairing ? "修复中…" : "修复资源副本"}
        </button>
      </div>
      <p className="hint mt10">
        修复会先关闭 Codex；只写用户目录，不碰 WindowsApps。资源健康时只打印 SKIP。
      </p>
    </section>
  );
}
