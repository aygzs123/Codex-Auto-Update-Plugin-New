import type { UpdatePolicy } from "../lib/policy";
import { Icon } from "./Icons";

/**
 * 策略告警。
 *
 * 这里只剩一条「这次更新后退不回去」：它影响「敢不敢装」，不可关闭 —— 关掉不等于
 * 问题消失。更新公告不在这里：那是第二层信息，收进顶栏的公告铃铛（AnnouncementBell）。
 */
export function UpdateTip({ policy, installedVersion }: { policy: UpdatePolicy; installedVersion: string | null }) {
  if (!policy.rollbackRisk) return null;

  return (
    <div className="tip-stack">
      <section className="tip" data-tone="orange">
        <span className="tip-icon">
          <Icon name="info" size={15} />
        </span>
        <div className="tip-body">
          <strong>本次更新后无法退回当前版本</strong>
          <p>{`缓存里没有${installedVersion ? ` ${installedVersion}` : "当前版本"}的安装包。分发源只提供最新版，更新后这个版本就下不回来了。`}</p>
        </div>
      </section>
    </div>
  );
}
