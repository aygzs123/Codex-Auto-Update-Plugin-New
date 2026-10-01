// 窗口探针「没等到主窗口」时的三档判定 → 界面文案。
//
// 映射表只此一份。渲染进程不能 require 主进程的 parse.cjs，所以主进程那边只负责把判定
// 字符串原样带过来（取值见 electron/parse.cjs 的 STARTUP_DIAGNOSIS_VALUES），中文文案
// 与「要不要给修复入口」全部在这里决定。
//
// 为什么要分档：以前无论什么原因都直接说「这是官方已知的加密资源搬迁问题的特征」。
// 2026-10-01 在一台完全正常的机器上就这么误诊了一次 —— 那次只是首次启动在把几百 MB
// 运行时物化到用户缓存（实测约 132 秒），探针 30 秒就放弃了，用户拿着一条没用的修复
// 建议白跑一趟；真正挡住窗口的是一个跟资源无关的对话框。
//
// 误判的代价是不对称的：说「还在准备」最多让人多等一会儿；说「就是那个 bug」会把人
// 推进一条本来不需要走的路（关掉 Codex、重写几百 MB 资源）。所以拿不出证据时宁可不指控，
// unknown 档只陈述事实并给出下一步排查方向，绝不给修复按钮。

import type { StartupDiagnosis } from "../types";

export interface DiagnosisCopy {
  verdict: StartupDiagnosis;
  title: string;
  body: string;
  /** 是否给出「修复资源副本」入口。只有 relocation-bug 这一档才给。 */
  showRepair: boolean;
}

export function diagnosisCopy(verdict: StartupDiagnosis | undefined): DiagnosisCopy {
  switch (verdict) {
    case "relocation-bug":
      return {
        verdict: "relocation-bug",
        title: "这是官方已知的加密资源搬迁问题",
        body:
          "安装包里的加密资源没能复制到用户目录，启动流程卡在窗口出现之前" +
          "（资源目录下留着复制失败的中转目录，副本目录始终没有生成）。" +
          "重建资源副本即可恢复；修复会先关闭正在运行的 Codex。",
        showRepair: true,
      };

    case "still-preparing":
      return {
        verdict: "still-preparing",
        title: "Codex 还在准备运行环境",
        body:
          "启动所需的运行时文件最近还在往本地缓存里写 —— 首次启动要落几百 MB，比等待时间更长是正常的。" +
          "按这个证据看它只是还没写完，不必修复：等一两分钟，再点一次「打开 Codex」即可；" +
          "如果仍然没有窗口，再看下面的原始诊断。",
        showRepair: false,
      };

    default:
      return {
        verdict: verdict ?? null,
        title: "未能判定主窗口为什么没有出现",
        body:
          "现有的资源证据既不能证明、也不能排除加密资源搬迁问题。" +
          "可以先看两处：应用自己的日志（%LOCALAPPDATA%\\OpenAI\\Codex），" +
          "以及屏幕上是不是有个 Codex 的对话框挡住了主窗口（例如「无法加载组织设置」）。" +
          "也可以直接点一次「打开 Codex」重试。",
        showRepair: false,
      };
  }
}
