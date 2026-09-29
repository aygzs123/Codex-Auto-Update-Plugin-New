import type { CachedPackage, CachedPackageList } from "../types";
import { formatBytes } from "../lib/format";

const RELATION_TEXT: Record<string, string> = {
  installed: "当前已安装",
  older: "可回退",
  newer: "比当前新",
  unknown: "无法判定",
};

/**
 * 版本历史 / 回退。
 *
 * 存在的理由：更新只能向前是这套工具过去的硬伤 —— 更新完发现新版本有问题，用户手上
 * 没有任何退路（分发源只发最新版，删掉的安装包再也下不回来）。这里把保留下来的旧
 * 安装包列出来，给一个回退入口。
 *
 * 一个必须如实说出来的限制：回退只能依赖**本应用自己留下来的**安装包，而且必须是
 * 「已经带着保留策略更新过一次」之后。装上这个功能就想退到升级前那一版是做不到的
 * —— 那一次的安装包在旧策略下已经被删掉了。所以空列表时给的是解释，不是一个空盒子。
 *
 * 刻意不做「删除此回退包」：旧版安装包删掉就再也拿不回来，一颗误点的删除按钮足以让
 * 整个功能失效。占用由「最多保留 2 个」这条策略兜住，想手动清理走「打开缓存目录」。
 */
export function VersionHistory({
  cachedPackages,
  cacheDirectory,
  busy,
  rollingBack,
  onRollback,
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
  /** 「有命令在跑」。回退按钮置灰用共享判据，不只是本地的 rollingBack。 */
  busy: boolean;
  rollingBack: boolean;
  onRollback: (pkg: CachedPackage) => void;
  onOpenDirectory: (path: string) => void;
}) {
  const packages = cachedPackages?.packages ?? [];
  const installedVersion = cachedPackages?.installedVersion ?? null;

  return (
    <section className="panel rollback-card">
      <div className="health-head">
        <div>
          <p className="mini-label">Version History</p>
          <h3>版本历史</h3>
          <p className="tab-detail">
            更新时保留下来的最近安装包。新版本用起来有问题时，可以从这里退回上一版 ——
            回退会先关闭正在运行的 Codex，装完再自动启动。最多保留 2 个安装包，更旧的会被自动清理。
          </p>
        </div>
        {/* 刻意不用 .verdict：那是健康面板的结论徽章，而渲染冒烟测试按「文档里第一个
            .verdict」取健康结论 —— 这张卡片在健康面板之前，用同一个类会把那条断言带偏。 */}
        {installedVersion && <span className="rollback-current">当前 {installedVersion}</span>}
      </div>

      {packages.length === 0 ? (
        <p className="field-help">
          {installedVersion
            ? "缓存里还没有可回退的旧版本安装包。回退依赖本应用自己保留下来的安装包，而保留下来的前提是" +
              "「带着新版保留策略更新过一次」—— 之前更新时用过的安装包按旧策略已被清理，分发源也只提供最新版，" +
              "所以它们找不回来了。下次更新之后再回到这里，就会看到上一版。"
            : "尚未检测到已安装的 Codex Desktop。安装完成后，这里会列出保留下来的安装包。"}
        </p>
      ) : (
        <div className="health-grid">
          {packages.map((pkg) => {
            const relation = pkg.relation in RELATION_TEXT ? pkg.relation : "unknown";
            // 同版本重装同样有用（当前这一版装着不对劲时），所以 installed 也给按钮。
            const canInstall = relation === "installed" || relation === "older";
            return (
              <div className={`rollback-row ${relation}`} key={pkg.path}>
                <span className="health-dot" />
                <div className="health-labels">
                  <strong>{pkg.version}</strong>
                  <small title={pkg.path}>
                    {formatBytes(pkg.sizeBytes)} · {formatDate(pkg.modifiedAt)} · {pkg.architecture}
                  </small>
                </div>
                <span className="health-state">{RELATION_TEXT[relation]}</span>
                {canInstall && (
                  <button
                    type="button"
                    className="button rollback-action"
                    disabled={busy}
                    onClick={() => onRollback(pkg)}
                  >
                    {rollingBack ? "正在回退…" : relation === "installed" ? "重新安装" : "回退到此版本"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {cacheDirectory && (
        <div className="settings-links">
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
