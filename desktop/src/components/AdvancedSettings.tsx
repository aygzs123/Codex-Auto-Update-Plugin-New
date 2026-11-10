import { useEffect, useState } from "react";
import type { AppMigrationCapability, Settings, StorageInfo } from "../types";
import { formatBytes, formatClock } from "../lib/format";
import { Icon } from "./Icons";

/**
 * Codex 应用本体：装在哪、能不能迁移。
 *
 * 过去这里写死「由 Windows 决定，改不了」。这不准确：Windows 提供 `Move-AppxPackage`
 * 与 `Add-AppxPackage -Volume`，但能否迁移取决于包自身、目标 AppxVolume 与权限，
 * 不能仅凭命令存在就承诺一定成功。所以这块拆成两步：
 *   1. 「检测迁移条件」只读，报告包、版本、当前卷、可移动标记与候选卷；
 *   2. 用户选定卷、再确认之后才执行迁移；执行结果以部署服务回读的真实安装位置为准。
 *
 * 应用本体和用户数据是两件事。迁移包不会承诺把配置、日志、会话与项目目录一起搬走，
 * 这条说明必须留在按钮旁边，不能让用户产生错误预期。
 */
export function AdvancedSettings({
  settings,
  installLocation,
  cacheDirectory,
  storage,
  busy,
  capability,
  capabilityLoading,
  capabilityCheckedAt,
  appMigrating,
  onDetect,
  onMove,
  onOpen,
  onOpenInstallLocation,
  onOpenStorageSettings,
  onCopyDiagnostics,
}: {
  settings: Settings | null;
  installLocation: string | null;
  /**
   * 「打开缓存目录」要打开的真实路径，由 App 按 effectiveDownloadDirectory 算好传进来。
   *
   * 刻意不在这里自己读 settings：同一张卡片上两个控件对同一件事给出两种答案，
   * 判据只留在 store 那一处。
   */
  cacheDirectory: string;
  storage: StorageInfo | null;
  busy: boolean;
  capability: AppMigrationCapability | null;
  capabilityLoading: boolean;
  /** 上一次检测完成的时刻；空表示这台机器上还没点过检测。 */
  capabilityCheckedAt: number | null;
  appMigrating: boolean;
  onDetect: () => void;
  onMove: (volume: string) => void;
  onOpen: (path: string) => void;
  onOpenInstallLocation: () => void;
  onOpenStorageSettings: () => void;
  onCopyDiagnostics: () => void;
}) {
  // 目标卷不能是当前包所在的卷：那不是迁移，只会让用户以为点了没反应。
  const targets = (capability?.volumes ?? []).filter(
    (volume) => volume.path && volume.path !== capability?.packageVolume,
  );
  // 用路径串当依赖：capability 每次都是新对象，直接依赖它会让下面的对齐逻辑每次渲染都跑。
  const targetKey = targets.map((volume) => volume.path).join("|");

  // 受控选择：重新检测后候选卷可能变了，非受控的 defaultValue 只在挂载时生效，
  // 旧值会留下来 —— 界面显示第一项，实际提交的却是空字符串，点「迁移」毫无反应。
  const [targetVolume, setTargetVolume] = useState("");
  useEffect(() => {
    setTargetVolume((current) =>
      targets.some((volume) => volume.path === current) ? current : targets[0]?.path ?? "",
    );
  }, [targetKey]);

  if (!settings) return null;

  const checkedClock = formatClock(capabilityCheckedAt);
  const detectState = capabilityLoading
    ? "正在检测迁移条件…"
    : appMigrating
      ? "迁移进行中，结束之后再检测"
      : busy
        ? "有命令正在执行，等它结束再检测"
        : checkedClock
          ? `检测完成 · ${checkedClock}`
          : "尚未检测";

  return (
    <details className="panel settings-card card storage-card" open>
      <summary>Codex 应用本体</summary>
      <div className="settings-body">
        <div className="set-block">
          <div className="line">
            <strong>安装位置</strong>
            <span className="aside">
              {installLocation
                ? storage?.install
                  ? `所在磁盘剩余 ${formatBytes(storage.install.freeBytes)}`
                  : "已安装"
                : "尚未安装"}
            </span>
          </div>
          <div className="path-row">
            <input
              id="install-location"
              className="field-input input"
              readOnly
              value={installLocation ?? "尚未检测到已安装的 Codex"}
              title={installLocation ?? ""}
            />
            <button type="button" className="button" onClick={onOpenInstallLocation} disabled={!installLocation}>
              <Icon name="folder" size={14} />
              打开安装目录
            </button>
          </div>
          <p className="field-help">
            路径来自 <code>Get-AppxPackage</code>。迁移走 Windows 包部署服务，
            不会复制 WindowsApps、不改所有权。
          </p>
        </div>

        <div className="set-row">
          <div className="label">
            <strong>迁移条件</strong>
            <p className="field-help">
              应用本体归 Windows 包部署服务管，只能迁到已挂载的应用卷（通常是一整块磁盘），
              不能像缓存那样选任意文件夹。检测通过只代表条件满足，最终以真实安装位置为准。
            </p>
            {/* 检测结果永远落在这一行上：点完按钮它会从「尚未检测」变成「检测完成 · HH:MM」，
                不用等结果块滚进视口才知道刚才那一下有没有生效。 */}
            <p
              className={`field-help detect-state${capability?.failed ? " is-error" : ""}`}
              role="status"
              aria-live="polite"
            >
              {detectState}
            </p>
          </div>
          <button
            type="button"
            className="button"
            disabled={busy || capabilityLoading || appMigrating}
            title={
              busy
                ? "有命令正在执行，等它结束再检测"
                : appMigrating
                  ? "迁移进行中，结束之后再检测"
                  : undefined
            }
            onClick={onDetect}
          >
            <Icon name="activity" size={14} />
            {capabilityLoading ? "检测中…" : "检测迁移条件"}
          </button>
        </div>

        {capability && (
          <div className="capability-block" role="status" aria-live="polite">
            <div className="line">
              <strong>
                {capability.failed
                  ? "检测失败"
                  : capability.installed
                    ? capability.movable
                      ? "可以尝试迁移"
                      : "当前包不支持迁移"
                    : "尚未安装 Codex"}
              </strong>
              {capability.version && <span className="aside">v{capability.version}</span>}
            </div>
            <p className="field-help">{capability.reason}</p>
            {capability.installed && capability.packageVolume && (
              <div className="confirm-grid">
                <span>当前应用卷</span>
                <code>{capability.packageVolume}</code>
                <span>候选目标卷</span>
                <strong>{targets.length > 0 ? `${targets.length} 个可用` : "无"}</strong>
              </div>
            )}

            {capability.installed && capability.movable && targets.length > 0 && (
              <div className="path-row">
                <select
                  className="field-select volume-select"
                  id="app-target-volume"
                  aria-label="目标应用卷"
                  value={targetVolume}
                  onChange={(event) => setTargetVolume(event.target.value)}
                  disabled={busy || appMigrating}
                >
                  {targets.map((volume) => (
                    <option key={volume.path} value={volume.path}>
                      {volume.path} · 剩余 {formatBytes(volume.freeBytes)}
                      {volume.isSystemVolume ? "（系统卷）" : ""}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || appMigrating || !targetVolume}
                  title={!targetVolume ? "先选择一个目标应用卷" : undefined}
                  onClick={() => {
                    if (targetVolume) onMove(targetVolume);
                  }}
                >
                  <Icon name="hdd" size={14} />
                  {appMigrating ? "正在迁移…" : "迁移到所选卷"}
                </button>
              </div>
            )}

            {/* 装都没装、或者 Windows 根本没报告第二个应用卷时，这里能做的就是去系统里加卷。 */}
            {(!capability.installed || targets.length === 0) && (
              <div className="dash-actions">
                <button type="button" className="button" onClick={onOpenStorageSettings}>
                  <Icon name="folder" size={14} />
                  打开 Windows 存储设置
                </button>
              </div>
            )}

            <p className="field-help">
              迁移不会带走配置、会话、日志与项目目录；可能需要一次管理员授权。
            </p>
          </div>
        )}

        <div className="set-row">
          <div className="label">
            <strong>目录与诊断</strong>
            <p>安装包缓存、运行日志，以及一份可以直接粘给同事的诊断快照。</p>
          </div>
          <div className="settings-links inline">
            <button type="button" className="link-button" onClick={() => onOpen(cacheDirectory)}>
              打开缓存目录
            </button>
            <button type="button" className="link-button" onClick={() => onOpen(settings.logsDirectory)}>
              打开日志目录
            </button>
            {/* 复制诊断信息：同事报障时点一下就能把现场粘到聊天窗口里，不必截图。
                刻意不置灰（它不跑命令、瞬间返回），而且最需要它的时刻恰恰是安装刚失败、
                界面还忙着的那个时候。 */}
            <button type="button" className="link-button" onClick={onCopyDiagnostics}>
              复制诊断信息
            </button>
          </div>
        </div>
      </div>
    </details>
  );
}
