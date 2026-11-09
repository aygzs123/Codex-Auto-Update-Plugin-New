import { useEffect, useRef, useState } from "react";
import { AdvancedSettings } from "./components/AdvancedSettings";
import { ActivityPanel } from "./components/ActivityPanel";
import { BackgroundSettings } from "./components/BackgroundSettings";
import { CacheSettings } from "./components/CacheSettings";
import { HealthPanel } from "./components/HealthPanel";
import { Icon, Logo } from "./components/Icons";
import { NoticeDialog } from "./components/NoticeDialog";
import { RecentActivity } from "./components/RecentActivity";
import { Sidebar, type ViewId } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { VersionHistory } from "./components/VersionHistory";
import { isElectronRuntime, subscribeMenuAction } from "./lib/bridge";
import { diagnosisCopy } from "./lib/diagnosis";
import {
  formatBytes,
  formatClock,
  healthComponentText,
  healthOverallText,
  healthStateText,
} from "./lib/format";
import { connectBackgroundCheck, connectProgress, effectiveDownloadDirectory, isCommandRunning, useAppStore } from "./state/app";

/** 会真正跑一条命令的动作。打开目录、复制诊断都不算 —— 它们瞬间返回，永远不冲突。 */
const COMMAND_ACTIONS = new Set(["check", "install", "launch", "health", "repair"]);

/**
 * 动作的唯一入口：页面按钮、原生菜单快捷键（Ctrl+R / Ctrl+I）都走这里，避免两套行为漂移。
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

/**
 * 版本仪表：把「当前装的」和「分发源上的」并排放。
 *
 * 主区大字回答的是「要不要点那颗按钮」，仪表回答的是「差在哪两版之间」。
 * 查询还没回来时，右侧节点是骨架而不是编出来的版本号 —— 一个猜出来的「已是最新」
 * 比一个明确说「正在查」的占位更糟。
 */
function VersionInstrument({
  phase,
  installed,
  version,
  upToDate,
  availableVersion,
  checkingUpdate,
}: {
  phase: string;
  installed: boolean;
  version: string | null;
  upToDate: boolean;
  availableVersion: string | null;
  checkingUpdate: boolean;
}) {
  const checking = phase === "checking";
  const pending = checking || checkingUpdate;
  const currentLabel = installed ? version ?? "未知版本" : "未安装";

  let nextLabel = "待查询";
  let nextTone = "";
  let foot = "安装前校验签名";
  let footTone = "";
  let footIcon: "shield" | "check" | "download" | "refresh" = "shield";

  if (checking) {
    foot = "正在读取本机状态";
    footTone = "accent";
    footIcon = "refresh";
  } else if (!installed) {
    nextLabel = "最新版本";
    nextTone = "next";
    foot = "安装前校验签名";
  } else if (upToDate) {
    nextLabel = "已是最新";
    nextTone = "ok";
    foot = "签名通过 · 已是最新";
    footTone = "green";
    footIcon = "check";
  } else if (availableVersion) {
    nextLabel = availableVersion;
    nextTone = "next";
    foot = "安装前校验签名";
  } else if (pending) {
    // 上一条 checking 分支已经吃掉「还在读本机」，走到这里 pending 只剩 checkingUpdate。
    foot = "正在查询分发源…";
    footTone = "accent";
    footIcon = "refresh";
  }

  return (
    <aside className="instrument" aria-label="版本状态">
      <div className="inst-head">
        <span className="inst-title">版本状态</span>
        <span className={`pill`} data-tone={upToDate ? "green" : availableVersion ? "accent" : "gray"}>
          <span className={`pdot ${pending ? "pulse" : ""}`} />
          {checking ? "读取本机" : upToDate ? "最新" : availableVersion ? "有新版" : "待检查"}
        </span>
      </div>
      <div className="inst-flow">
        <div className={`inst-node ${upToDate ? "ok" : ""}`}>
          <span className="k">当前</span>
          <span className="v" title={currentLabel}>{currentLabel}</span>
        </div>
        <Icon name="chevron" size={13} className="inst-arrow" />
        <div className={`inst-node ${nextTone} ${pending && !upToDate && !availableVersion ? "pending" : ""}`}>
          <span className="k">{upToDate ? "状态" : "分发源"}</span>
          {pending && !upToDate && !availableVersion ? (
            <span className="skeleton" />
          ) : (
            <span className="v" title={nextLabel}>{nextLabel}</span>
          )}
        </div>
      </div>
      <div className={`inst-foot ${footTone}`}>
        <Icon name={footIcon} size={12} />
        {foot}
      </div>
    </aside>
  );
}

