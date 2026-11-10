import type {
  AppMigrationCapability,
  CacheMigrationPlan,
  CacheMigrationProgress,
  CacheScanStatus,
  CachedPackageList,
  Settings,
  StorageInfo,
} from "../types";
import { formatBytes, formatClock } from "../lib/format";
import { Icon } from "./Icons";
import { CacheSettings } from "./CacheSettings";
import { AdvancedSettings } from "./AdvancedSettings";

/**
 * 设置 → 存储。
 *
 * 三类数据分开说明，不混成一个「全部迁走」的承诺：
 *   - 安装包缓存：本应用自己管理，可以换目录，也可以把已有文件迁移到新目录；
 *   - Codex 应用本体：由 Windows 包部署服务管理，先检测条件，再按 AppxVolume 迁移；
 *   - 用户数据（配置 / 会话 / 日志 / 项目）：仍由 Codex 自己管理，本期不提供迁移。
 *
 * 顶部先给真实磁盘数字（主进程 fs.statfs 读取），别让用户靠猜。
 */
export function StorageSettings({
  settings,
  cachedPackages,
  cacheStatus,
  cacheError,
  cacheRefreshedAt,
  cacheDirectory,
  storage,
  storageLoading,
  busy,
  clearingCache,
  migrationPlan,
  migrationRunning,
  migrationProgress,
  capability,
  capabilityLoading,
  capabilityCheckedAt,
  appMigrating,
  installLocation,
  onRefreshCache,
  onRefreshStorage,
  onPick,
  onResetDirectory,
  onOpen,
  onToggleVersionHistory,
  onKeepCountChange,
  onClearCache,
  onDismissMigration,
  onApplyMigration,
  onCancelMigration,
  onDetectApp,
  onMoveApp,
  onOpenInstallLocation,
  onOpenStorageSettings,
  onCopyDiagnostics,
}: {
  settings: Settings | null;
  cachedPackages: CachedPackageList | null;
  cacheStatus: CacheScanStatus;
  cacheError: string | null;
  cacheRefreshedAt: number | null;
  cacheDirectory: string;
  storage: StorageInfo | null;
  storageLoading: boolean;
  busy: boolean;
  clearingCache: boolean;
  migrationPlan: CacheMigrationPlan | null;
  migrationRunning: boolean;
  migrationProgress: CacheMigrationProgress | null;
  capability: AppMigrationCapability | null;
  capabilityLoading: boolean;
  capabilityCheckedAt: number | null;
  appMigrating: boolean;
  installLocation: string | null;
  onRefreshCache: () => void;
  onRefreshStorage: () => void;
  onPick: () => void;
  onResetDirectory: () => void;
  onOpen: (path: string) => void;
  onToggleVersionHistory: (next: boolean) => void;
  onKeepCountChange: (count: number) => void;
  onClearCache: () => void;
  onDismissMigration: () => void;
  onApplyMigration: (carryOver: boolean) => void;
  onCancelMigration: () => void;
  onDetectApp: () => void;
  onMoveApp: (volume: string) => void;
  onOpenInstallLocation: () => void;
  onOpenStorageSettings: () => void;
  onCopyDiagnostics: () => void;
}) {
  if (!settings) return null;
  const refreshedClock = formatClock(cacheRefreshedAt);

  return (
    <>
      <section className="card storage-summary" aria-label="磁盘空间">
        <div className="storage-locations">
          <div className="storage-location">
            <span className="stat-ico">
              <Icon name="hdd" size={15} />
            </span>
            <div>
              <span className="k">缓存所在磁盘</span>
              <strong className="v">{cacheDirectory}</strong>
              <span className="sub">
                {storage?.download
                  ? `剩余 ${formatBytes(storage.download.freeBytes)} / 共 ${formatBytes(storage.download.totalBytes)}`
                  : storageLoading
                    ? "正在读取磁盘空间…"
                    : "空间信息读取失败"}
              </span>
            </div>
          </div>
          <div className="storage-location">
            <span className="stat-ico">
              <Icon name="box" size={15} />
            </span>
            <div>
              <span className="k">Codex 安装卷</span>
              <strong className="v">{installLocation ?? "尚未安装"}</strong>
              <span className="sub">
                {storage?.install
                  ? `剩余 ${formatBytes(storage.install.freeBytes)} / 共 ${formatBytes(storage.install.totalBytes)}`
                  : installLocation
                    ? "空间信息读取失败"
                    : "安装后显示"}
              </span>
            </div>
          </div>
        </div>
        <div className="card-foot">
          <span className="hint">
            {refreshedClock ? `缓存清单最近同步 ${refreshedClock}` : "缓存清单尚未同步"}
          </span>
          <button type="button" className="link" onClick={onRefreshStorage} disabled={storageLoading}>
            <Icon name="refresh" size={12} />
            {storageLoading ? "刷新中…" : "刷新空间信息"}
          </button>
        </div>
      </section>

      <CacheSettings
        settings={settings}
        cachedPackages={cachedPackages}
        cacheStatus={cacheStatus}
        cacheError={cacheError}
        cacheRefreshedAt={cacheRefreshedAt}
        cacheDirectory={cacheDirectory}
        storage={storage}
        busy={busy}
        clearingCache={clearingCache}
        migrationPlan={migrationPlan}
        migrationRunning={migrationRunning}
        migrationProgress={migrationProgress}
        onRefresh={onRefreshCache}
        onPick={onPick}
        onResetDirectory={onResetDirectory}
        onOpen={onOpen}
        onToggleVersionHistory={onToggleVersionHistory}
        onKeepCountChange={onKeepCountChange}
        onClearCache={onClearCache}
        onDismissMigration={onDismissMigration}
        onApply={onApplyMigration}
        onCancelMigration={onCancelMigration}
      />

      <AdvancedSettings
        settings={settings}
        installLocation={installLocation}
        cacheDirectory={cacheDirectory}
        storage={storage}
        busy={busy}
        capability={capability}
        capabilityLoading={capabilityLoading}
        capabilityCheckedAt={capabilityCheckedAt}
        appMigrating={appMigrating}
        onDetect={onDetectApp}
        onMove={onMoveApp}
        onOpen={onOpen}
        onOpenInstallLocation={onOpenInstallLocation}
        onOpenStorageSettings={onOpenStorageSettings}
        onCopyDiagnostics={onCopyDiagnostics}
      />

      {/* 和其他设置块用同一套 set-block 内边距：card-head 没有下内边距，说明文字会贴着卡片底边。 */}
      <section className="card mt14">
        <div className="set-block">
          <div className="line">
            <strong>用户数据</strong>
            <span className="aside">不随应用迁移</span>
          </div>
          <p className="field-help">
            配置、会话、日志与项目目录由 Codex 自己管理，迁移应用或缓存都不会动它们。
          </p>
        </div>
      </section>
    </>
  );
}
