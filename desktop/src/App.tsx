import { useEffect } from "react";
import { AdvancedSettings } from "./components/AdvancedSettings";
import { ActivityPanel } from "./components/ActivityPanel";
import { HealthPanel } from "./components/HealthPanel";
import { NoticeDialog } from "./components/NoticeDialog";
import { TitleBar } from "./components/TitleBar";
import { VersionHistory } from "./components/VersionHistory";
import { isElectronRuntime, subscribeMenuAction } from "./lib/bridge";
import { connectProgress, effectiveDownloadDirectory, isCommandRunning, useAppStore } from "./state/app";

const OVERALL_TEXT: Record<string, string> = {
  ok: "启动所需资源完整",
  degraded: "部分资源缺失，可能无法正常启动",
  "not-installed": "尚未安装",
};

/** 会真正跑一条命令的菜单动作。打开目录不算 —— 它只是弹个资源管理器，永远秒回。 */
const COMMAND_ACTIONS = new Set(["check", "install", "launch", "health", "repair"]);

/**
 * 菜单动作的唯一入口：窗口内菜单和主进程原生菜单都走这里，避免两套行为漂移。
 * 定义在模块作用域，因为它只在事件触发时读取 store，不需要订阅渲染。
 */
function runAction(action: string) {
  const store = useAppStore.getState();
  // 这才是真正的闸门。按钮置灰只能拦住鼠标 —— 原生菜单的 Ctrl+R / Ctrl+I 是主进程
  // 直接发过来的，根本不经过 DOM，那两颗键照样能在安装途中再塞一条命令进来。
  if (COMMAND_ACTIONS.has(action) && isCommandRunning(store)) return;
  switch (action) {
    case "check":
      void store.checkUpdate();
      break;
    case "install":
      void store.oneClick();
      break;
    case "launch":
      void store.launch();
      break;
    case "health":
      void store.runHealthProbe();
      break;
    case "repair":
      void store.runRepair();
      break;
    case "open-logs":
      void store.openPath(store.settings?.logsDirectory ?? "");
      break;
    case "open-cache":
      // 不能读 defaultDownloadDirectory：用户自定义过缓存目录时，那颗按钮会打开
      // 一个空的默认目录，而安装包在别处。判据统一走 effectiveDownloadDirectory。
      void store.openPath(effectiveDownloadDirectory(store));
      break;
    case "minimize":
      void window.desktop?.window.minimize();
      break;
    case "maximize":
      void window.desktop?.window.maximize();
      break;
    case "close":
      void window.desktop?.window.close();
      break;
  }
}

function Hero({ onPrimary, onSecondary, primaryLabel, secondaryLabel, busy }: {
  onPrimary: () => void;
  onSecondary?: () => void;
  primaryLabel: string;
  secondaryLabel?: string;
  busy: boolean;
}) {
  const { phase, status } = useAppStore();
  const installed = status?.installed ?? false;
  const version = status?.version ?? null;

  let title = "一键安装 Codex Desktop";
  let lede =
    "从 Microsoft Store 官方分发源获取最新版本，校验 OpenAI 签名后自动安装并启动。不需要管理员权限，也不会改动你已有的 Codex 配置。";

  if (phase === "checking") {
    title = "正在检查 Codex 状态";
    lede = "读取已安装的版本与启动所需资源。";
  } else if (installed) {
    title = `已安装 ${version ?? "Codex"}`;
    lede = OVERALL_TEXT[status?.overall ?? ""] ?? "读取到本机已安装的 Codex Desktop。";
  }

  return (
    <section className="panel hero-card">
      <p className="eyebrow">{installed ? "Installed" : "One-click Setup"}</p>
      <h1>{title}</h1>
      <p className="lede">{lede}</p>
      <div className="cta-row">
        <button type="button" className="button primary large" disabled={busy} onClick={onPrimary}>
          {primaryLabel}
        </button>
        {secondaryLabel && onSecondary && (
          <button type="button" className="button" disabled={busy} onClick={onSecondary}>
            {secondaryLabel}
          </button>
        )}
      </div>
    </section>
  );
}

