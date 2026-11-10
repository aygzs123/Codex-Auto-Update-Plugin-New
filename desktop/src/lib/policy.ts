/* 版本比较与商店更新策略。 */

/**
 * 比较点分版本号（Codex 四段、更新器三段都能比）。
 *
 * 与 electron/github.cjs 里的那份保持同一语义：短的一侧按 0 补齐。两份实现都很小，
 * 但用途不同 —— 主进程用它挑 Release，渲染进程用它判断「该装哪个版本」；测试分别钉住。
 */
export function compareVersions(left: string | null | undefined, right: string | null | undefined): number | null {
  const parse = (value: string | null | undefined) => {
    const text = String(value ?? "").trim().replace(/^v/i, "");
    if (!/^\d+(?:\.\d+)*$/.test(text)) return null;
    return text.split(".").map((part) => Number(part));
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

export interface UpdatePolicyInput {
  storeVersion: string | null;
  storeUpdateAvailable: boolean | null;
}

/**
 * 「这次到底该不该装、装哪个」的唯一判据。
 *
 * 结论只来自 check_update（商店最新版 vs 本机）。版本固定功能已经移除 —— 客户端不再
 * 保存「该装哪个 Codex 版本」这种全局状态；更新器自己的版本检查走「关于」里的另一条
 * 路径（见 AppUpdateState），两者互不干扰。
 */
export interface UpdatePolicy {
  /** 是否已经拿到足以下结论的信息。false 时界面不可以说「已是最新」。 */
  resolved: boolean;
  updateAvailable: boolean;
  /** 要安装的版本；null 表示没有可安装的新版本。 */
  targetVersion: string | null;
}

export function resolveUpdatePolicy(input: UpdatePolicyInput): UpdatePolicy {
  const resolved = input.storeUpdateAvailable !== null;
  const updateAvailable = input.storeUpdateAvailable === true && Boolean(input.storeVersion);
  return {
    resolved,
    updateAvailable,
    targetVersion: updateAvailable ? input.storeVersion : null,
  };
}