function Hero({
  onPrimary,
  onSecondary,
  primaryLabel,
  secondaryLabel,
  busy,
  upToDate,
  availableVersion,
  lastCheckLabel,
}: {
  onPrimary: () => void;
  onSecondary?: () => void;
  primaryLabel: string;
  secondaryLabel?: string;
  busy: boolean;
  /**
   * 更新结论，由父组件算好传进来（和顶栏、主按钮同一处判据）。
   *
   * 刻意不让这里自己从 update 里再算一遍：判据分家就会自相矛盾 —— 顶上写着「已是最新」、
   * 主区写着「可更新到」，而用户没有任何办法判断哪个是真的。
   */
  upToDate: boolean;
  availableVersion: string | null;
  lastCheckLabel: string;
}) {
  const { phase, status, checkingUpdate } = useAppStore();
  const installed = status?.installed ?? false;
  const version = status?.version ?? null;

  let title = "一键安装 Codex Desktop";
  let lede =
    "从 Microsoft Store 官方分发源获取最新版本，校验 OpenAI 签名后自动安装并启动。不会改动你已有的 Codex 配置；若该版本声明了 Windows 服务，安装时会弹一次 UAC 授权。";

  if (phase === "checking") {
    // 启动分两段：先只读本机（这一步，`Get-AppxPackage` + 资源清单，不走网络），再联网查最新版。
    // 这一段快得一闪而过，界面空白期又恰好是最容易让人以为「卡住了」的时候，所以文案一次说清
    // 三件事：在读什么、读的是哪儿、接下来还有一步。用户原话：「读取本机的时候应该给一下更好
    // 的提示吧，不然不知道」——说不清，用户看到的就是界面从空白直接蹦出一个版本号。
    title = "正在读取本机状态";
    lede = "查已安装的版本、装在哪个盘、启动所需资源是否齐全。这一步只读本机，不联网。";
  } else if (installed) {
    // 主区这行大字是全页最显眼的一处，它要回答的是**「我是不是最新版」**——用户接着要做
    // 的决定（点不点那颗按钮）取决于它，而「装没装」顶栏那行已经说过了。这里原先只写
    // 「已安装 X」、副标题再补一句资源自检结论，于是最显眼的两行字里一个更新结论都没有，
    // 得往上看那行小字才知道（用户原话：「第一次检测后显示的已安装 26.930.2377.0
    // 启动所需资源完整 不太对吧，应该显示已是最新版：xxx」）。
    //
    // 资源自检结论留在副标题里：它回答的是另一个问题（这台机器上的 Codex 能不能正常起来），
    // degraded 时是必须看见的信号，不该因为标题换了就丢掉 —— 只是它不再是主区的主角。
    const health = healthOverallText(status?.overall) ?? "读取到本机已安装的 Codex Desktop。";
    if (upToDate) {
      title = `已是最新版：${version ?? "Codex"}`;
      lede = health;
    } else if (availableVersion) {
      // 有新版时两个版本号都要在：标题给结论（可更新到哪一版），副标题交代现在装的是哪一版。
      title = `可更新到 ${availableVersion}`;
      lede = `当前已安装 ${version ?? "未知版本"}。${health}`;
    } else if (checkingUpdate) {
      // 本机已经读完了、更新结论还在网络上飞。这几秒里主区大字写着「已安装 X」—— 一个看起来
      // 已经定稿的答案，用户看到的就是「先给了个版本号，然后才进入检测」，中间发生过什么没人
      // 交代（用户原话：「顶栏显示了版本号，然后再进入检测判断是不是最新版本」）。本地这两项
      // 确实是现成的，照常给；把在飞的那一步接在后面，让它自己声明「还没查完」。
      title = `已安装 ${version ?? "Codex"}`;
      lede = `${health} · 正在向 Microsoft Store 分发源查询最新版本…`;
    } else {
      // 结论还没回来（没查 / 查失败）时才退回「已安装 X」—— 这时候确实没有结论可说，
      // 编一个「已是最新」比什么都不说更糟。
      title = `已安装 ${version ?? "Codex"}`;
      lede = health;
    }
  }

  const tone = phase === "checking" ? "gray" : upToDate ? "green" : availableVersion ? "accent" : installed ? "green" : "accent";

  return (
    <section className="panel hero-card hero" data-tone={tone}>
      <div className="hero-main">
        <div className="hero-copy">
          <div className="hero-identity">
            <Logo size={46} />
            <div>
              <p className="eyebrow">
                {/* 这枚小标题也必须跟着阶段走。启动第一段还没拿到 status，按老写法会掉到
                    「One-click Setup」——标题正说着「正在读取本机状态」，小标题却在承诺一键安装，
                    两句话互相拆台。 */}
                {phase === "checking"
                  ? "Local check"
                  : upToDate
                    ? "Up to date"
                    : installed
                      ? "Installed"
                      : "One-click Setup"}
              </p>
              <span className="hero-brand">Codex Desktop</span>
            </div>
          </div>
          <h1>{title}</h1>
          <p className="lede">{lede}</p>
          <div className="cta-row hero-actions">
            <button
              type="button"
              className="button primary large"
              disabled={busy}
              title={busy ? "有命令正在执行，等它结束再操作" : undefined}
              onClick={onPrimary}
            >
              {primaryLabel}
            </button>
            {secondaryLabel && onSecondary && (
              <button
                type="button"
                className="button large"
                disabled={busy}
                title={busy ? "有命令正在执行，等它结束再操作" : undefined}
                onClick={onSecondary}
              >
                {secondaryLabel}
              </button>
            )}
          </div>
        </div>
        <VersionInstrument
          phase={phase}
          installed={installed}
          version={version}
          upToDate={upToDate}
          availableVersion={availableVersion}
          checkingUpdate={checkingUpdate}
        />
      </div>
      <div className="hero-meta">
        <span>
          <Icon name="clock" size={12} />
          {lastCheckLabel || "尚未检查更新"}
        </span>
        <span>
          <Icon name="monitor" size={12} />
          Microsoft Store 分发源
        </span>
        <span>
          <Icon name="box" size={12} />
          Windows · x64
        </span>
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
        <section className="panel signature-summary card">
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
            ，但等待期内没有出现主窗口。{launchDiagnosis.body} 原始诊断见「诊断」页。
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
            {`如果 Codex 确实打不开，可以运行「诊断」页的「修复资源副本」重建。`}
          </p>
        </section>
      )}
    </>
  );
}