function ResultBanners() {
  const { installResult, launchResult, signature, status, repairing, rollingBack, cachedPackages, runRepair, rollback } =
    useAppStore();
  // 用共享判据而不是本地的 repairing：修复途中主按钮同样要点不动，
  // 否则「修复资源副本并重新启动」和「一键安装」能叠在一起跑。
  const busy = useAppStore(isCommandRunning);
  // 「进程起来了、窗口没出现」是官方已知故障，不是「点了没反应」——
  // 必须把结论和补救入口一起摆出来，否则用户只能看到屏幕上什么都没有。
  const launchWindowMissing = launchResult ? !launchResult.windowVisible : false;
  const repairNeeded = installResult?.windowMissing || status?.needsRepair;
  // 「刚更新完就出问题」正是回退功能要救的场景，所以失败告警里直接给回退按钮，
  // 而不是让用户自己去下面的「版本历史」里找。没有可退的包时按钮不出现。
  const rollbackTarget = cachedPackages?.packages.find((pkg) => pkg.relation === "older") ?? null;
  const rollbackButton = rollbackTarget && (
    <button type="button" className="button" disabled={busy} onClick={() => void rollback(rollbackTarget)}>
      {rollingBack ? "正在回退…" : `回退到 ${rollbackTarget.version}`}
    </button>
  );

  return (
    <>
      {signature && (
        <section className="panel signature-summary">
          <span className={`signature-status ${signature.status}`}>{signature.message}</span>
          <div className="signature-grid">
            <div className="signature-row">
              <span>发布者</span>
              <strong>{signature.publisher}</strong>
            </div>
            {signature.expectedPublisher && signature.expectedPublisher !== signature.publisher && (
              <div className="signature-row">
                <span>预期发布者</span>
                <strong>{signature.expectedPublisher}</strong>
              </div>
            )}
            <div className="signature-row">
              <span>数字签名</span>
              <strong>{signature.authenticode}</strong>
            </div>
            <div className="signature-row">
              <span>SHA-256</span>
              <strong className="mono">{signature.sha256}</strong>
            </div>
          </div>
        </section>
      )}

      {installResult?.windowMissing && (
        <section className="panel warn-card">
          <h3>Codex 已安装，但主窗口没有出现</h3>
          <p>
            安装本身已成功，但启动后等待期内没有出现主窗口。这是官方已知的加密资源搬迁问题的特征，
            用下面的「修复资源副本」重建用户目录下的资源副本即可。
          </p>
          {installResult.remedy && <pre className="raw-output">{installResult.remedy}</pre>}
          {rollbackTarget && (
            <p className="field-help">
              如果问题正是这次更新带来的，可以直接退回到上一版（{rollbackTarget.version}）。
            </p>
          )}
          {rollbackButton}
        </section>
      )}

      {installResult?.ok && !installResult.windowMissing && (
        <section className="panel ok-card">
          <h3>安装完成{installResult.version ? ` · ${installResult.version}` : ""}</h3>
          <p>Codex 已经安装并启动完成。之后可以随时回到这个窗口检查更新或运行健康诊断。</p>
        </section>
      )}

      {launchWindowMissing && (
        <section className="panel warn-card">
          <h3>Codex 进程已启动，但主窗口没有出现</h3>
          <p>
            启动请求已经发出，Codex 的进程也确实在运行{launchResult?.version ? `（${launchResult.version}）` : ""}
            ，但等待期内没有出现主窗口。这是官方已知的加密资源搬迁问题的特征：安装包里的加密资源
            没能复制到用户目录，启动流程卡在窗口出现之前。重建资源副本即可恢复，修复会先关闭正在运行的 Codex。
            详细诊断见下方「健康诊断」。
          </p>
          <div className="dash-actions">
            <button type="button" className="button" disabled={busy} onClick={() => void runRepair()}>
              {repairing ? "正在重建资源副本…" : "修复资源副本并重新启动"}
            </button>
            {rollbackButton}
          </div>
        </section>
      )}

      {!installResult && !launchWindowMissing && repairNeeded && status?.installed && (
        <section className="panel warn-card">
          <h3>检测到启动资源不完整</h3>
          <p>启动所需的资源副本有缺失或残留，Codex 可能无法正常打开窗口。建议运行下面的「修复资源副本」。</p>
        </section>
      )}
    </>
  );
}

