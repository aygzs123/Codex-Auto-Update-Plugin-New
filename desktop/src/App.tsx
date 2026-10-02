import { useEffect } from "react";
import { AdvancedSettings } from "./components/AdvancedSettings";
import { ActivityPanel } from "./components/ActivityPanel";
import { BackgroundSettings } from "./components/BackgroundSettings";
import { CacheSettings } from "./components/CacheSettings";
import { HealthPanel } from "./components/HealthPanel";
import { NoticeDialog } from "./components/NoticeDialog";
import { TitleBar } from "./components/TitleBar";
import { VersionHistory } from "./components/VersionHistory";
import { isElectronRuntime, subscribeMenuAction } from "./lib/bridge";
import { diagnosisCopy } from "./lib/diagnosis";
import { formatClock, healthComponentText, healthOverallText } from "./lib/format";
import { connectBackgroundCheck, connectProgress, effectiveDownloadDirectory, isCommandRunning, useAppStore } from "./state/app";

/** 会真正跑一条命令的菜单动作。打开目录、复制诊断都不算 —— 它们瞬间返回，永远不冲突。 */
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
    case "copy-diagnostics":
      // 即时动作，不列入 COMMAND_ACTIONS：同事报障时点它的时机恰恰是安装刚失败的那一刻，
      // 那时候界面正忙，把它一起禁掉就等于在最需要的时候不可用。
      void store.copyDiagnostics();
      break;
    case "quit":
      void window.desktop?.window.quit();
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
    "从 Microsoft Store 官方分发源获取最新版本，校验 OpenAI 签名后自动安装并启动。不会改动你已有的 Codex 配置；若该版本声明了 Windows 服务，安装时会弹一次 UAC 授权。";

  if (phase === "checking") {
    title = "正在检查 Codex 状态";
    lede = "读取已安装的版本与启动所需资源。";
  } else if (installed) {
    title = `已安装 ${version ?? "Codex"}`;
    lede = healthOverallText(status?.overall) ?? "读取到本机已安装的 Codex Desktop。";
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
  // 「进程起来了、窗口没出现」是要如实报出来的**事实**，但它不说明原因：可能还在落
  // 运行时缓存、可能是官方那个搬迁 bug、也可能判不出来。文案与「要不要给修复入口」
  // 一律走 diagnosisCopy（唯一映射表），这里不再自己下结论。
  const launchWindowMissing = launchResult ? !launchResult.windowVisible : false;
  const installDiagnosis = diagnosisCopy(installResult?.startupDiagnosis);
  const launchDiagnosis = diagnosisCopy(launchResult?.startupDiagnosis);
  // 资源修复横幅只认「有未完成的物化残留」（repairTargets，主进程算好的）。不跟
  // status.needsRepair 走：那个还含着「窗口没出现」那条探针分支，而那一档由健康面板
  // 自己的判定说明 + 常驻的修复按钮承担，再弹一张横幅就是把同一件事说两遍。
  const repairTargets = status?.repairTargets ?? [];
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
            安装本身已成功，但启动后等待期内没有出现主窗口。
            <strong>{installDiagnosis.title}。</strong>
            {installDiagnosis.body}
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
          {/* 装完了，Codex 自己也起来了，更新器留着没有意义 —— 给一个明确的收尾动作，
              而不是让用户去右上角找那个 ×（开着托盘常驻时那个 × 还只是把它藏起来）。 */}
          <div className="dash-actions">
            <button type="button" className="button" onClick={() => runAction("quit")}>
              关闭更新器
            </button>
          </div>
        </section>
      )}

      {launchWindowMissing && (
        <section className="panel warn-card">
          <h3>Codex 进程已启动，但主窗口没有出现</h3>
          <p>
            <strong>{launchDiagnosis.title}。</strong>
            启动请求已经发出，Codex 的进程也确实在运行{launchResult?.version ? `（${launchResult.version}）` : ""}
            ，但等待期内没有出现主窗口。{launchDiagnosis.body} 原始诊断见下方「健康诊断」。
          </p>
          <div className="dash-actions">
            {launchDiagnosis.showRepair && (
              <button type="button" className="button" disabled={busy} onClick={() => void runRepair()}>
                {repairing ? "正在重建资源副本…" : "修复资源副本并重新启动"}
              </button>
            )}
            {rollbackButton}
          </div>
        </section>
      )}

      {!installResult && !launchWindowMissing && repairTargets.length > 0 && status?.installed && (
        <section className="panel warn-card">
          <h3>资源副本留有未完成的物化痕迹</h3>
          {/* 三行是三个模板字符串，不是三个 JSX 文本行：JSX 会把换行折成一个空格，
              中文句子里会冒出「WSL 命令行工具 的目标目录」这种空格。
              相邻的两个 {} 之间的换行会被整段丢掉，所以这样拼出来是严丝合缝的一句。 */}
          <p>
            {`${repairTargets.map((name) => healthComponentText(name)).join("、")}的目标目录不存在，但目录下留着复制用的中转目录（.staging / .repair）——`}
            {`可能是一次正在进行的物化，也可能是上一次没跑完。如果 Codex 能正常打开，这份残留不影响使用；`}
            {`如果 Codex 确实打不开，可以运行下面的「修复资源副本」重建。`}
          </p>
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
    clearingCache,
    error,
    notice,
    settings,
    cachedPackages,
    lastCheckAt,
    bootstrap,
    oneClick,
    checkUpdate,
    rollback,
    runHealthProbe,
    runRepair,
    launch,
    pickDirectory,
    saveDownloadDirectory,
    saveOptions,
    clearCache,
    copyDiagnostics,
    openPath,
    openStorageSettings,
    dismissNotice,
  } = useAppStore();

  useEffect(() => {
    void bootstrap();
    const offProgress = connectProgress();
    const offMenu = subscribeMenuAction(runAction);
    // 后台常驻时主进程每 6 小时敲一次；走的是启动那条同样的静默检查，不新增第二条路径。
    const offBackground = connectBackgroundCheck();
    return () => {
      offProgress();
      offMenu();
      offBackground();
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

  // 「上次检查 14:32」。查过才显示 —— 写「上次检查 --:--」还不如不写。
  const lastCheckClock = formatClock(lastCheckAt);

  // 「版本历史」卡片的显示开关。`!== false` 而不是真值判断：老配置文件里没有这个键，
  // 读出来是 undefined，那时必须显示（默认开），不能因为「假值」把卡片藏起来。
  const showVersionHistory = settings?.showVersionHistory !== false;
  const lastCheckLabel = lastCheckClock ? `上次检查 ${lastCheckClock}` : "";

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
            {/* .build 与 .last-check 必须是兄弟节点，不能再往里嵌一层：
                .window-head 是 space-between，直接加第三个孩子会把 .build 挤到中间，
                所以两者一起包进 .head-meta。 */}
            <span className="head-meta">
              <span className="build">
                {status?.installed ? `已安装 ${status.version ?? "未知版本"}` : "未安装"}
                {upToDate ? " · 已是最新" : ""}
                {availableVersion && update?.updateAvailable ? ` · 可更新到 ${availableVersion}` : ""}
                {/* 启动那次自动检查要跑好几秒，期间顶栏什么都不说，用户不知道它在忙。
                    只能写纯文本，不能在这里嵌 <span>（有测试按非贪婪正则切这段）。 */}
                {checkingUpdate ? " · 正在检查…" : ""}
              </span>
              {lastCheckLabel && <span className="last-check">{lastCheckLabel}</span>}
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

            <CacheSettings
              settings={settings}
              cachedPackages={cachedPackages}
              // 和「版本历史」卡片、worker 剪枝用的是同一个目录，判据只在 store 里。
              cacheDirectory={effectiveDownloadDirectory({ settings, cachedPackages })}
              busy={busy}
              clearingCache={clearingCache}
              onPick={() => void pickDirectory()}
              onResetDirectory={() => void saveDownloadDirectory("")}
              onOpen={(path) => void openPath(path)}
              onToggleVersionHistory={(next) => void saveOptions({ showVersionHistory: next })}
              onClearCache={() => void clearCache()}
            />

            <AdvancedSettings
              settings={settings}
              // 安装位置取健康检查里那份真实路径（可能不在 C 盘）。健康自检刚跑过时
              // 以它为准，否则用启动时那份状态。
              installLocation={(healthDetail ?? status)?.installLocation ?? null}
              cacheDirectory={effectiveDownloadDirectory({ settings, cachedPackages })}
              onOpen={(path) => void openPath(path)}
              onOpenStorageSettings={() => void openStorageSettings()}
              onCopyDiagnostics={() => void copyDiagnostics()}
            />

            <BackgroundSettings
              settings={settings}
              onToggle={(key, value) => void saveOptions({ [key]: value })}
            />

            {/* 可以整张关掉（开关在「安装包缓存」里，默认显示）。关掉的只是这张卡片，
                缓存里的安装包、以及失败告警里的回退入口都不受影响。 */}
            {showVersionHistory && (
              <VersionHistory
                cachedPackages={cachedPackages}
                cacheDirectory={effectiveDownloadDirectory({ settings, cachedPackages })}
                busy={busy}
                rollingBack={rollingBack}
                onRollback={(pkg) => void rollback(pkg)}
                onOpenDirectory={(path) => void openPath(path)}
              />
            )}

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
