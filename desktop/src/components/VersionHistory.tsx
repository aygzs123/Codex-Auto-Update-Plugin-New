import { useState } from "react";
import type { CachedPackage, CachedPackageList, SignatureReport } from "../types";
import { invokeCommand } from "../lib/bridge";
import { formatBytes } from "../lib/format";
import { Icon } from "./Icons";

const RELATION_TEXT: Record<string, string> = {
  installed: "当前已安装",
  older: "可回退",
  newer: "比当前新",
  unknown: "无法判定",
};

type Verification =
  | { status: "checking" }
  | { status: SignatureReport["status"]; publisher: string; message: string };

/**
 * 版本历史 / 回退。
 *
 * 存在的理由：更新只能向前是这套工具过去的硬伤 —— 更新完发现新版本有问题，用户手上
 * 没有任何退路（分发源只发最新版，删掉的安装包再也下不回来）。这里把保留下来的旧
 * 安装包列出来，给一个回退入口。
 *
 * 每一行现在有四个动作，各自的边界写清楚：
 *   - **回退 / 重装**：走安装链路，先校验签名再装；
 *   - **校验签名**：只读不写，结果就地显示，不跳页；
 *   - **固定**：写进缓存目录的 .codex-pins.json，自动剪枝会跳过它（固定不等于备份）；
 *   - **删除**：不可撤销，所以主进程会先弹原生确认框，默认按钮是「取消」。
 *
 * 删除能做到逐行，是因为它有了两道防线（确认框 + 只接受当前缓存目录里的 Codex 包），
 * 不再是「一颗误点的按钮让整个回退功能失效」。
 */
