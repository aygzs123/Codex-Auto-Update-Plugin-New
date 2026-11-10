// GitHub Release 的只读解析。不碰网络 —— 真正发请求的是 main.cjs 里的 requestJson，
// 这样这个文件能在普通 Node 测试里 require，不必拉起 Electron。
//
// 只认 `desktop-v<版本>` 这一类 Release：它同时是更新器自身的版本来源和更新公告的来源。
// 客户端不再保存「该装哪个 Codex 版本」这类状态 —— 检查更新只对着同一个地方。
//
// 只认已发布（非 draft / 非 prerelease）的 Release，避免误把草稿当成正式版本。

const DESKTOP_TAG = /^desktop-v(\d+\.\d+\.\d+)$/;

/**
 * 比较点分版本号。返回 -1 / 0 / 1；任一侧不是数字版本时返回 null。
 *
 * Codex 用的是四段（26.901.6511.0），更新器是三段（0.3.0），所以短的一侧按 0 补齐：
 * 0.3 与 0.3.0 相等，而不是「长度不同就没法比」。
 */
function compareVersions(left, right) {
  const parse = (value) => {
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

function isPublished(release) {
  return Boolean(release) && release.draft !== true && release.prerelease !== true;
}

/**
 * 资产清单。
 *
 * `digest` 是 GitHub 计算好的 `sha256:<hex>`，应用内下载完必须拿它比对 —— 所以它必须
 * 原样带出来，不能在这一层做「没有就算了」的兜底。没有摘要的资产由下载命令拒绝：
 * 无法校验不等于校验通过。
 */
function toAssets(release) {
  return (Array.isArray(release.assets) ? release.assets : []).map((asset) => ({
    name: String(asset?.name || ""),
    size: Number(asset?.size) || 0,
    url: String(asset?.browser_download_url || ""),
    digest: String(asset?.digest || ""),
  }));
}

function toReleaseInfo(release, version) {
  return {
    version,
    tag: String(release.tag_name || ""),
    name: String(release.name || release.tag_name || ""),
    body: String(release.body || ""),
    url: String(release.html_url || ""),
    publishedAt: release.published_at || null,
    assets: toAssets(release),
  };
}

const ANNOUNCEMENT_LIMIT = 10;

function publishedTime(entry) {
  const time = Date.parse(String(entry.publishedAt || ""));
  return Number.isFinite(time) ? time : 0;
}

/**
 * 更新公告的时间线。
 *
 * 只收更新器自身的 `desktop-v*`，按发布时间倒序（不是按版本号）—— 版本号可能被回填或
 * 重发，时间线跟着发布时间走才符合直觉。只取最近若干条：界面是顶栏弹出的小面板，
 * 不是 Release 列表页。
 */
function pickAnnouncements(releases, limit = ANNOUNCEMENT_LIMIT) {
  const entries = [];
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!isPublished(release)) continue;
    const match = DESKTOP_TAG.exec(String(release.tag_name || ""));
    if (match) entries.push(toReleaseInfo(release, match[1]));
  }
  return entries.sort((left, right) => publishedTime(right) - publishedTime(left)).slice(0, limit);
}

/** 比当前运行版本新的最后一个更新器 Release；没有就返回 null。 */
function pickUpdater(releases, currentVersion) {
  let best = null;
  let bestVersion = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!isPublished(release)) continue;
    const match = DESKTOP_TAG.exec(String(release.tag_name || ""));
    if (!match) continue;
    if (compareVersions(match[1], currentVersion) !== 1) continue;
    if (!bestVersion || compareVersions(match[1], bestVersion) === 1) {
      best = toReleaseInfo(release, match[1]);
      bestVersion = match[1];
    }
  }
  return best;
}

/**
 * 拉一次 Release 列表，同时算出「更新器自身的新版本」与「公告时间线」。
 *
 * fetchJson 由调用方注入（主进程用 Electron 的 net，测试里用假函数），
 * 这个模块因此保持纯解析、可离线测试。
 */
async function fetchGithubUpdates({ fetchJson, repo, currentVersion }) {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=30`;
  const releases = await fetchJson(url);
  if (!Array.isArray(releases)) throw new Error("GitHub 返回的 Release 列表格式不对");
  return {
    updater: pickUpdater(releases, currentVersion),
    announcements: pickAnnouncements(releases),
  };
}

module.exports = {
  compareVersions,
  pickUpdater,
  pickAnnouncements,
  fetchGithubUpdates,
};
