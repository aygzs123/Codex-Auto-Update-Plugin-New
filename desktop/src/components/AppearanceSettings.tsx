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
  pending,
  onTheme,
}: {
  settings: Settings | null;
  /** 主题正在落盘。控件不禁用（允许连续切换），只把状态说清楚。 */
  pending?: boolean;
  onTheme: (theme: ThemePreference) => void;
}) {
  if (!settings) return null;
  const theme = settings.theme ?? "system";
  const activeIndex = Math.max(0, OPTIONS.findIndex((option) => option.value === theme));
  const choose = (index: number) => {
    const next = OPTIONS[(index + OPTIONS.length) % OPTIONS.length];
    onTheme(next.value);
    document.getElementById(`theme-option-${next.value}`)?.focus();
  };

  return (
    <details className="panel settings-card card" open>
      <summary>外观</summary>
      <div className="settings-body">
        <div className="set-block">
          <div className="line">
            <strong>主题颜色</strong>
            <span className="aside">{pending ? "正在保存…" : OPTIONS[activeIndex]?.label ?? "跟随系统"}</span>
          </div>
          <p>立即生效，窗口背景、托盘菜单与通知一起变。</p>
          <div className="theme-options" role="radiogroup" aria-label="主题颜色">
            {OPTIONS.map((option, index) => {
              const active = option.value === theme;
              return (
                <button
                  type="button"
                  key={option.value}
                  id={`theme-option-${option.value}`}
                  className="theme-option"
                  data-active={active}
                  role="radio"
                  aria-checked={active}
                  tabIndex={active ? 0 : -1}
                  onClick={() => onTheme(option.value)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                      event.preventDefault();
                      choose(index + 1);
                    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                      event.preventDefault();
                      choose(index - 1);
                    }
                  }}
                >
                  <span className="theme-swatch" data-theme={option.value} aria-hidden="true" />
                  <strong>{option.label}</strong>
                  <small>{option.detail}</small>
                </button>
              );
            })}
          </div>
          <p className="field-help">
            选了浅色或深色后不再跟随系统；保存失败会恢复上一个值。
          </p>
        </div>
      </div>
    </details>
  );
}
