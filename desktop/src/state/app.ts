import { create } from "zustand";
import { invokeCommand, subscribeProgress } from "../lib/bridge";
import type {
  Activity,
  ActivityId,
  CachedPackage,
  CachedPackageList,
  DownloadResult,
  HealthReport,
  InstallResult,
  LaunchResult,
  Phase,
  ProgressEvent,
  Settings,
  SignatureReport,
  UpdateReport,
} from "../types";

const MAX_LOG_LINES = 300;

interface AppState {
  phase: Phase;
  status: HealthReport | null;
  update: UpdateReport | null;
  signature: SignatureReport | null;
  settings: Settings | null;
  activity: Activity | null;
  installResult: InstallResult | null;
  /** 上一次「打开 Codex」的结果，用来把「进程在、窗口不在」如实呈现出来。 */
  launchResult: LaunchResult | null;
  /** 健康自检（含窗口探测）的完整结果，与启动时的 status 分开保存。 */
  healthDetail: HealthReport | null;
  /** 下载缓存里的安装包清单，回退功能的数据源。读不到时为 null。 */
  cachedPackages: CachedPackageList | null;
  probing: boolean;
  repairing: boolean;
  /**
   * 正在回退到旧版本。
   *
   * 单独一个标志位而不是复用 phase：回退虽然是 working 态，但界面要能说出
   * 「正在回退…」而不是「正在安装…」，主按钮的文案就靠它区分。
   */
  rollingBack: boolean;
  /**
   * 「检查更新」正在跑。
   *
   * 单独一个标志位，不复用 phase：检查更新不改 phase（它不动安装状态，结论只落在
   * update / notice 上），但它同样是一次网络往返，跑着的时候不许再触发任何命令。
   */
  checkingUpdate: boolean;
  error: string | null;
  notice: string | null;

  bootstrap: () => Promise<void>;
  oneClick: () => Promise<void>;
  /** 重新读取缓存里的安装包清单（装完、回退完都会变）。失败不报错，只是列表不更新。 */
  refreshCachedPackages: () => Promise<void>;
  /** 回退到指定的旧版本安装包。走的是和安装同一条链路，只是允许降级。 */
  rollback: (pkg: CachedPackage) => Promise<void>;
  checkUpdate: () => Promise<void>;
  runHealthProbe: () => Promise<void>;
  runRepair: () => Promise<void>;
  launch: () => Promise<void>;
  saveDownloadDirectory: (value: string) => Promise<void>;
  pickDirectory: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  /** 打开 Windows 的「新的应用将保存到」设置页；Codex 装在哪个盘由它决定。 */
  openStorageSettings: () => Promise<void>;
  applyProgress: (event: ProgressEvent) => void;
  dismissNotice: () => void;
  reset: () => void;
}

function startActivity(id: ActivityId, label: string): Activity {
  return { id, label, percent: 0, indeterminate: false, logs: [] };
}

/**
 * 有没有命令正在跑 —— 所有「触发命令」的入口都必须用它置灰。判据只此一处。
 *
 * 以前每个动作各自记一个布尔，谁都没把「别人正在跑」算进去，于是同时能开好几条命令：
 *   - 检查更新压根不置位 → 网络往返期间按钮一直可点，用户连点几次，界面连弹几次结论；
 *   - 修复资源副本只置 repairing，主按钮判的是 phase === "working" → 修复途中还能再点
 *     一次「一键安装」，两条命令叠着跑，一边关 Codex 一边装 Codex；
 *   - 健康自检期间同理。
 * 这些都不是理论问题：它们都是「点了没反应 / 反应对不上」的来源。
 *
 * phase === "checking" 也算在内：那是启动时的首次读取，此时 settings 还没到手，
 * 这时候放命令进来会拿着空配置去跑。
 */
export const isCommandRunning = (state: {
  phase: Phase;
  probing: boolean;
  repairing: boolean;
  checkingUpdate: boolean;
  rollingBack: boolean;
}): boolean =>
  state.phase === "working" ||
  state.phase === "checking" ||
  state.probing ||
  state.repairing ||
  state.checkingUpdate ||
  state.rollingBack;

/**
 * 「打开缓存目录」该打开哪个目录 —— 全应用只此一处判据。
 *
 * 三处入口（原生菜单、高级设置里的链接、「版本历史」卡片底部）以前各写各的，其中两处
 * 直接读 settings.defaultDownloadDirectory。于是用户在高级设置里把缓存换到 D 盘之后，
 * 那两颗按钮仍然打开 C 盘的默认目录，和卡片里列出来的包、以及 worker 实际剪枝的目录
 * 都对不上 —— 一个「改了设置但只有一半地方生效」的 bug。
 *
 * 优先用枚举脚本回传的 downloadDirectory：那是主进程按「自定义值 → 展开 %VAR% → 回退
 * 默认」解析出来的最终路径，也就是安装包真正躺在的那个目录。
 */
