// 安装包签名与发布者的判断逻辑。
//
// 单独抽成一个不依赖 electron 的模块，是为了能被 tests/verify.test.cjs **真正执行**。
// 这段判断最初写成「签名者主题里必须含 openai」，结果把每一个合法安装包都拒了 ——
// Store 分发的包，发布者 DN 是 CN=<GUID> 的形式（Codex 是
// CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B），里头根本没有 "OpenAI" 字样。
// 当时只有对源码做正则匹配的契约测试，没有一条断言跑过这段逻辑，所以它一路发到了用户手上，
// 表现是「一键安装」在签名闸门上 100% 失败。
//
// 教训写在这里：判断逻辑要么放在能被执行的模块里，要么就会长成这个样子。

/** 包名，与 CodexStoreUpdater.psm1 各脚本及各 .ps1 的默认参数保持一致。 */
const CODEX_PACKAGE_NAME = "OpenAI.Codex";

/**
 * 已登记的 Codex 发布者。**只在本机查不到已安装的 Codex 时使用**。
 *
 * 正常情况下期望值来自「你机器上正在用的那个 Codex」（见 evaluateSignature）：
 * 升级与回退的语义都是「新包必须和现在这个同源」，从已安装的包上现取正好就是这个意思，
 * 也就不会因为 OpenAI 换了发布者名字而把后续所有更新都误拒。这个常量是全新安装
 * （本机没有 Codex 可比）时的兜底。
 */
const FALLBACK_PUBLISHER = "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B";

/**
 * 取出 DN 里的 CN。
 *
 * 只比 CN、不比整串，是因为同一条 DN 经过不同 API 出来并不保证逐字节相同：
 * 这里的两个值是**两个来源** —— 签名证书的 Subject 来自 Get-AuthenticodeSignature，
 * 期望值来自 Get-AppxPackage 的 Publisher，RDN 的顺序与附带字段都可能不一样。
 * 拿整串比较迟早会在某台机器上又变成「合法包被拒」，而那正是本次要修的故障。
 */
function commonName(distinguishedName) {
  const match = String(distinguishedName || "").match(/(?:^|,)\s*CN\s*=\s*([^,]+)/i);
  return match ? match[1].trim().toLowerCase() : "";
}

/** 两个 DN 是否指向同一个发布者。 */
function publisherMatches(subject, expected) {
  const actual = commonName(subject);
  const want = commonName(expected);
  // 两边都取不出 CN 时不能算「相等」：那是两次解析失败，不是同一个发布者。
  // 少了这个前提，任何两个无法解析的 DN 都会互相通过校验。
  return actual !== "" && actual === want;
}

/**
 * 判断一次签名校验的结果是否可信。
 *
 * 返回 { ok, reason, expected }，reason ∈ verified / unsigned / publisher。
 * 「签名无效」和「签名有效但不是 Codex 的发布者」是两回事，不能合成一个结论 ——
 * 上一版把它们并成一句「签名无效或发布者不是 OpenAI」，于是用户看到「签名无效」时，
 * 同一张卡片上的数字签名状态明明写着 Valid，等于把一次判断错误说成文件损坏。
 */
function evaluateSignature({ status, subject, installedPublisher } = {}) {
  const expected = String(installedPublisher || "").trim() || FALLBACK_PUBLISHER;
  if (String(status || "") !== "Valid") return { ok: false, reason: "unsigned", expected };
  if (!publisherMatches(subject, expected)) return { ok: false, reason: "publisher", expected };
  return { ok: true, reason: "verified", expected };
}

module.exports = {
  CODEX_PACKAGE_NAME,
  FALLBACK_PUBLISHER,
  commonName,
  publisherMatches,
  evaluateSignature,
};
