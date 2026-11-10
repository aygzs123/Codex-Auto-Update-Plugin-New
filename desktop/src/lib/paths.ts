/**
 * 用户选中的文件夹 → 实际缓存目录。
 *
 * 缓存固定放在所选文件夹下的 `Codex Updater\downloads`：用户选「E 盘」或「D:\工具」时，
 * 安装包不会直接平铺在根目录，多个版本、`.meta` 与后续加进来的文件都有自己的一层。
 * 如果用户已经选中了这个子目录本身（或 `Codex Updater` 那一层），就不再重复嵌套。
 */
export function cacheDirectoryUnder(folder: string): string {
  const trimmed = String(folder || "").trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  // 统一成反斜杠再判断，避免用户手输 `E:/Codex 缓存` 时后缀不匹配。
  const leaf = trimmed.replace(/\//g, "\\");
  if (/\\codex updater\\downloads$/i.test(leaf)) return leaf;
  if (/\\codex updater$/i.test(leaf)) return `${leaf}\\downloads`;
  return `${leaf}\\Codex Updater\\downloads`;
}

/** Windows 路径比较：大小写不敏感，末尾斜杠不算区别。空值一律视为不相等。 */
export function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalize = (value: string | null | undefined) =>
    String(value ?? "").trim().replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  const a = normalize(left);
  return a.length > 0 && a === normalize(right);
}
