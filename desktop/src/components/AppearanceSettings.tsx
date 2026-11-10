import type { Settings, ThemePreference } from "../types";

/**
 * 外观：主题颜色。
 *
 * 三档而不是两颗开关：跟随系统是默认，浅色 / 深色是显式覆盖。值交给主进程写进
 * settings.json 并设置 `nativeTheme.themeSource` —— 渲染层不做第二套 CSS，
 * 系统级 `prefers-color-scheme` 会自动跟上，窗口背景、原生菜单、通知也一起变。
 */
const OPTIONS: Array<{ value: ThemePreference; label: string; detail: string }> = [
  { value: "system", label: "跟随系统", detail: "Windows 切深色时一起变" },
  { value: "light", label: "浅色", detail: "始终使用浅色界面" },
  { value: "dark", label: "深色", detail: "始终使用深色界面" },
];

export function AppearanceSettings({
  settings,
  onTheme,
}: {
  settings: Settings | null;
  onTheme: (theme: ThemePreference) => void;
}) {
  if (!settings) return null;
  const theme = settings.theme ?? "system";

  return (
    <details className="panel settings-card card" open>
      <summary>外观</summary>
      <div className="settings-body">
        <div className="set-block">
          <div className="line">
            <strong>主题颜色</strong>
            <span className="aside">{OPTIONS.find((option) => option.value === theme)?.label ?? "跟随系统"}</span>
          </div>
          <p>切换后立即生效。原生窗口背景、托盘菜单与系统通知会一起变，不需要重启。</p>
          <div className="theme-options" role="radiogroup" aria-label="主题颜色">
            {OPTIONS.map((option) => {
              const active = option.value === theme;
              return (
                <button
                  type="button"
                  key={option.value}
                  className="theme-option"
                  data-active={active}
                  role="radio"
                  aria-checked={active}
                  onClick={() => onTheme(option.value)}
                >
                  <span className="theme-swatch" data-theme={option.value} aria-hidden="true" />
                  <strong>{option.label}</strong>
                  <small>{option.detail}</small>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </details>
  );
}
