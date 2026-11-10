import type { CachedPackageList, Settings } from "../types";
import { formatBytes } from "../lib/format";
import { Icon } from "./Icons";

/**
 * 安装包缓存：目录、当前占用、清空，以及「版本历史」卡片的显示开关。
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
 *
 * 缓存目录放在这张卡片而不是「高级设置」里：它是这张卡片的前提（占用算的就是这个目录），
 * 而且「装的东西占了我多少地方、能不能换到别的盘」比「Codex 本体装哪儿」更常被问到。
 *
 * 版本历史的显示开关也在这里：它和缓存是同一件事的两面（那张卡片展示的就是缓存里的包），
 * 放在一起用户才知道「关掉的是显示，不是清理」。
 */
export function CacheSettings({
  settings,
  cachedPackages,
  cacheDirectory,
  busy,
  clearingCache,
  onPick,
  onResetDirectory,
  onOpen,
  onToggleVersionHistory,
  onKeepCountChange,
  onClearCache,
}: {
  settings: Settings | null;
  cachedPackages: CachedPackageList | null;
  /**
   * 「打开缓存目录」要打开的真实路径，由 App 按 effectiveDownloadDirectory 算好传进来。
   *
   * 刻意不在这里自己读 settings.defaultDownloadDirectory：用户自定义缓存目录之后，
   * 输入框显示的是新目录、旁边的链接却打开旧的默认目录 —— 同一张卡片上两个控件对同一件
   * 事给出两种答案。判据只留在 store 那一处。
   */
  cacheDirectory: string;
  /** 「有命令在跑」。清空与换目录都置灰，避免和下载/安装抢同一个目录。 */
  busy: boolean;
  clearingCache: boolean;
  onPick: () => void;
  onResetDirectory: () => void;
  onOpen: (path: string) => void;
  onToggleVersionHistory: (next: boolean) => void;
  onKeepCountChange: (count: number) => void;
  onClearCache: () => void;
}) {
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

  // 清单读不到（枚举脚本失败、或刚启动还没拉回来）时不能报「0 个 · 0 MB」——
  // 那句话的意思是「缓存是空的」，而事实只是「这次没读到」。用户会照着它判断
  // 空间已经回来了，然后发现没有。
  const usageText = cachedPackages
    ? `${packages.length} 个 · ${formatBytes(totalBytes)}`
    : "占用未知";

  // 默认显示：字段缺失（老配置文件）时按显示处理，`!== false` 正是这个意思。
  const showVersionHistory = settings.showVersionHistory !== false;

  return (
    <details className="panel settings-card card" open>
      <summary>安装包缓存 · {usageText}</summary>
      <div className="settings-body">
        <div className="set-block">
          <div className="line">
            <strong>缓存目录</strong>
            <span className="aside">{usageText}</span>
          </div>
          <p>下载的安装包放在这里，可以换到别的盘。这是本应用唯一能替你选的目录。</p>
          <div className="path-row">
            <input
              id="download-directory"
              className="field-input input"
              readOnly
              value={custom || settings.defaultDownloadDirectory}
              title={custom || settings.defaultDownloadDirectory}
            />
            <button type="button" className="button" onClick={onPick}>
              浏览…
            </button>
            {custom && (
              <button type="button" className="button" onClick={onResetDirectory}>
                恢复默认
              </button>
            )}
          </div>
          <p className="field-help">
            默认在当前用户的 AppData 下（也就是 C 盘），装过几次更新之后会占掉几个 GB。
          </p>
          <div className="settings-links">
            <button type="button" className="link-button" onClick={() => onOpen(cacheDirectory)}>
              <Icon name="folder" size={13} />
              打开缓存目录
            </button>
          </div>
        </div>

        <div className="set-row">
          <div className="label">
            <strong>清空缓存</strong>
            <p className="field-help">
              删掉缓存里的全部 Codex 安装包。<strong>已安装的 Codex 不受影响</strong>，但删掉之后
              无法再回退到旧版本，需要时得重新下载（每个约 800 MB）。
            </p>
          </div>
          {/* 清空是不可撤销的，所以措辞写清后果、并且不置灰到看不见 —— 它必须一直在，
              用户才敢放心地让缓存涨上去。忙的时候置灰：正跑着的下载或安装就站在这个目录里。 */}
          <button
            type="button"
            className="link-button danger"
            disabled={busy}
            onClick={onClearCache}
          >
            {clearingCache ? "正在清空…" : `清空缓存（${usageText}）`}
          </button>
        </div>

        <div className="set-row">
          <div className="label">
            <strong>自动保留份数</strong>
            <p>
              装完更新后按版本倒序保留最近的几个安装包。选「不自动清理」就一个都不删，
              磁盘占用完全由你自己回收。
              {pinnedCount > 0
                ? `已固定 ${pinnedCount} 个：固定的包不计数，也不会被自动删掉。`
                : "在「版本历史」里可以固定某个包，固定后不会被自动清理。"}
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
            <strong>显示「版本历史」卡片</strong>
            <p>
              只是一个显示开关：关掉之后缓存里的安装包照旧留着，更新失败时告警里的回退入口
              也照旧在。要真的腾空间请用上面的「清空缓存」。
            </p>
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