export function VersionHistory({
  cachedPackages,
  cacheDirectory,
  keepCount,
  busy,
  rollingBack,
  onRollback,
  onDelete,
  onPin,
  onOpenDirectory,
}: {
  cachedPackages: CachedPackageList | null;
  /**
   * 缓存目录，由 App 按 effectiveDownloadDirectory 算好传进来 —— 与「高级设置」里那颗
   * 链接、以及 worker 剪枝用的是同一个值。
   *
   * 以前这里读 cachedPackages.downloadDirectory，值是对的，但枚举脚本一失败
   * （cachedPackages 为 null）整颗按钮就消失，连「去哪个目录看看」都做不到。
   */
  cacheDirectory: string;
  /** 自动剪枝保留份数（0 = 不自动清理）。只用于把实况写清楚，不影响这里的动作。 */
  keepCount: number;
  /** 「有命令在跑」。回退 / 删除 / 固定按钮置灰用共享判据，不只是本地的 rollingBack。 */
  busy: boolean;
  rollingBack: boolean;
  onRollback: (pkg: CachedPackage) => void;
  onDelete: (pkg: CachedPackage) => void;
  onPin: (pkg: CachedPackage, pinned: boolean) => void;
  onOpenDirectory: (path: string) => void;
}) {
  const packages = cachedPackages?.packages ?? [];
  const installedVersion = cachedPackages?.installedVersion ?? null;
  const totalBytes = packages.reduce((sum, pkg) => sum + (pkg.sizeBytes || 0), 0);
  const pinnedCount = packages.filter((pkg) => pkg.pinned).length;

  // 校验结果按路径存：一个包一个结果，互不覆盖，也不进全局 signature 状态
  // （那是安装/回退链路的结论，显示在概览页，跟这里点一下「校验签名」不是一回事）。
  const [verifications, setVerifications] = useState<Record<string, Verification>>({});

  const verify = async (pkg: CachedPackage) => {
    setVerifications((previous) => ({ ...previous, [pkg.path]: { status: "checking" } }));
    try {
      const report = await invokeCommand<SignatureReport>("verify_download_signature", { path: pkg.path });
      setVerifications((previous) => ({
        ...previous,
        [pkg.path]: { status: report.status, publisher: report.publisher, message: report.message },
      }));
    } catch (error) {
      setVerifications((previous) => ({
        ...previous,
        [pkg.path]: {
          status: "warning",
          publisher: "",
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  // 保留策略的实况要跟着设置走：以前那句「最多保留 2 个」是静态承诺，现在用户可以在
  // 「安装包缓存」里自己选，卡片上就必须写当前生效的那一档。
  const footprint =
    packages.length === 0
      ? keepCount > 0
        ? `装完更新后自动保留最近 ${keepCount} 个安装包。`
        : "安装包不会自动清理。"
      : keepCount > 0
        ? `自动保留最近 ${keepCount} 个（已固定 ${pinnedCount} 个，不计数也不会被删）：` +
          `当前 ${packages.length} 个，共 ${formatBytes(totalBytes)}。`
        : `安装包不再自动清理${pinnedCount > 0 ? `（已固定 ${pinnedCount} 个）` : ""}：` +
          `当前 ${packages.length} 个，共 ${formatBytes(totalBytes)}，` +
          "想腾空间可以在这里删除或去「安装包缓存」里清空。";

  return (
    <section className="panel rollback-card card">
      <div className="card-head">
        <div>
          <h3>版本历史</h3>
          <p className="tab-detail">
            更新时保留下来的安装包。新版本用起来有问题时，可以从这里退回上一版 ——
            回退会先关闭正在运行的 Codex，装完再自动启动。{footprint}
          </p>
        </div>
        {/* 刻意不用 .verdict：那是健康面板的结论徽章，而渲染冒烟测试按「文档里第一个
            .verdict」取健康结论 —— 这张卡片在健康面板之前，用同一个类会把那条断言带偏。 */}
        {installedVersion && <span className="rollback-current">当前 {installedVersion}</span>}
      </div>

      {packages.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">
            <Icon name="clock" size={22} />
          </span>
          <strong>还没有可回退的安装包</strong>
          <p className="field-help">
            {installedVersion
              ? "缓存里还没有可回退的旧版本安装包。回退依赖本应用自己保留下来的安装包，而保留下来的前提是" +
                "「带着新版保留策略更新过一次」—— 之前更新时用过的安装包按旧策略已被清理，分发源也只提供最新版，" +
                "所以它们找不回来了。下次更新之后再回到这里，就会看到上一版。"
              : "尚未检测到已安装的 Codex Desktop。安装完成后，这里会列出保留下来的安装包。"}
          </p>
        </div>
      ) : (
        <div className="vh-list">
          {packages.map((pkg) => {
            const relation = pkg.relation in RELATION_TEXT ? pkg.relation : "unknown";
            // 同版本重装同样有用（当前这一版装着不对劲时），所以 installed 也给按钮。
            const canInstall = relation === "installed" || relation === "older";
            const verification = verifications[pkg.path];
            return (
              <div className={`rollback-row ${relation}`} key={pkg.path}>
                <span className="health-dot" />
                <div className="health-labels">
                  <strong className="vh-version">
                    {pkg.version}
                    {pkg.pinned && (
                      <span className="pill compact" data-tone="accent">
                        已固定
                      </span>
                    )}
                  </strong>
                  <small title={pkg.path}>
                    {formatBytes(pkg.sizeBytes)} · {formatDate(pkg.modifiedAt)} · {pkg.architecture}
                  </small>
                  {verification && (
                    <small
                      className={`vh-signature ${verification.status === "checking" ? "" : verification.status}`}
                      title={verification.status === "checking" ? undefined : verification.message}
                    >
                      {verification.status === "checking"
                        ? "正在校验签名…"
                        : verification.status === "verified"
                          ? `签名通过 · ${verification.publisher}`
                          : `签名校验未通过 · ${verification.message}`}
                    </small>
                  )}
                </div>
                <span className="health-state">{RELATION_TEXT[relation]}</span>
                <div className="vh-actions">
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy || verification?.status === "checking"}
                    onClick={() => void verify(pkg)}
                  >
                    {verification?.status === "checking" ? "校验中…" : "校验签名"}
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy}
                    title={pkg.pinned ? "取消固定后，它会被自动剪枝算进保留份数" : "固定后不会被自动剪枝删掉"}
                    onClick={() => onPin(pkg, !pkg.pinned)}
                  >
                    {pkg.pinned ? "取消固定" : "固定"}
                  </button>
                  <button
                    type="button"
                    className="link-button danger"
                    disabled={busy}
                    title="删除不可撤销，会先弹一次确认"
                    onClick={() => onDelete(pkg)}
                  >
                    删除
                  </button>
                  {canInstall && (
                    <button
                      type="button"
                      className="button rollback-action"
                      disabled={busy}
                      title={busy ? "有命令正在执行，等它结束再操作" : undefined}
                      onClick={() => onRollback(pkg)}
                    >
                      {rollingBack ? "正在回退…" : relation === "installed" ? "重新安装" : "回退到此版本"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {cacheDirectory && (
        <div className="settings-links card-foot">
          <span className="hint">固定的包不会被自动清理；删除不可撤销，会先弹确认</span>
          <button type="button" className="link-button" onClick={() => onOpenDirectory(cacheDirectory)}>
            打开缓存目录
          </button>
        </div>
      )}
    </section>
  );
}

/** 脚本给的是 ISO 8601（UTC），这里按用户本地时间显示。解析不了就原样显示。 */
function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
