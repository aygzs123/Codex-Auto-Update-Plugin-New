import { useEffect, useRef, useState } from "react";
import type {
  CacheMigrationPlan,
  CacheMigrationProgress,
  CacheScanStatus,
  CachedPackageList,
  Settings,
  StorageInfo,
} from "../types";
import { formatBytes, formatClock } from "../lib/format";
import { Icon } from "./Icons";

/**
 * 安装包缓存：目录、占用、空间、清理与迁移。
 *
 * 这张卡片是「缓存不再自动清理」这个决定配套出来的。以前的策略是装完之后自动剪到最近
 * 2 个，用户什么都不用管、也不用看 —— 代价是磁盘上发生了什么他也不知道。现在改成不自动
 * 清理，那两件事就必须由界面补上，否则等于把问题从「被悄悄删掉」换成「被悄悄占满」：
 *
 *   1. **占用写在卡片标题上**（`安装包缓存 · 3 个 · 2.34 GB`）。折叠着也看得见，不用
 *      展开、更不用去资源管理器里算 —— 这是「C 盘容易被占满」这个担心最直接的答案。
 *   2. **一个写明后果的清空入口**。它是用户唯一的回收手段，所以不能藏在「打开缓存目录、
 *      自己去挑着删」后面（那正是版本历史卡片刻意不做删除按钮的原因：逐行删除太容易误点）。
 *      清空走主进程的原生确认框，默认按钮是「取消」。
 *   3. **换目录是一步到位的**。缓存直接放在所选文件夹里；旧安装包是可选项，
 *      不搬就只切设置，搬就一次做完
 *      「复制 → 校验 → 切换 → 清理」。失败或取消时源目录与设置都不动。
 *
 * 读取失败时不再显示上一轮的文件列表：那份列表可能已经指向不存在的文件。摘要改成
 * 「无法读取」，列表与回退按钮交给版本与缓存页统一处理。
 */
