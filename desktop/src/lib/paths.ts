/** Windows 路径比较：大小写不敏感，末尾斜杠不算区别。空值一律视为不相等。 */
export function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalize = (value: string | null | undefined) =>
    String(value ?? "").trim().replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  const a = normalize(left);
  return a.length > 0 && a === normalize(right);
}