export default function App() {
  const {
    phase,
    status,
    update,
    activity,
    healthDetail,
    probing,
    repairing,
    rollingBack,
    checkingUpdate,
    error,
    notice,
    settings,
    cachedPackages,
    bootstrap,
    oneClick,
    checkUpdate,
    rollback,
    runHealthProbe,
    runRepair,
    launch,
    pickDirectory,
    saveDownloadDirectory,
    openPath,
    openStorageSettings,
    dismissNotice,
  } = useAppStore();

  useEffect(() => {
    void bootstrap();
    const offProgress = connectProgress();
    const offMenu = subscribeMenuAction(runAction);
    return () => {
      offProgress();
      offMenu();
    };
  }, [bootstrap]);

  const working = phase === "working";
  // 真正的「有命令在跑」：含检查更新、健康自检、修复，不只是安装。所有触发命令的
  // 按钮都看它，判据只有 isCommandRunning 一处。
  const busy = useAppStore(isCommandRunning);
  const installed = status?.installed ?? false;
  const upToDate = installed && update?.updateAvailable === false;
  const availableVersion = update?.availableVersion ?? null;

  let primaryLabel = "一键安装 Codex";
  // 回退和安装共用 install 这条活动链路，所以文案要额外看一眼 rollingBack ——
  // 否则回退途中主按钮写着「正在安装…」，用户会以为点错了。
  if (working) primaryLabel = rollingBack ? "正在回退…" : activity?.id === "install" ? "正在安装…" : "正在准备…";
  else if (upToDate) primaryLabel = "打开 Codex";
  else if (installed && availableVersion) primaryLabel = `一键更新到 ${availableVersion}`;
  else if (installed) primaryLabel = "一键检查并更新";

  // 按钮置灰必须有个看得见的理由，否则就是「点了没反应」。检查更新期间文案换成
  // 「正在检查…」，用户就知道是自己在等，不是按钮坏了。
  const secondaryLabel = installed && !upToDate ? (checkingUpdate ? "正在检查…" : "仅检查更新") : undefined;

  const onPrimary = () => {
    if (upToDate) void launch();
    else void oneClick();
  };

  const desktopRuntime = isElectronRuntime();

  return (
    <div className="app-shell" data-phase={phase}>
      {/* 标题栏与交通灯放在滚动容器外面：否则往下滚就被内容顶走，
          既不像原生应用，也没法在滚动到底部时关掉窗口。 */}
      <TitleBar onAction={runAction} busy={busy} />

      <div className="app-scroll">
        <main className="window">
          <div className="window-head">
            <span className="window-title">
              <i />
              Codex Desktop
            </span>
            <span className="build">
              {status?.installed ? `已安装 ${status.version ?? "未知版本"}` : "未安装"}
              {availableVersion && update?.updateAvailable ? ` · 可更新到 ${availableVersion}` : ""}
            </span>
          </div>

          <div className="body">
            {!desktopRuntime && (
              <p className="error-text">当前不在桌面应用中运行，安装与诊断功能不可用。</p>
            )}

            <Hero
              onPrimary={onPrimary}
              onSecondary={installed && !upToDate ? () => void checkUpdate() : undefined}
              primaryLabel={primaryLabel}
              secondaryLabel={secondaryLabel}
              busy={busy}
            />

            {activity && <ActivityPanel activity={activity} />}

            <ResultBanners />

            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}

            <AdvancedSettings
              settings={settings}
              // 安装位置取健康检查里那份真实路径（可能不在 C 盘）。健康自检刚跑过时
              // 以它为准，否则用启动时那份状态。
              installLocation={(healthDetail ?? status)?.installLocation ?? null}
              // 和「版本历史」卡片、worker 剪枝用的是同一个目录，判据只在 store 里。
              cacheDirectory={effectiveDownloadDirectory({ settings, cachedPackages })}
              onPick={() => void pickDirectory()}
              onClear={() => void saveDownloadDirectory("")}
              onOpen={(path) => void openPath(path)}
              onOpenStorageSettings={() => void openStorageSettings()}
            />

            <VersionHistory
              cachedPackages={cachedPackages}
              cacheDirectory={effectiveDownloadDirectory({ settings, cachedPackages })}
              busy={busy}
              rollingBack={rollingBack}
              onRollback={(pkg) => void rollback(pkg)}
              onOpenDirectory={(path) => void openPath(path)}
            />

            <HealthPanel
              health={healthDetail ?? status}
              probing={probing}
              repairing={repairing}
              busy={busy}
              onProbe={() => void runHealthProbe()}
              onRepair={() => void runRepair()}
            />
          </div>
        </main>
      </div>

      {notice && <NoticeDialog message={notice} onClose={dismissNotice} />}
    </div>
  );
}
