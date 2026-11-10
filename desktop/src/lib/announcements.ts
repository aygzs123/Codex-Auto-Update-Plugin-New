import type { GithubReleaseInfo } from "../types";
import changelog from "./changelog.generated.json";

/**
 * 更新公告的两条来源：
 *
 *   1. 打包进应用的 CHANGELOG 历史（0.1.0 起每个版本都有一节）；
 *   2. GitHub Releases 上比当前版本更新的那些。
 *
 * 合并规则：按 tag 去重、本地历史优先。历史 Release 的正文是通用模板（「Windows x64
 * Electron installer…」），真正的版本说明在 CHANGELOG 里；沿用 GitHub 的正文只会让
 * 时间线里出现几条一模一样的英文客套话。比当前版本新的 Release 本地还没有小节，
 * 这时才用远端正文。
 */
export const GITHUB_REPO = "aygzs123/Codex-Auto-Update-Plugin-New";

const ANNOUNCEMENT_LIMIT = 10;

interface ChangelogEntry {
  version: string;
  date: string;
  body: string;
}

/** 把构建时生成的 CHANGELOG JSON 变成与远端公告同构的条目。 */
export function changelogAnnouncements(entries: ChangelogEntry[] = changelog as ChangelogEntry[]): GithubReleaseInfo[] {
  return entries.map((entry) => ({
    version: entry.version,
    tag: `desktop-v${entry.version}`,
    name: `Codex Updater ${entry.version}`,
    body: entry.body,
    url: `https://github.com/${GITHUB_REPO}/releases/tag/desktop-v${entry.version}`,
    publishedAt: `${entry.date}T00:00:00Z`,
    assets: [],
  }));
}

function publishedTime(entry: GithubReleaseInfo): number {
  const time = Date.parse(String(entry.publishedAt || ""));
  return Number.isFinite(time) ? time : 0;
}

/**
 * 合并本地历史与远端公告。
 *
 * 本地在前：同一个 tag 两条都有时，本地（CHANGELOG）的正文胜出。远端独有的条目
 * （通常是比当前版本新的 Release）照常展示。
 */
export function mergeAnnouncements(
  local: GithubReleaseInfo[],
  remote: GithubReleaseInfo[],
  limit = ANNOUNCEMENT_LIMIT,
): GithubReleaseInfo[] {
  const byTag = new Map<string, GithubReleaseInfo>();
  for (const entry of local) byTag.set(entry.tag, entry);
  for (const entry of remote) {
    if (!byTag.has(entry.tag)) byTag.set(entry.tag, entry);
  }
  return [...byTag.values()]
    .sort((left, right) => publishedTime(right) - publishedTime(left))
    .slice(0, limit);
}