export function effectiveDownloadDirectory(state: {
  settings: Settings | null;
  cachedPackages: CachedPackageList | null;
}): string {
  const resolved = state.cachedPackages?.downloadDirectory;
  if (resolved) return resolved;
  const custom = (state.settings?.downloadDirectory ?? "").trim();
  return custom || state.settings?.defaultDownloadDirectory || "";
}

export const useAppStore = create<AppState>((set, get) => ({
  phase: "checking",
  status: null,
  update: null,
  signature: null,
  settings: null,
  activity: null,
  installResult: null,
  launchResult: null,
  healthDetail: null,
  cachedPackages: null,
  probing: false,
  repairing: false,
  rollingBack: false,
  checkingUpdate: false,
  error: null,
  notice: null,

  bootstrap: async () => {
    set({ phase: "checking", error: null });
    try {
      const settings = await invokeCommand<Settings>("get_settings");
      const status = await invokeCommand<HealthReport>("get_status");
      set({ settings, status, phase: "ready" });
    } catch (error) {
      set({ phase: "failed", error: describe(error) });
    }
    // 缓存清单单独一次、且失败不影响启动：枚举脚本出错只是让「版本历史」卡片暂时没内容，
    // 不该把整个应用拖进 failed 态 —— 那就成了「装个 Codex 还得先修好缓存」。
    //
    // 这一步必须在 catch 之外。以前 catch 分支直接 return，初始化一旦失败就永远刷不到
    // 缓存清单；而 refreshCachedPackages 恰恰不依赖那次失败的调用（拿不到 settings 时
    // 主进程会按默认缓存目录解析），没有理由跳过。
    await get().refreshCachedPackages();
  },

  /**
   * 一键安装 / 更新：查更新 → 下载 → 校验签名 → 安装（安装脚本会顺带启动 Codex
   * 并探测主窗口）。
   *
   * 签名校验不通过时中止，不把来路不明的包交给 Add-AppxPackage。这是原型里没有的
   * 一道闸门：它原本无条件往下走。
   */
  oneClick: async () => {
    set({ phase: "working", error: null, notice: null, installResult: null, launchResult: null, update: null, signature: null });

    try {
      set({ activity: startActivity("download", "正在查询官方分发源") });
      const update = await invokeCommand<UpdateReport>("check_update", {
        downloadDirectory: get().settings?.downloadDirectory ?? "",
      });
      set({ update });

      if (update.updateAvailable === false) {
        set({
          phase: "done",
          activity: null,
          notice: update.installedVersion
            ? `已经是较新版本（${update.installedVersion}），无需安装`
            : "已经是最新版本，无需安装",
        });
        return;
      }

      const download = await invokeCommand<DownloadResult>("download_codex", {
        downloadDirectory: get().settings?.downloadDirectory ?? "",
      });
      if (download.status === "latest") {
        set({ phase: "done", activity: null, notice: "已经是最新版本，无需安装" });
        return;
      }

      const signature = await invokeCommand<SignatureReport>("verify_download_signature", { path: download.path });
      set({ signature });
      if (signature.status !== "verified") {
        set({
          phase: "failed",
          activity: null,
          error: `安装包签名校验未通过，已中止安装。${signature.message}\n${describeSignature(signature)}`,
        });
        return;
      }

      const installResult = await invokeCommand<InstallResult>("install_codex", { path: download.path });
      const status = await invokeCommand<HealthReport>("get_status").catch(() => get().status);
      set({ installResult, status, phase: "done", activity: null, healthDetail: null });
    } catch (error) {
      set({ phase: "failed", activity: null, error: describe(error) });
    } finally {
      // 装完之后缓存里的包会变（新包进来、被顶掉的那个删掉），所以刷一次。
      // 每条出口都走这里：中途失败时缓存同样可能已经变了。
      void get().refreshCachedPackages();
    }
  },

  refreshCachedPackages: async () => {
    try {
      const cachedPackages = await invokeCommand<CachedPackageList>("list_cached_packages", {
        downloadDirectory: get().settings?.downloadDirectory ?? "",
      });
      set({ cachedPackages });
    } catch {
      // 读不到就保持原样。「版本历史」卡片显示的是缓存里有什么，它不该成为失败来源。
    }
  },

  /**
   * 回退到缓存里的旧版本。
   *
   * 签名校验这一步不能省：这个包在磁盘上可能已经躺了几周，中间谁都有可能动过它。
   * 「一键安装」路径上的那道闸门在这里同样是硬要求 —— 同一个包，不能因为它是旧版就
   * 少检一道。
   */
  rollback: async (pkg) => {
    // 卡片上的按钮不像主按钮那样有 runAction 这个统一闸门兜着，闸门在这里自己把一道。
    if (isCommandRunning(get())) return;
    set({
      rollingBack: true,
      phase: "working",
      error: null,
      notice: null,
      installResult: null,
      launchResult: null,
      // 降级之后 update 那份结论是照着旧版本算出来的（「可更新到 26.924」），
      // 留着主按钮就会显示一个已经过期的判断。
      update: null,
      signature: null,
      activity: startActivity("install", `正在回退到 ${pkg.version}`),
    });

    try {
      const signature = await invokeCommand<SignatureReport>("verify_download_signature", { path: pkg.path });
      set({ signature });
      if (signature.status !== "verified") {
        set({
          phase: "failed",
          activity: null,
          error: `回退包的签名校验未通过，已中止。${signature.message}\n${describeSignature(signature)}`,
        });
        return;
      }

      // allowDowngrade 只在回退路径上传：默认的「一键更新」保持严格，
      // Windows 仍然会拒绝一个比当前低的版本。
      const installResult = await invokeCommand<InstallResult>("install_codex", {
        path: pkg.path,
        allowDowngrade: true,
      });
      const status = await invokeCommand<HealthReport>("get_status").catch(() => get().status);
      set({ installResult, status, phase: "done", activity: null, healthDetail: null });
    } catch (error) {
      set({ phase: "failed", activity: null, error: describe(error) });
    } finally {
      // rollingBack 必须清：漏清就是主按钮永久置灰，用户只能重启应用。
      set({ rollingBack: false });
      void get().refreshCachedPackages();
    }
  },

  checkUpdate: async () => {
    // checkingUpdate 必须用 finally 清掉：中途失败时若漏清，整个界面会永久锁死
    // ——按钮全灰、什么都不能点，用户只能重启应用。
    set({ checkingUpdate: true, error: null, notice: null });
    try {
      const update = await invokeCommand<UpdateReport>("check_update", {
        downloadDirectory: get().settings?.downloadDirectory ?? "",
      });
      set({
        update,
        notice:
          update.updateAvailable === false
            ? `已是最新版本${update.installedVersion ? `（${update.installedVersion}）` : ""}`
            : `发现新版本 ${update.availableVersion}`,
      });
    } catch (error) {
      set({ error: describe(error) });
    } finally {
      set({ checkingUpdate: false });
    }
  },

  /** 健康自检带窗口探测：会真正启动 Codex 并等主窗口出现，能直接复现「无窗口」故障。 */
  runHealthProbe: async () => {
    set({ probing: true, error: null, notice: null });
    try {
      const healthDetail = await invokeCommand<HealthReport>("check_health", { probe: true });
      // 这次探测比「打开 Codex」留下的那次更新，旧结论要撤掉。
      // 无窗口这一档由健康面板自己的判定说明承担；通用资源修复横幅只看
      // status.repairTargets（未完成的物化残留），跟这次探测没关系。
      set({ healthDetail, status: healthDetail, launchResult: null });
    } catch (error) {
      set({ error: describe(error) });
    } finally {
      set({ probing: false });
    }
  },

  runRepair: async () => {
    set({ repairing: true, error: null, notice: null, activity: startActivity("repair", "正在重建资源副本") });
    try {
      await invokeCommand<{ ok: boolean }>("repair_bundles");
      const healthDetail = await invokeCommand<HealthReport>("check_health", { probe: false }).catch(() => null);
      // 修复完把「窗口没出现」的横幅撤掉：那条结论描述的是修复之前的状态。
      set({ repairing: false, activity: null, healthDetail, status: healthDetail ?? get().status, launchResult: null });
      set({ notice: "资源副本已重建，可以再试一次启动 Codex" });
    } catch (error) {
      set({ repairing: false, activity: null, error: describe(error) });
    }
  },

  /**
   * 打开 Codex。
   *
   * 主进程会等主窗口出现再回话（脚本基础 20 秒，判定「还在落运行时缓存」时会再延长
   * 最多 150 秒），所以这里必须给出进展：否则等待期间界面上什么都没变，用户看到的
   * 就是「点了没反应」。结果分三种，都如实呈现：
   *   - 窗口出现 → 提示已启动；
   *   - 进程起来了但没窗口 → 由脚本按证据给出判定（还在准备 / 就是那个搬迁 bug /
   *     判不出来），界面照判定给文案，只有确实是搬迁 bug 才给修复入口；
   *   - 根本没装 → 报错。
   */
  launch: async () => {
    set({
      phase: "working",
      error: null,
      notice: null,
      launchResult: null,
      installResult: null,
      activity: startActivity("launch", "正在启动 Codex"),
    });

    try {
      const result = await invokeCommand<LaunchResult>("launch_codex");
      set({
        launchResult: result,
        phase: "done",
        activity: null,
        // 启动时顺带做了一次带窗口探测的健康自检，结果直接拿来刷新面板，
        // 省掉用户再点一次「健康自检」。
        status: result.health ?? get().status,
        healthDetail: result.health ?? get().healthDetail,
        notice: result.ok ? `Codex 已启动${result.version ? `（${result.version}）` : ""}` : null,
      });
    } catch (error) {
      set({ phase: "failed", activity: null, error: describe(error) });
    }
  },

  saveDownloadDirectory: async (value) => {
    try {
      await invokeCommand<Settings>("save_settings", { downloadDirectory: value });
      const settings = await invokeCommand<Settings>("get_settings");
      set({ settings });
      // 换了缓存目录，「版本历史」列的还是旧目录里的包 —— 必须跟着刷新。
      // 否则用户改完目录看到的是一份对不上的清单，回退按钮指向的文件也不在新目录里。
      await get().refreshCachedPackages();
    } catch (error) {
      set({ error: describe(error) });
    }
  },

  pickDirectory: async () => {
    try {
      const result = await invokeCommand<{ canceled: boolean; path?: string }>("pick_directory");
      if (!result.canceled && result.path) await get().saveDownloadDirectory(result.path);
    } catch (error) {
      set({ error: describe(error) });
    }
  },

  openPath: async (path) => {
    try {
      await invokeCommand("open_path", { path });
    } catch (error) {
      set({ error: describe(error) });
    }
  },

  openStorageSettings: async () => {
    try {
      await invokeCommand("open_storage_settings");
    } catch (error) {
      set({ error: describe(error) });
    }
  },

  /** 合并主进程推来的进度事件。 */
  applyProgress: (event) => {
    if (event.kind === "download-bytes") {
      set((state) => {
        const activity = state.activity ?? startActivity("download", "正在下载安装包");
        // 总字节数无从得知，所以不编造百分比，界面改用不确定进度条 + 已下载量。
        return {
          activity: { ...activity, id: "download", indeterminate: true, bytes: event.bytes, elapsedMs: event.elapsedMs },
        };
      });
      return;
    }

    if (event.kind === "log") {
      set((state) => {
        if (!state.activity) return {};
        const logs = [...state.activity.logs, { line: event.line, at: event.at }].slice(-MAX_LOG_LINES);
        return { activity: { ...state.activity, logs } };
      });
      return;
    }

    if (event.kind === "warning") {
      set((state) => (state.activity ? { activity: { ...state.activity, warning: event.message } } : {}));
      return;
    }

    // kind === "phase"
    set((state) => {
      const switching = !state.activity || state.activity.id !== event.id;
      const base = switching ? startActivity(event.id, event.label) : state.activity!;
      // 同一阶段内允许爬升，但绝不回退：日志静默期的爬升与真实里程碑可能交错到达。
      const percent = Math.max(base.percent, event.percent);
      return {
        activity: {
          ...base,
          label: event.label,
          percent,
          warning: event.warning ? event.label : base.warning,
          // 阶段事件总是带一个真实的里程碑百分比，所以退出不确定态；
          // 下载阶段随后的 download-bytes 事件会把它重新置为不确定（总字节数未知）。
          indeterminate: false,
        },
      };
    });
  },

  dismissNotice: () => set({ notice: null }),

  reset: () =>
    set({
      phase: "ready",
      update: null,
      signature: null,
      activity: null,
      installResult: null,
      launchResult: null,
      healthDetail: null,
      error: null,
      notice: null,
    }),
}));

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 签名校验失败时的那几行细节。
 *
 * 发布者两边都写出来：不一致才是要查的问题，只报一个「发布者」等于没说。
 * 但两边相同时不重复写 —— 那是「签名无效」，多一行没有信息量的重复反而挡住重点。
 */
function describeSignature(signature: SignatureReport): string {
  const lines = [`发布者：${signature.publisher}`, `状态：${signature.authenticode}`];
  if (signature.expectedPublisher && signature.expectedPublisher !== signature.publisher) {
    lines.push(`预期发布者：${signature.expectedPublisher}`);
  }
  return lines.join("\n");
}

/** 在应用启动时订阅一次主进程进度推送。 */
export function connectProgress(): () => void {
  return subscribeProgress((event) => useAppStore.getState().applyProgress(event));
}
