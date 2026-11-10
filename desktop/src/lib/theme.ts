import type { ThemePreference } from "../types";

/**
 * 主题解析的唯一实现。
 *
 * 偏好（system / light / dark）与系统当前配色一起决定真正生效的主题；显式浅色 /
 * 深色必须压过系统。根节点上的 `data-theme` 永远写**解析后**的值（light / dark），
 * 偏好另写一份 `data-theme-preference` —— CSS 只消费前者，界面只展示后者。
 *
 * 以前这里只有 `nativeTheme.themeSource` 一条链路：主进程改了，CSS 靠
 * `@media (prefers-color-scheme: dark)` 自动跟上。实际安装版里用户报告「主题不生效」，
 * 说明媒体查询这条隐式链路在某些环境下不可靠。现在改成显式属性驱动，系统偏好只作为
 * 解析输入，不再直接决定界面。
 */
export type ResolvedTheme = "light" | "dark";

export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(preference: ThemePreference | undefined | null, prefersDark: boolean): ResolvedTheme {
  if (preference === "light") return "light";
  if (preference === "dark") return "dark";
  return prefersDark ? "dark" : "light";
}

/** 把解析后的主题写到根节点。CSS 变量全部挂在 `[data-theme]` 上。 */
export function applyThemeToDocument(
  preference: ThemePreference | undefined | null,
  prefersDark: boolean = systemPrefersDark(),
): ResolvedTheme {
  const resolved = resolveTheme(preference, prefersDark);
  if (typeof document === "undefined") return resolved;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference ?? "system";
  // 原生滚动条、表单控件与 <select> 下拉框跟随 color-scheme，不能只换 CSS 变量。
  root.style.colorScheme = resolved;
  return resolved;
}