export default function App() {
  const [view, setView] = useState<ViewId>("overview");
  // 四页共用同一个滚动容器。切换页面时拉回顶部：否则从设置页底部点回概览，
  // 会停在新页面的半截上，看起来像少了一块内容。
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [view]);
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
    openInstallLocation,
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

  // 桌面端的键盘滚动。内容区是 .app-scroll 这个独立滚动容器，body 本身是
  // overflow:hidden —— 默认的 PageDown / Home / End 滚的是文档，等于按了没反应。
  // 焦点在输入框里时不抢键；对话框打开时它属于对话框，不许滚动背景。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (useAppStore.getState().notice) return;
      const scroller = scrollRef.current;
      if (!scroller) return;
      const page = Math.max(120, Math.round(scroller.clientHeight * 0.85));
      if (event.key === "PageDown") {
        scroller.scrollBy({ top: page });
        event.preventDefault();
      } else if (event.key === "PageUp") {
        scroller.scrollBy({ top: -page });
        event.preventDefault();
      } else if (event.key === "Home") {
        scroller.scrollTo({ top: 0 });
        event.preventDefault();
      } else if (event.key === "End") {
        scroller.scrollTo({ top: scroller.scrollHeight });
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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

  const health = healthDetail ?? status;
  const components = health?.components ?? [];
  const okCount = components.filter((component) => component.state === "ok").length;
  const healthTone: "green" | "orange" | "gray" = !health?.installed
    ? "gray"
    : health.overall === "ok"
      ? "green"
      : "orange";
  const statusLabel = !health?.installed
    ? "尚未安装"
    : health.overall === "ok"
      ? "资源完整"
      : health.overall === "degraded"
        ? "部分资源缺失"
        : "无法判定";

  const cacheDirectory = effectiveDownloadDirectory({ settings, cachedPackages });
  const cacheCount = cachedPackages?.packages.length ?? 0;
  const cacheBytes = (cachedPackages?.packages ?? []).reduce((sum, pkg) => sum + (pkg.sizeBytes || 0), 0);
  const cacheUsage = cachedPackages ? `${cacheCount} 个 · ${formatBytes(cacheBytes)}` : "占用未知";
  const installLocation = health?.installLocation ?? null;
  const rollbackCount = (cachedPackages?.packages ?? []).filter(
    (pkg) => pkg.relation === "older" || pkg.relation === "installed",
  ).length;

  const chipTone: "green" | "accent" | "orange" | "gray" =
    phase === "checking" || checkingUpdate
      ? "accent"
      : !installed
        ? "gray"
        : upToDate
          ? "green"
          : availableVersion
            ? "orange"
            : "gray";

  const statusSlot = (
    <>
      <span className="status-chip" data-tone={chipTone} title={lastCheckLabel || undefined}>
        <span className={`dot ${phase === "checking" || checkingUpdate ? "pulse" : ""}`} />
        <span className="build">
          {status?.installed ? `已安装 ${status.version ?? "未知版本"}` : "未安装"}
          {upToDate ? " · 已是最新" : ""}
          {availableVersion && update?.updateAvailable ? ` · 可更新到 ${availableVersion}` : ""}
          {checkingUpdate ? " · 正在检查…" : ""}
        </span>
      </span>
      {lastCheckLabel && <span className="last-check">{lastCheckLabel}</span>}
    </>
  );

  return (
    <div className="app-shell" data-phase={phase}>
      {/* 标题栏与侧栏放在滚动容器外面：否则往下滚就被内容顶走，
          既不像原生应用，也没法在滚动到底部时关掉窗口。 */}
      <TitleBar onAction={runAction} busy={busy} statusSlot={statusSlot} />

      <div className="app-body">
        <Sidebar
          view={view}
          onNavigate={setView}
          showVersionHistory={showVersionHistory}
          cacheCount={cacheCount}
          statusLabel={statusLabel}
          statusTone={healthTone}
        />

        <div className="app-scroll" ref={scrollRef}>
          <main className="content-inner">
            {view === "overview" && (
              <div className="page">
                {!desktopRuntime && (
                  <p className="error-text">当前不在桌面应用中运行，安装与诊断功能不可用。</p>
                )}

                <Hero
                  onPrimary={onPrimary}
                  onSecondary={installed && !upToDate ? () => void checkUpdate() : undefined}
                  primaryLabel={primaryLabel}
                  secondaryLabel={secondaryLabel}
                  busy={busy}
                  upToDate={upToDate}
                  availableVersion={availableVersion}
                  lastCheckLabel={lastCheckLabel}
                />

                {activity && <ActivityPanel activity={activity} />}

                <ResultBanners />

                {error && (
                  <p className="error-text" role="alert">
                    {error}
                  </p>
                )}

                <section className="card statstrip" aria-label="本机状态">
                  <div className="stat">
                    <span className="stat-ico">
                      <Icon name="box" size={15} />
                    </span>
                    <div>
                      <span className="k">Codex 安装位置</span>
                      <span className={`v ${installLocation ? "mono" : "muted"}`} title={installLocation ?? ""}>
                        {installLocation ?? "尚未安装"}
                      </span>
                    </div>
                  </div>
                  <div className="stat">
                    <span className="stat-ico">
                      <Icon name="hdd" size={15} />
                    </span>
                    <div>
                      <span className="k">安装包缓存</span>
                      <span className="v">{cacheUsage}</span>
                    </div>
                  </div>
                  <div className="stat">
                    <span className="stat-ico">
                      <Icon name="clock" size={15} />
                    </span>
                    <div>
                      <span className="k">上次检查</span>
                      <span className={`v ${lastCheckClock ? "" : "muted"}`}>{lastCheckClock ?? "尚未检查"}</span>
                    </div>
                  </div>
                  <div className="stat">
                    <span className="stat-ico">
                      <Icon name="monitor" size={15} />
                    </span>
                    <div>
                      <span className="k">系统</span>
                      <span className="v">Windows · x64</span>
                    </div>
                  </div>
                </section>

                <div className="cols">
                  <section className="card">
                    <div className="card-head">
                      <h3>资源状态</h3>
                      <span className="aside">{health?.installed ? `${okCount} / ${components.length}` : "未安装"}</span>
                    </div>
                    <div className="health-list">
                      {components.length === 0 ? (
                        <p className="timeline-empty">
                          {health?.installed ? "尚未运行健康自检。" : "尚未检测到已安装的 Codex Desktop。"}
                        </p>
                      ) : (
                        components.map((component) => (
                          <div className="hrow" data-state={component.state} key={component.name}>
                            <span className="dot" />
                            <span className="name">{healthComponentText(component.name)}</span>
                            <span className="state">{healthStateText(component.state)}</span>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="card-foot">
                      <button type="button" className="link" onClick={() => setView("diagnostics")}>
                        打开诊断
                        <Icon name="chevron" size={12} />
                      </button>
                      <span className="aside">只读本机</span>
                    </div>
                  </section>

                  <RecentActivity onNavigate={setView} />
                </div>

                <p className="content-foot">
                  非官方工具 · 安装包来自 Microsoft Store，安装前校验 OpenAI 签名
                </p>
              </div>
            )}

            {view === "diagnostics" && (
              <div className="page">
                <div className="page-head">
                  <div>
                    <h1>诊断</h1>
                    <p>
                      检查 Codex 启动所需的五个资源副本。窗口自检会真正启动 Codex 并等待主窗口出现，
                      用来复现「进程在运行但窗口不出现」的问题。
                    </p>
                  </div>
                  <div className="head-aside">
                    <span className="pill" data-tone={healthTone}>
                      <span className="pdot" />
                      {statusLabel}
                    </span>
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      title={busy ? "有命令正在执行，等它结束再操作" : undefined}
                      onClick={() => void runHealthProbe()}
                    >
                      <Icon name="refresh" size={14} />
                      {probing ? "自检中…" : "重新自检"}
                    </button>
                  </div>
                </div>

                <HealthPanel
                  health={health}
                  probing={probing}
                  repairing={repairing}
                  busy={busy}
                  onProbe={() => void runHealthProbe()}
                  onRepair={() => void runRepair()}
                />
              </div>
            )}

            {view === "history" && (
              <div className="page">
                <div className="page-head">
                  <div>
                    <h1>版本历史</h1>
                    <p>更新时保留下来的安装包。需要时可以从这里退回上一版。</p>
                  </div>
                  <div className="head-aside">
                    <span className="pill" data-tone="gray">
                      <Icon name="shield" size={12} />
                      回退前照样校验签名
                    </span>
                  </div>
                </div>

                <section className="card statstrip">
                  <div className="stat">
                    <span className="stat-ico">
                      <Icon name="box" size={15} />
                    </span>
                    <div>
                      <span className="k">缓存安装包</span>
                      <span className="v">{cacheCount} 个</span>
                    </div>
                  </div>
                  <div className="stat">
                    <span className="stat-ico">
                      <Icon name="hdd" size={15} />
                    </span>
                    <div>
                      <span className="k">占用空间</span>
                      <span className="v">{cachedPackages ? formatBytes(cacheBytes) : "未知"}</span>
                    </div>
                  </div>
                  <div className="stat">
                    <span className="stat-ico">
                      <Icon name="refresh" size={15} />
                    </span>
                    <div>
                      <span className="k">可回退 · 重装</span>
                      <span className="v">{rollbackCount} 个</span>
                    </div>
                  </div>
                  <div className="stat">
                    <span className="stat-ico">
                      <Icon name="monitor" size={15} />
                    </span>
                    <div>
                      <span className="k">来源</span>
                      <span className="v">Microsoft Store</span>
                    </div>
                  </div>
                </section>

                {/* 可以整张关掉（开关在「安装包缓存」里，默认显示）。关掉的只是这张卡片，
                    缓存里的安装包、以及失败告警里的回退入口都不受影响。 */}
                {showVersionHistory && (
                  <VersionHistory
                    cachedPackages={cachedPackages}
                    cacheDirectory={cacheDirectory}
                    busy={busy}
                    rollingBack={rollingBack}
                    onRollback={(pkg) => void rollback(pkg)}
                    onOpenDirectory={(path) => void openPath(path)}
                  />
                )}

                {!showVersionHistory && (
                  <section className="card empty-state">
                    <span className="empty-icon">
                      <Icon name="clock" size={22} />
                    </span>
                    <strong>版本历史已隐藏</strong>
                    <p>缓存里的安装包与失败告警里的回退入口都不受影响。可以在「设置 → 安装包缓存」里重新打开。</p>
                  </section>
                )}

                <section className="card mt14">
                  <div className="card-head">
                    <h3>回退规则</h3>
                    <span className="aside">只认本机缓存</span>
                  </div>
                  <div className="rules">
                    <div className="rule">
                      <span className="rule-ico">
                        <Icon name="power" size={14} />
                      </span>
                      <div>
                        <strong>先关再装</strong>
                        <p>回退会先关闭正在运行的 Codex，装完再自动启动。</p>
                      </div>
                    </div>
                    <div className="rule">
                      <span className="rule-ico">
                        <Icon name="shield" size={14} />
                      </span>
                      <div>
                        <strong>照样校验签名</strong>
                        <p>旧包在磁盘上可能躺了几周，安装前仍然验发布者与签名。</p>
                      </div>
                    </div>
                    <div className="rule">
                      <span className="rule-ico">
                        <Icon name="lock" size={14} />
                      </span>
                      <div>
                        <strong>只认缓存包</strong>
                        <p>分发源只提供最新版，回退只能用本应用自己保留下来的安装包。</p>
                      </div>
                    </div>
                  </div>
                  <div className="card-foot">
                    <span className="hint">
                      旧包删掉就找不回来，所以这里不提供删除。要腾空间去「设置 → 安装包缓存」。
                    </span>
                  </div>
                </section>
              </div>
            )}

            {view === "settings" && (
              <div className="page">
                <div className="page-head">
                  <div>
                    <h1>设置</h1>
                    <p>缓存、安装位置与后台行为。所有改动立即生效。</p>
                  </div>
                  <div className="head-aside">
                    <span className="pill" data-tone="gray">
                      <Icon name="lock" size={12} />
                      只写用户目录
                    </span>
                  </div>
                </div>

                <p className="group-title">安装包缓存</p>
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

                <p className="group-title">高级</p>
                <AdvancedSettings
                  settings={settings}
                  // 安装位置取健康检查里那份真实路径（可能不在 C 盘）。健康自检刚跑过时
                  // 以它为准，否则用启动时那份状态。
                  installLocation={(healthDetail ?? status)?.installLocation ?? null}
                  cacheDirectory={effectiveDownloadDirectory({ settings, cachedPackages })}
                  onOpen={(path) => void openPath(path)}
                  onOpenInstallLocation={() => void openInstallLocation()}
                  onCopyDiagnostics={() => void copyDiagnostics()}
                />

                <p className="group-title">后台与启动</p>
                <BackgroundSettings
                  settings={settings}
                  onToggle={(key, value) => void saveOptions({ [key]: value })}
                />

                <p className="group-title">关于</p>
                <section className="card">
                  <div className="set-block">
                    <div className="about-row">
                      <Logo size={40} />
                      <div className="info">
                        <strong>Codex Updater</strong>
                        <p>非官方工具 · 与 OpenAI 无关 · 安装包来自 Microsoft Store</p>
                      </div>
                      <span className="pill" data-tone="gray">v{__APP_VERSION__}</span>
                    </div>
                  </div>
                  <div className="set-row">
                    <div className="label">
                      <strong>退出更新器</strong>
                      <p>安装与启动都已结束，可以关闭这个窗口。</p>
                    </div>
                    <button type="button" className="button" onClick={() => runAction("quit")}>
                      <Icon name="power" size={14} />
                      退出
                    </button>
                  </div>
                </section>

                <p className="content-foot">
                  安装前校验 OpenAI 签名 · 只写用户目录，不碰 WindowsApps
                </p>
              </div>
            )}
          </main>
        </div>
      </div>

      {notice && <NoticeDialog message={notice} onClose={dismissNotice} />}
    </div>
  );
}
