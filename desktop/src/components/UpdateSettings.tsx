import type { Settings } from "../types";

type UpdateToggleKey = "autoCheck" | "autoDownload" | "notifyUpdates";

const INTERVAL_OPTIONS = [1, 3, 6, 12, 24];

/**
 * 更新与通知。
 *
 * 三个开关的默认值刻意不同：
 *   - 自动检查更新**默认开**：不查就不知道有没有新版，这是这个工具的本职；
 *   - 自动下载更新包**默认关**：一个 800 MB 级的下载不该在没人要求时自己发生；
 *   - 系统通知**默认开**：只在真的发现新版时出声，同一版本只响一次。
 *
 * 无论哪一项打开，**都不会自动安装**：需要管理员权限的安装永远由人点
 *（AGENTS.md 的硬规矩），自动下载只把包放进缓存。
 */
export function UpdateSettings({
  settings,
  onToggle,
  onIntervalChange,
}: {
  settings: Settings | null;
  onToggle: (key: UpdateToggleKey, value: boolean) => void;
  onIntervalChange: (hours: number) => void;
}) {
  if (!settings) return null;

  // 字段缺失时按默认值显示：autoCheck / notifyUpdates 默认开，autoDownload 默认关。
  const autoCheck = settings.autoCheck !== false;
  const autoDownload = settings.autoDownload === true;
  const notifyUpdates = settings.notifyUpdates !== false;
  const interval = INTERVAL_OPTIONS.includes(Number(settings.checkIntervalHours))
    ? Number(settings.checkIntervalHours)
    : 6;

  const rows: Array<{ key: UpdateToggleKey; title: string; detail: string; checked: boolean }> = [
    {
      key: "autoCheck",
      title: "启动时自动检查更新",
      detail: "每次打开更新器都问一次分发源，结论落在概览页，不弹窗。",
      checked: autoCheck,
    },
    {
      key: "autoDownload",
      title: "发现新版本后自动下载安装包",
      detail: "只下载到缓存，不安装。需要管理员权限的安装仍然由你点「一键更新」触发。",
      checked: autoDownload,
    },
    {
      key: "notifyUpdates",
      title: "发现新版本时弹系统通知",
      detail: "窗口不在前台时才提醒；同一个版本只提醒一次，点通知会打开更新器。",
      checked: notifyUpdates,
    },
  ];

  return (
    <details className="panel settings-card card" open>
      <summary>更新与通知</summary>
      <div className="settings-body">
        {rows.map((row) => (
          <div className="set-row" key={row.key}>
            <div className="label">
              <strong>{row.title}</strong>
              <p>{row.detail}</p>
            </div>
            <label className="switch-control">
              <input
                type="checkbox"
                className="sr-only"
                checked={row.checked}
                onChange={(event) => onToggle(row.key, event.target.checked)}
              />
              <span className="switch" role="switch" aria-checked={row.checked} />
            </label>
          </div>
        ))}

        <div className="set-row">
          <div className="label">
            <strong>后台复查间隔</strong>
            <p>开着托盘常驻或开机自启时，每隔这么久再查一次。只在后台模式下生效。</p>
          </div>
          <select
            className="field-select"
            value={interval}
            disabled={!autoCheck}
            onChange={(event) => onIntervalChange(Number(event.target.value))}
            aria-label="后台复查间隔"
          >
            {INTERVAL_OPTIONS.map((hours) => (
              <option key={hours} value={hours}>
                每 {hours} 小时
              </option>
            ))}
          </select>
        </div>

        <div className="set-block">
          <p className="field-help">
            <strong>不会自动安装任何东西</strong>：自动检查只给结论，自动下载只把包放进缓存；
            需要管理员授权的安装永远由你自己点。
          </p>
        </div>
      </div>
    </details>
  );
}
