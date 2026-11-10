import type { Settings } from "../types";

type ToggleKey = "minimizeToTray" | "launchAtLogin";

/**
 * 后台常驻相关的两个开关。
 *
 * 单独一组、**默认全关**，是因为这两项都会改变本应用在用户机器上的存在方式：一个让
 * 进程在关窗之后继续活着，一个往注册表里写开机启动项。同事没要求过的东西不该自己出现 ——
 * 一个「装完就在后台常驻、还开机自启」的小工具，第一反应是流氓软件。
 *
 * 文案里必须写明「打开后不会自动安装任何东西」：这是这个功能最容易被误会的地方。它只是
 * 让更新器自己起来查一次，查到新版本弹一条系统通知；真正需要提权的安装永远等人点
 *（AGENTS.md 那条「后台运行绝不弹 UAC」的规矩），所以不能省这句话。
 */
export function BackgroundSettings({
  settings,
  onToggle,
}: {
  settings: Settings | null;
  onToggle: (key: ToggleKey, value: boolean) => void;
}) {
  if (!settings) return null;

  const rows: Array<{ key: ToggleKey; title: string; detail: string }> = [
    {
      key: "minimizeToTray",
      title: "关窗后留在托盘里",
      detail: "关窗不退出，可从托盘「立即检查更新」。",
    },
    {
      key: "launchAtLogin",
      title: "开机自动启动",
      detail: "开机后静默查一次，有新版本时弹通知，不弹窗、不安装。",
    },
  ];

  return (
    <details className="panel settings-card card" open>
      <summary>后台与启动（可选）</summary>
      <div className="settings-body">
        {rows.map((row) => {
          const checked = settings[row.key] === true;
          return (
            <div className="set-row" key={row.key}>
              <div className="label">
                <strong>{row.title}</strong>
                <p>{row.detail}</p>
              </div>
              <label className="switch-control">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={checked}
                  onChange={(event) => onToggle(row.key, event.target.checked)}
                />
                <span className="switch" role="switch" aria-checked={checked} />
              </label>
            </div>
          );
        })}

        <div className="set-block">
          <p className="field-help">
            默认关闭。打开后也<strong>不会自动安装任何东西</strong>：需要管理员权限的安装
            永远由你自己点。
          </p>
          <p className="field-help">
            同一版本只提醒一次。系统通知要带 AppUserModelID 的快捷方式，安装包版才有；
            直接跑源码不一定弹得出来。
          </p>
        </div>
      </div>
    </details>
  );
}