export function CacheSettings({
  settings,
  cachedPackages,
  cacheStatus,
  cacheError,
  cacheRefreshedAt,
  cacheDirectory,
  storage,
  busy,
  clearingCache,
  migrationPlan,
  migrationRunning,
  migrationProgress,
  onRefresh,
  onPick,
  onResetDirectory,
  onOpen,
  onToggleVersionHistory,
  onKeepCountChange,
  onClearCache,
  onDismissMigration,
  onApply,
  onCancelMigration,
}: {
  settings: Settings | null;
  cachedPackages: CachedPackageList | null;
  cacheStatus: CacheScanStatus;
  cacheError: string | null;
  cacheRefreshedAt: number | null;
  /**
   * 「打开缓存目录」要打开的真实路径，由 App 按 effectiveDownloadDirectory 算好传进来。
   *
   * 刻意不在这里自己读 settings.defaultDownloadDirectory：用户自定义缓存目录之后，
   * 输入框显示的是新目录、旁边的链接却打开旧的默认目录 —— 同一张卡片上两个控件对同一件
   * 事给出两种答案。判据只留在 store 那一处。
   */
  cacheDirectory: string;
  storage: StorageInfo | null;
  /** 「有命令在跑」。清空、换目录与迁移都置灰，避免和下载/安装抢同一个目录。 */
  busy: boolean;
  clearingCache: boolean;
  migrationPlan: CacheMigrationPlan | null;
  migrationRunning: boolean;
  migrationProgress: CacheMigrationProgress | null;
  onRefresh: () => void;
  onPick: () => void;
  onResetDirectory: () => void;
  onOpen: (path: string) => void;
  onToggleVersionHistory: (next: boolean) => void;
  onKeepCountChange: (count: number) => void;
  onClearCache: () => void;
  onDismissMigration: () => void;
  /** 确认块里的「继续」：勾选要搬旧安装包就走迁移，不勾只切换目录。 */
  onApply: (carryOver: boolean) => void;
  onCancelMigration: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  // 旧安装包默认一起搬：用户既然换了目录，多半也想让它们跟过去。
  const [carryOver, setCarryOver] = useState(true);

  // 确认块一出现，焦点落在「取消」上：迁移会搬动几 GB 文件，回车键不该直接开始。
  // 每次新的预检结果都把勾选拨回默认值，避免上一轮的选择莫名延续。
  useEffect(() => {
    if (!migrationPlan) return;
    setCarryOver(migrationPlan.files.length > 0);
    cancelRef.current?.focus();
  }, [migrationPlan]);

  if (!settings) return null;
  const custom = (settings.downloadDirectory ?? "").trim();
  const packages = cachedPackages?.packages ?? [];
  const totalBytes = packages.reduce((sum, pkg) => sum + (pkg.sizeBytes || 0), 0);
  // 0 是「不自动清理」（桌面端的默认），缺失字段也按 0 处理。
  const keepCount = Number(settings.cacheKeepCount) > 0 ? Math.min(10, Math.round(Number(settings.cacheKeepCount))) : 0;
  const pinnedCount = packages.filter((pkg) => pkg.pinned).length;
  const keepChoices = [0, 2, 3, 5, 10].includes(keepCount)
    ? [0, 2, 3, 5, 10]
    : [0, 2, 3, 5, 10, keepCount].sort((left, right) => left - right);

  // 三种「没有数字」必须分开说：正在扫、读失败、确实为空。
  const usageText =
    cacheStatus === "error"
      ? "无法读取缓存目录"
      : cachedPackages
        ? `${packages.length} 个 · ${formatBytes(totalBytes)}`
        : cacheStatus === "scanning"
          ? "正在扫描…"
          : "占用未知";
  const canClear = Boolean(cachedPackages?.packages.length) && !busy && !clearingCache && cacheStatus !== "error";
  const refreshedClock = formatClock(cacheRefreshedAt);

  // 默认显示：字段缺失（老配置文件）时按显示处理，`!== false` 正是这个意思。
  const showVersionHistory = settings.showVersionHistory !== false;

  return (
    <details className="panel settings-card card storage-card" open>
      <summary>安装包缓存 · {usageText}</summary>
      <div className="settings-body">
        {cacheStatus === "error" && (
          <div className="inline-alert" role="alert">
            <div>
              <strong>无法读取缓存目录</strong>
              <p className="field-help">{cacheError || "缓存目录不可访问。"}</p>
            </div>
            <button type="button" className="button" onClick={onRefresh}>
              <Icon name="refresh" size={13} />
              重试
            </button>
          </div>
        )}

        <div className="set-block">
          <div className="line">
            <strong>缓存目录</strong>
            <span className="aside">{usageText}</span>
          </div>
          <p>
            可选择任意盘符下的文件夹，安装包直接保存到所选位置。
          </p>
          <div className="path-row">
            <input
              id="download-directory"
              className="field-input input"
              readOnly
              value={custom || settings.defaultDownloadDirectory}
              title={custom || settings.defaultDownloadDirectory}
            />
            <button
              type="button"
              className="button"
              disabled={busy || migrationRunning}
              title={
                busy || migrationRunning
                  ? "有命令正在执行，等它结束再换目录"
                  : "选择安装包保存位置，不会自动添加子目录"
              }
              onClick={onPick}
            >
              更改位置…
            </button>
            {custom && (
              <button
                type="button"
                className="button"
                disabled={busy || migrationRunning}
                onClick={onResetDirectory}
              >
                恢复默认
              </button>
            )}
          </div>
          <p className="field-help">
            建议选择空间充足的磁盘和专用文件夹。
            {storage?.download
              ? ` 当前磁盘剩余 ${formatBytes(storage.download.freeBytes)} / ${formatBytes(storage.download.totalBytes)}。`
              : ""}
          </p>
          <div className="settings-links">
            <button type="button" className="link-button" onClick={() => onOpen(cacheDirectory)}>
              <Icon name="folder" size={13} />
              打开缓存目录
            </button>
            <button type="button" className="link-button" onClick={onRefresh} disabled={cacheStatus === "scanning"}>
              <Icon name="refresh" size={13} />
              {cacheStatus === "scanning" ? "正在刷新…" : "重新扫描"}
            </button>
            {refreshedClock && <span className="hint">最近同步 {refreshedClock}</span>}
          </div>
        </div>

        {migrationRunning && (
          <div className="migration-progress" role="status" aria-live="polite">
            <div className="line">
              <strong>正在迁移缓存…</strong>
              <span className="aside">
                {migrationProgress
                  ? `${migrationProgress.copiedFiles} / ${migrationProgress.totalFiles} 个 · ${formatBytes(
                      migrationProgress.copiedBytes,
                    )} / ${formatBytes(migrationProgress.totalBytes)}`
                  : "正在准备…"}
              </span>
            </div>
            <div
              className={`progress-track ${
                migrationProgress && migrationProgress.totalBytes > 0 ? "" : "indeterminate"
              }`}
              role="progressbar"
              aria-valuenow={
                migrationProgress && migrationProgress.totalBytes > 0
                  ? Math.round((migrationProgress.copiedBytes / migrationProgress.totalBytes) * 100)
                  : undefined
              }
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span
                className="progress-fill"
                style={
                  migrationProgress && migrationProgress.totalBytes > 0
                    ? {
                        width: `${Math.min(
                          100,
                          Math.round((migrationProgress.copiedBytes / migrationProgress.totalBytes) * 100),
                        )}%`,
                      }
                    : undefined
                }
              />
            </div>
            <p className="field-help">
              {migrationProgress?.currentFile ? `正在处理：${migrationProgress.currentFile}` : "正在校验目标目录…"}
              完成后会自动切换到新目录。
            </p>
            <button type="button" className="button" onClick={onCancelMigration}>
              取消迁移
            </button>
          </div>
        )}

        {migrationPlan && !migrationRunning && (
          <div className="confirm-block" role="group" aria-label="确认迁移缓存">
            <strong>缓存目录改为 {migrationPlan.targetDirectory}</strong>
            <div className="confirm-grid">
              <span>当前目录</span>
              <code>{migrationPlan.sourceDirectory}</code>
              <span>现有安装包</span>
              <strong>
                {migrationPlan.files.length} 个 · {formatBytes(migrationPlan.totalBytes)}
              </strong>
              <span>目标可用空间</span>
              <strong>{formatBytes(migrationPlan.freeBytes)}</strong>
            </div>
            {migrationPlan.conflicts.length > 0 && carryOver && (
              <p className="field-help">
                目标目录已有 {migrationPlan.conflicts.length} 个同名文件：内容相同则跳过，
                不同则中止，不会覆盖。
              </p>
            )}
            {carryOver && migrationPlan.totalBytes > migrationPlan.freeBytes && (
              <p className="error-text">目标磁盘空间不足，请换一个目录，或者不搬现有安装包。</p>
            )}
            {migrationPlan.files.length > 0 && (
              <label className="confirm-check">
                <input
                  type="checkbox"
                  checked={carryOver}
                  onChange={(event) => setCarryOver(event.target.checked)}
                />
                <span>
                  同时把现有的 {migrationPlan.files.length} 个安装包（{formatBytes(migrationPlan.totalBytes)}）
                  搬到新目录；不勾选则只切换目录。
                </span>
              </label>
            )}
            <p className="field-help">
              {migrationPlan.files.length === 0
                ? "当前没有安装包，确认后新下载将保存到此位置。"
                : "复制并校验通过后才切换目录；仅切换时，旧安装包保留在原处。"}
            </p>
            <div className="dash-actions">
              <button ref={cancelRef} type="button" className="button" onClick={onDismissMigration}>
                取消
              </button>
              <button type="button" className="button" onClick={onPick} disabled={busy}>
                重新选择文件夹…
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy || (carryOver && migrationPlan.totalBytes > migrationPlan.freeBytes)}
                onClick={() => onApply(carryOver)}
              >
                {carryOver ? "迁移并切换" : "只切换目录"}
              </button>
            </div>
          </div>
        )}

        <div className="set-row">
          <div className="label">
            <strong>清空缓存</strong>
            <p className="field-help">
              删掉全部安装包。已安装的 Codex 不受影响，但删掉后无法回退旧版本，
              需要时得重新下载（每个约 800 MB）。
            </p>
          </div>
          <button type="button" className="link-button danger" disabled={!canClear} onClick={onClearCache}>
            {clearingCache ? "正在清空…" : `清空缓存（${usageText}）`}
          </button>
        </div>

        <div className="set-row">
          <div className="label">
            <strong>自动保留份数</strong>
            <p>
              装完更新后按版本倒序保留最近几个。选「不自动清理」就一个都不删。
              {pinnedCount > 0
                ? ` 已固定 ${pinnedCount} 个，不参与自动清理。`
                : " 固定的包不参与自动清理。"}
            </p>
          </div>
          <select
            className="field-select"
            value={keepCount}
            disabled={busy}
            onChange={(event) => onKeepCountChange(Number(event.target.value))}
            aria-label="自动保留份数"
          >
            {keepChoices.map((count) => (
              <option key={count} value={count}>
                {count === 0 ? "不自动清理" : `保留 ${count} 个`}
              </option>
            ))}
          </select>
        </div>

        <div className="set-row">
          <div className="label">
            <strong>显示「版本历史」列表</strong>
            <p>只影响列表显示，安装包照旧保留；要腾空间请用「清空缓存」。</p>
          </div>
          <label className="switch-control">
            <input
              type="checkbox"
              className="sr-only"
              checked={showVersionHistory}
              onChange={(event) => onToggleVersionHistory(event.target.checked)}
            />
            <span className="switch" role="switch" aria-checked={showVersionHistory} />
          </label>
        </div>
      </div>
    </details>
  );
}
