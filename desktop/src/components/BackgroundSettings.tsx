import type { Settings } from "../types";

type ToggleKey = "minimizeToTray" | "launchAtLogin";

/**
 * 后台常驻相关的两个开关。
 *
 * 单独一张卡片、**默认全关**，是因为这两项都会改变本应用在用户机器上的存在方式：一个让
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

  return (
    <details className="panel settings-card">
      <summary>后台与启动（可选）</summary>
      <div className="settings-body">
        <label className="switch-row">
          <input
            type="checkbox"
            checked={settings.minimizeToTray === true}
            onChange={(event) => onToggle("minimizeToTray", event.target.checked)}
          />
          <span>
            关窗后留在托盘里
            <small>关掉窗口不退出，托盘图标里还能点「立即检查更新」。不想常驻就别开。</small>
          </span>
        </label>

        <label className="switch-row">
          <input
            type="checkbox"
            checked={settings.launchAtLogin === true}
            onChange={(event) => onToggle("launchAtLogin", event.target.checked)}
          />
          <span>
            开机自动启动
            <small>开机后静默起来查一次，发现新版本弹一条系统通知；不会弹窗，也不会自动安装。</small>
          </span>
        </label>

        <p className="field-help">
          两项都是可选的，默认关闭。打开之后也<strong>不会自动安装任何东西</strong>：需要管理员
          授权的安装永远由你自己点。发现新版本只提醒一次（同一个版本不会反复提醒）。
        </p>
        <p className="field-help">
          提示：系统通知需要应用装了带 AppUserModelID 的快捷方式才会显示，所以用安装包装出来的
          版本才能看到通知；直接跑源码（开发模式）时不一定弹得出来。
        </p>
      </div>
    </details>
  );
}
