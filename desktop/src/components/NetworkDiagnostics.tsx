import type { NetworkReport } from "../types";
import { formatClock } from "../lib/format";
import { Icon } from "./Icons";

/**
 * 网络与代理诊断。
 *
 * 只探三个地址（GitHub API、GitHub Release 下载、Microsoft 分发源），全部写死在主进程，
 * 渲染进程传不进 URL。它回答的是「这台机器上，应用要走的几条网络路径通不通」——
 * 浏览器能打开、应用里却连不上时，下面这行代理规则往往就是差别所在。
 */
export function NetworkDiagnostics({
  report,
  checking,
  onCheck,
}: {
  report: NetworkReport | null;
  checking: boolean;
  onCheck: () => void;
}) {
  const proxy = report?.proxy?.trim() ?? "";
  const proxyLabel = !proxy
    ? "未知"
    : /^DIRECT/i.test(proxy)
      ? "直连（DIRECT）"
      : proxy;

  return (
    <details className="panel settings-card card" open>
      <summary>网络诊断</summary>
      <div className="settings-body">
        <div className="set-block">
          <div className="line">
            <strong>连通性与代理</strong>
            {report && <span className="aside">上次诊断 {formatClock(report.checkedAt)}</span>}
          </div>
          <p>
            检查应用要走的几条网络路径，只探测、不改设置、不上传。
          </p>

          {proxy && (
            <p className="field-help">
              当前代理规则：<code>{proxyLabel}</code>
            </p>
          )}

          {report ? (
            <div className="net-list">
              {report.results.map((result) => (
                <div className="net-row" data-ok={result.ok} key={result.id}>
                  <span className="net-dot" aria-hidden="true" />
                  <div className="net-label">
                    <strong>{result.label}</strong>
                    <small title={result.url}>{result.url}</small>
                  </div>
                  <span className="net-state">
                    {result.ok ? "可达" : "失败"}
                    {result.latencyMs !== null ? ` · ${result.latencyMs} ms` : ""}
                    {result.status !== null ? ` · HTTP ${result.status}` : ""}
                  </span>
                  {!result.ok && result.error && (
                    <small className="net-error" title={result.error}>
                      {result.error}
                    </small>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="field-help">
              尚未诊断。点按钮探测三个地址，最多 8 秒。
            </p>
          )}

          <div className="settings-links">
            <button type="button" className="button" disabled={checking} onClick={onCheck}>
              <Icon name="refresh" size={14} />
              {checking ? "诊断中…" : report ? "重新诊断" : "开始诊断"}
            </button>
            {report && (
              <span className="hint">
                {report.results.every((result) => result.ok)
                  ? "三条路径都可达"
                  : `${report.results.filter((result) => !result.ok).length} 条路径不可达`}
              </span>
            )}
          </div>
        </div>
      </div>
    </details>
  );
}
