# Codex MS Desktop 自动更新插件

[English](README_EN.md) | [中文](README.md)

一个面向 Windows 的 Codex Desktop(Microsoft Store / MSIX 版)更新工具。它通过
`store.rg-adguard.net` 查询 Codex 商店包、比较版本、下载较新的 MSIX/bundle,
并在你明确要求时才执行 `Add-AppxPackage` 安装。配套提供本地 Web 界面、健康
自检与窗口探测、每日自动化模板。

## 特性

- **更新检查**:查询 `https://store.rg-adguard.net/api/GetFiles` 获取 Codex
  Store 条目(`9plm9xgg6vks`)的包链接,解析 `OpenAI.Codex_*.msix` / bundle。
- **按需下载与安装**:只有 `-DownloadOnly` / `-Install` / `-InstallWithRestart`
  才下载;只有 `-Install` / `-InstallWithRestart` 才执行 `Add-AppxPackage`。
- **安装后重启**:`-InstallWithRestart` 会启动独立流程——关闭 Codex、安装
  MSIX、校验已装版本不低于下载版本、再重启 Codex。
- **需要时提权**:新版 Codex 的清单声明了以 `localSystem` 运行的打包服务
  (`Category="windows.service"`),Windows 因此要求管理员上下文才能
  `Add-AppxPackage`(否则报 `0x80073D28`)。脚本会**先读安装包清单**
  (`Test-CodexPackageRequiresElevation`)判断是否需要提权:需要时用 `-Verb RunAs`
  拉起一个只做「关 + 装」的提权子进程,弹**一次** UAC。提权默认**关闭**:
  没有 `-AllowElevation` 就如实拒绝(不装、不改、不弹窗),自动化那条路因此
  不再能自动装完需要提权的版本——打开桌面应用点更新即可(见下文「自动维护」)。
- **保缓存 + 版本回退**:缓存里保留最近 2 个 `OpenAI.Codex` 安装包(约 1.67 GB),
  更旧的自动清理;新版本用起来有问题时,可以退回上一版(见下文「版本回退」)。
- **插件自更新**:对比本机与远端 `plugin.json` 版本,自动从 GitHub 更新插件。
- **代理控制**:`-NoProxy` 让本次进程下载不走代理。
- **Web 界面**:本地可视化操作,按钮即命令(见下文「Web 界面」)。
- **健康自检 + 窗口探测**:检测"进程在跑但主窗口不出现",并按证据给出判定
  (还在准备 / 官方加密资源搬迁 bug / 判不出来),三档里只有搬迁 bug 那一档才提示修复脚本
  (见下文「健康自检与窗口探测」与 `docs/`)。

## 目录结构

```text
plugins/codex-ms-desktop-updater/   Codex 插件本体
  .codex-plugin/plugin.json         插件清单(版本号以此为唯一来源)
  skills/codex-ms-desktop-updater/  插件技能说明
  scripts/                          核心脚本(见「命令参考」)
  tests/                            PowerShell 测试
webui/                              本地 Web 界面(扩展)
docs/codex-desktop-encrypted-copy-fix/  Codex「无窗口」bug 修复记录与脚本
install/                            一键安装到本机 Codex + 每日自动化模板
tools/Test-PluginVersionBump.ps1    CI 版本校验脚本
```

## 命令参考

所有命令都在**仓库根目录**执行,使用 PowerShell。

### 自动维护(插件自更新 + Codex 更新)

先更新本插件,再在有新版时下载安装并重启 Codex:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\scripts\run-automatic-maintenance.ps1 -NoProxy
```

**自动维护不会请求管理员权限。** 无人值守的流程不能挂在一个 UAC 弹窗上,所以遇到
需要提权的版本(见「特性」里的说明)时,它会在输出里打印
`ADMIN_PRIVILEGES_REQUIRED`,写明「安装包已下载好、什么都没改动」,然后**不启动**
安装流程。这一步刻意放在拉起分离的 worker **之前**:worker 是分离进程,调用点只看
它有没有被拉起来;让它异步失败,自动化那边会**报成功**。

需要提权的版本请走手动/桌面端路径,会弹一次 UAC:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\scripts\check-codex-update.ps1 -InstallWithRestart -NoProxy -AllowElevation
```

### 手动控制 Codex 更新

| 目的 | 命令 |
|------|------|
| 仅检查是否有新版 | `check-codex-update.ps1 -CheckOnly` |
| 仅下载 | `check-codex-update.ps1 -DownloadOnly` |
| 下载并安装(不重启) | `check-codex-update.ps1 -Install` |
| 下载 → 关闭 → 安装 → 重启 | `check-codex-update.ps1 -InstallWithRestart -NoProxy` |
| 同上,并允许弹一次 UAC | `check-codex-update.ps1 -InstallWithRestart -NoProxy -AllowElevation` |
| 强制下载最新包(即使已装) | `download-latest-codex-msix.ps1 -NoProxy` |
| 安装已下载的 MSIX 并重启 | `install-codex-msix-and-restart.ps1 -PackagePath "<路径>"` |
| 回退到上一版(需留在缓存里) | `install-codex-msix-and-restart.ps1 -PackagePath "<路径>" -AllowDowngrade -AllowElevation` |

`-AllowElevation` 只在 `-InstallWithRestart` 这条路上存在(`-CheckOnly` /
`-DownloadOnly` / `-Install` 没有),`install-codex-msix-and-restart.ps1` 也直接接受它。
不提权时遇到需要提权的包不会失败在 `0x80073D28` 上,而是在碰 Codex 之前就报
`ADMIN_PRIVILEGES_REQUIRED`。

其中 `run-automatic-maintenance.ps1`、`update-installed-plugin.ps1`、
`download-latest-codex-msix.ps1` 均接受 `-NoProxy`。

下载文件保存到:

```text
plugins/codex-ms-desktop-updater/downloads/
```

> 该目录是运行缓存,已被 `.gitignore` 忽略,不会入库。

## 安装到本机 Codex

对当前 Windows 用户安装(复制插件并写入每日自动化):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\install.ps1
```

它会:

- 把 `plugins\codex-ms-desktop-updater` 复制到
  `%USERPROFILE%\.codex\plugins\codex-ms-desktop-updater`(**跳过** `downloads` 缓存);
- 用 `install\automation.toml` 模板,把占位符替换成该机器真实路径后写入
  `%USERPROFILE%\.codex\automations\daily-codex-desktop-update-check\automation.toml`;
- 模板保持可迁移,不含盘符硬编码(用 `{{CODEX_PLUGIN_ROOT}}` 等占位符)。

安装后若插件未立即出现,重启 Codex Desktop 即可。

### 手动复制(不使用 install.ps1)

将插件目录复制到 `%USERPROFILE%\.codex\plugins\codex-ms-desktop-updater`,
然后在 `%USERPROFILE%\.codex\.agents\plugins\marketplace.json` 登记:

```json
{
  "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
  "category": "Developer Tools",
  "name": "codex-ms-desktop-updater",
  "source": { "path": "./plugins/codex-ms-desktop-updater", "source": "local" }
}
```

每日自动化若需在新设备重建,在该设备 Codex Desktop 中创建每日运行
`run-automatic-maintenance.ps1 -NoProxy` 即可。

## Web 界面(可视化操作 · 扩展)

不想敲命令行时,可在浏览器里点按钮完成检查 / 下载 / 安装 / 重启 / 健康自检:

```text
webui/
  server.py         本地桥接服务(Python 标准库,零第三方依赖)
  index.html        单文件界面(无外部 CDN,可离线)
  start-webui.ps1   启动脚本
  start-webui.bat   双击启动入口
```

### 启动

双击 `webui\start-webui.bat`(或运行 `start-webui.ps1`)。脚本会自动:

1. 检测本机 Python(`py` → `python` → `python3`);
2. 在后台启动 `server.py`,仅监听 `127.0.0.1:8765`;
3. 打开浏览器进入界面(已运行则直接打开)。

### 界面功能

顶部三张状态卡:Codex 已安装版本、**运行进程数 / 主窗口**、插件本地版本。
日志经 SSE 实时滚动。

| 按钮 | 对应脚本 |
|------|----------|
| 🔍 检查 Codex 更新 | `check-codex-update.ps1 -CheckOnly -NoProxy` |
| ⬇️ 下载并安装 + 重启 | `check-codex-update.ps1 -InstallWithRestart -NoProxy` |
| 📦 检查插件更新 | `update-installed-plugin.ps1 -CheckOnly -NoProxy` |
| 🔄 更新插件 | `update-installed-plugin.ps1 -NoProxy` |
| 🩺 健康自检 | `check-codex-desktop-health.ps1` |
| 🚀 健康自检 + 启动探测 | `check-codex-desktop-health.ps1 -Probe` |

> 安全说明:服务只绑定 `127.0.0.1`,局域网 / 公网不可访问。按钮只触发项目内
> 预定义脚本与固定参数,不接受任意命令,不引入新的任意命令执行面。

## Desktop 应用(Electron)

`desktop/` 是一个面向 Windows 用户的**一键式 Codex 安装器**,解决的是「新机器上
把 Codex 装好」这件事:打开即自检,点一个大按钮就把查更新 → 下载 → 签名校验 →
安装 → 启动探测整条链走完,全程显示真实进度。当前版本 `0.1.0`,React +
TypeScript + Electron,不需要 Rust/Cargo。

```powershell
cd desktop
npm install
npm run electron:dev
```

**它是一个纯 Codex 安装器**:所有 PowerShell 脚本自包含在安装包里,不读取也不修改
`%USERPROFILE%\.codex` 下的插件,新用户零前置条件。安装位置、下载缓存目录、日志
目录等收在折叠的「高级设置」里,默认路径开箱可用。

诊断功能是做实了的,不是摆设:健康自检逐项列出 5 个资源组件(win-cli / win-rg /
wsl-cli / wsl-rg / cua_node)的实际状态与路径,启动探测能识别「进程在跑但没有主
窗口」这个官方 bug,并给出修复入口。签名校验不通过会**中止安装**,不会放行。

### 「打开 Codex」必须验证结果,不能只发启动请求

发一条 `explorer.exe shell:AppsFolder\...` 就返回成功是不够的:Codex Desktop 的
上述官方 bug 恰好表现为**进程起来了、主窗口永远不出现**,此时如果只报「已请求
启动」,用户屏幕上什么都没有,看起来就是「点了没反应」,而且原因彻底丢失。因此:

- 启动复用 `check-codex-desktop-health.ps1 -Probe`,**等主窗口最多 20 秒**再下结论;
- 等待期有进度事件(脚本开始等窗口后就不再输出,界面上的进展只能由主进程自己给),
  否则 20 秒等待又变成一次「没反应」;
- 窗口没出现时如实报「进程已启动,但没有出现主窗口」,并**当场给出「修复资源副本
  并重新启动」按钮**,不让用户自己去翻日志;
- 探测**没跑完**(脚本中途抛错、没有 `RESULT=` 行)时报可读错误并附 stderr,绝不
  把它当成「窗口没出现」—— 把工具故障说成「你的 Codex 坏了」会把人引去修一个
  不存在的问题,这条分支在开发中真被踩到过。

### 路径必须通用,不能绑定本机

每个用户的安装位置都不一样,所以脚本里**不允许出现写死的路径特征**:

- 判断进程是否属于 Codex 包,一律用 `Get-CodexPackageProcess`,按包自己的
  `InstallLocation` 前缀匹配 —— 而不是字面量 `*\WindowsApps\<包名>_*`。MSIX 可以
  装在别的盘或别的目录,写死目录名在那些机器上会一个进程都匹配不到,把正常状态
  报成故障,或者该关掉的进程没关掉、留着锁文件;
- `AppUserModelId` 优先从已安装包的 `AppxManifest.xml` 解析 `<Application Id>`,
  兜底值也必须是 manifest 里真实存在的那个 id(`App`),而不是猜的 `Codex`;
- 读取进程 `.Path` 会因权限抛错,必须逐个 `try/catch` —— 在
  `$ErrorActionPreference='Stop'` 下,一个受保护进程就能中断整条管道。

这三条都有回归测试钉住(`plugins\codex-ms-desktop-updater\tests\CodexStoreUpdater.Tests.ps1`
与 `desktop\tests\launch.test.cjs`)。另外有一条更硬的:**生产代码里一个盘符路径字面量
都不许有**,由 `desktop\tests\install-location.test.cjs` 逐行扫描脚本 / 渲染进程 /
主进程来保证 —— 这类 bug 在开发机上(C 盘)永远不会显形。

界面是单页一键,窗口外壳照 macOS 的玻璃质感:顶栏(品牌 / 菜单 / 窗口按钮)固定在窗口
顶部、不随内容滚动,只有内容区自己滚。

- **窗口按钮是顶栏右上角的 `− □ ×`**,图标是 SVG(`− □ ×` 的基线和字宽随字体变,
  「还原」态需要的双矩形更是没有对应字符)。可点区域 40×30,`verify:render` 每次
  都会量这个尺寸 —— 小到点不中就不算可用。
- **内容区卡片标题栏上那三个 mac 圆点是装饰**,照原型 `.window-head::before` 的配色
  与位置(红=关闭、黄=最小化、绿=最大化)。它们不是按钮、不接事件:卡片在滚动容器里,
  往下滚圆点就跟着走了,让它们承担窗口操作会得到一个「滚到底就关不掉窗口」的界面。
- **顶栏菜单只有「操作」和「诊断」两组**,不再有「窗口」组 —— 窗口命令由右上角的
  按钮承担,重复摆一份没有意义。原生菜单栏在 `frame: false` 下根本显示不出来,那里的
  「窗口」组保留着,唯一作用是承载 `Ctrl+W` / `Ctrl+M` 快捷键,跟着删会让快捷键静默失效。
- **命令的结论用居中的模态对话框弹出**,不是右下角 toast。toast 贴在视线的另一头,
  而它承载的是命令唯一的反馈(「已经是最新版本,无需安装」「Codex 已启动」「资源副本
  已重建」),漏掉一条用户就不知道刚才那一下做了什么。模态浮在正中、压暗背景,点
  「知道了」或按 Esc 关闭。
- **命令跑着的时候,能再触发命令的入口全部置灰。** 判据是 store 里唯一一处
  `isCommandRunning`(`phase === "working" | "checking"`、`probing`、`repairing`、
  `checkingUpdate` 五者取或),主按钮、次按钮、诊断面板两个按钮、菜单里五个命令项都
  用它。以前每个动作各记各的标志位,谁都没把「别人正在跑」算进去:检查更新压根不置位
  (网络往返那几秒按钮全亮,用户连点几次就并发几条检查、连弹几次结论),修复资源副本
  期间主按钮仍可点(能一边关 Codex 一边装 Codex)。置灰的同时文案也变(次按钮显示
  「正在检查…」),按钮点不动必须有个看得见的理由。**菜单项按「会不会真跑命令」区分**:
  「打开日志目录 / 打开缓存目录」不禁用 —— 它们秒回,而且命令跑着的时候正是用户最想
  点它们去看日志的时候。**真正的闸门在 `App.tsx` 的 `runAction` 里**,不在 `disabled`
  上:原生菜单的 `Ctrl+R` / `Ctrl+I` 由主进程直接发过来,根本不经过 DOM,置灰拦不住。

### 「Codex 装在哪」:装哪儿由 Windows 定,但看得见

经常被问到的两个问题,答案都落在「高级设置」里那一行只读的**Codex 本体安装位置**上:

- **能不能自己选安装位置?** 不能 —— MSIX 应用落在哪个盘由 Windows 的部署服务决定,
  `Add-AppxPackage` 不带 `-Volume` 就装到系统卷,安装器(包括本应用)说了不算。所以
  这里不做假控件,而是把 `Get-AppxPackage` 报回来的**真实路径原样显示**,并给一个
  「打开 Windows 存储设置」按钮:想把新应用装到别的盘,那是 Windows「新的应用将保存到」
  这一项的事。本应用真正能替你选的只有上面的**安装包缓存目录**(几百 MB 的安装包先下到
  那里再交给系统安装,换盘放它同样省 C 盘空间)。注意这个目录现在会**有意保留最近 2 个
  安装包供回退使用**(约 1.67 GB),不再是「用完即删」,详见下文「版本回退」。
- **装在 D 盘还识别得到吗?** 识别得到,而且一直如此。包是通过 `Get-AppxPackage
  -Name OpenAI.Codex` 找到的(它跨所有卷枚举),安装位置、进程归属、manifest 里的
  `AppUserModelId` 全是**现取现用**,没有任何一处按 `C:\Program Files\WindowsApps`
  拼路径 —— 写死盘符的代码在开发机上跑起来完全正常,只在用户的 D 盘上炸,是最难发现
  的一类 bug。这条不变量有回归测试钉住:`desktop\tests\install-location.test.cjs`
  会扫描脚本 / 渲染进程 / 主进程的**每一行代码**,出现任何盘符路径字面量就判失败(注释
  除外),`verify:render` 的桩数据也故意用 D 盘路径。

### 三个必须遵守的实现约束

1. **脚本走 `extraResources`,不能进 asar。** PowerShell 无法执行 `app.asar` 内的
   `.ps1`,且 `CodexStoreUpdater.psm1` 必须与被调脚本同目录(每个脚本都用
   `Import-Module (Join-Path $scriptRoot "CodexStoreUpdater.psm1")` 定位模块)。
   `npm run verify:render:packaged` 会校验脚本确实落在 asar 之外。
2. **只能调 `powershell.exe`(5.1),不能调 `pwsh`。** 安装脚本用
   `Join-Path $PSHOME "powershell.exe"` 拉起分离的安装 worker;在 pwsh 下
   `$PSHOME` 指向 PowerShell 7 目录,那里只有 `pwsh.exe`,`Start-Process` 抛错后
   整个安装会静默失败。提权子进程不能照抄这一句:它的 `Start-Process` 包在
   「UAC 被拒绝」的 `catch` 里,路径拼错会被当成用户点了否,报一句与真实原因无关的
   话 —— 所以它用 `Get-CurrentPowerShellPath`(问当前进程自己的 `Path`,
   `$PSHOME` 只作兜底)。
3. **参数不能靠数组展开传递。** `@argv` 传的是位置参数值而不是参数名,会把开关
   当成字符串值绑到第一个位置参数上。`electron/ps.cjs` 因此自己拼 token:开关原样
   写、值一律单引号包裹(单引号是 PowerShell 里唯一不做展开的字面量)。

### 校验命令

```powershell
npm test                        # 解析层 + PowerShell 拼装层 + 窗口/结论对话框/安装位置/命令锁接线单元测试,不联网
npm run verify:render           # 把 dist/ 真正加载进 Electron,跑八个界面场景
npm run verify:render:packaged  # 同上(已安装/未安装/窗口缺失),校验 app.asar 产物与 asar 外的脚本布局
npm run verify:backend         # 真实调用内置脚本(含网络),校验解析对得上脚本输出
npm run verify:simulate        # 模拟安装流程:不下载不安装,只跑进度管线
npm run verify:launch          # 真机启动一次 Codex 并等主窗口(会真的把 Codex 拉起来)
```

`verify:render` 覆盖八个场景:已安装(「一键检查并更新」+ 5 个健康组件行)、
未安装(**这个 exe 的主用途**:「一键安装 Codex」)、安装进度流(不确定进度条 →
百分比推进 → 软告警 → 日志区)、打开 Codex 但主窗口没出现(断言窗口缺失横幅、
修复按钮可点且没被遮挡、原始诊断仍在页面上)、命令结论对话框(从菜单触发「检查更新」,
断言对话框**水平垂直都居中**、完整落在视口内、确认按钮命中测试通过且已获得焦点、
点完真的关闭,顺带断言页面上不再有任何 `.toast`)、命令执行中的交互锁(把
`check_update` 的桩**挂住不返回**,模拟真实的网络往返:先量所有入口都置灰、「打开
日志目录/缓存目录」仍可点,再连发四次命令断言 `check_update` 只走了 **1 次 IPC**
——`disabled` 只说明按钮点不动,证明不了快捷键那条路,所以这里数的是真实 IPC;最后
放行,断言界面**重新点得动**,标志位漏清就会在这里露出来)、下拉菜单(默认宽度 +
760px 窄窗口各跑一遍)。除内容断言外,它还会把内容区滚到底,确认窗口按钮仍在视口内
(顶栏没被内容顶走),并校验卡片上的装饰圆点(红黄绿三个、够圆、且没有变成可点元素)、
窗口按钮的可点尺寸,以及对菜单项做命中测试——菜单坐标正确但被内容盖住这种「量得到、
点不到」的问题,只有命中测试能发现。窄窗口那一遍专门盯住「窗口拖小后菜单不许消失、
也不许和窗口按钮或顶栏右边界撞上」,并逐行量「高级设置」里**每一条**路径行的按钮
有没有折行或被挤压。安装位置那一行断言的是桩数据里那个 **D 盘**路径被原样显示出来。

`verify:render:packaged` 跑其中的「已安装 / 未安装 / 窗口缺失」三遍:打包产物才是
用户真正拿到的那一份,而这两条路径(exe 的主用途、官方 bug 的可见形态)最不能被
打包差异悄悄弄坏。它同时校验 5 个脚本确实落在 `app.asar` 之外。

`verify:launch` 是**真机**校验,会真的启动 Codex 并等主窗口出现,按时间线打印阶段
与日志。退出码:`0` 主窗口出现 / `3` 进程在但窗口没出现 / `1` 出错。它不在默认校验
链里,因为它会改动本机状态(把 Codex 拉起来)。

`verify:simulate` 是唯一能在**不真的装一次 Codex**的前提下看到完整安装过程的手段。
安装的大部分时间花在 `Add-AppxPackage` 上,它是安静的长任务,没有百分比也没有回调,
唯一可观测通道是 worker 写的日志文件。这个脚本喂进格式与措辞都取自真实
`Write-InstallLog` 调用的日志,走一遍真实的 `tailInstallLog` 管线,把进度事件按时间线
打出来,并断言进度不回退、静默期爬升不越过里程碑、失败路径能收到补救提示。它有四个
场景:`ok` / `slow-install`(8 秒静默,演示进度爬升) / `cleanup-warning` / `window-missing`
(官方 bug 的结局)。

```powershell
npm run verify:simulate -- --scenario window-missing
```

`npm run electron:build` 生成 Windows x64 NSIS `.exe`;生产环境再配置 Windows
代码签名证书即可。

> **打包报 `EPERM: ... rename '...\win-unpacked.tmp' -> '...\win-unpacked'` 时**,
> 直接用本地已解压的 Electron,跳过「解压到 `.tmp` 再改名」那一步:
>
> ```powershell
> npm run electron:build:local
> # 等价于 npx electron-builder --win nsis -c.electronDist=node_modules/electron/dist
> ```
>
> 原因是本机的安全软件/索引器会攥住刚解压出来的
> `win-unpacked.tmp\resources\default_app.asar`(实测:该文件可被只读共享打开,说明
> 有人持着读句柄),而 **Windows 只要目录里有文件被占用就拒绝重命名整个目录** ——
> 于是 electron-builder 在最后一步改名时失败。这不是项目配置问题,但**重试通常没用**
> (实测连续三次、间隔二十多分钟仍然失败,占用不是短时的)。`-c.electronDist` 那一路
> 直接复制 `node_modules/electron/dist`,既不改名也不解压,因此不受影响;代价是不再
> 校验下载来的 Electron 压缩包完整性(该包本身已由 `npm install` 校验过)。

## 版本回退(扩展)

更新完发现新版本有问题,想回到上一版 —— 这件事过去是**做不到**的,不是「没做这个功能」,
而是三处代码合起来把退路堵死了:

1. 版本检查会删掉所有「版本 ≤ 已安装版本」的安装包,恰好是用户正在用、且已知能用的那一版;
2. 安装流程装完再删一次自己刚用的包;
3. 两处安装都是裸的 `Add-AppxPackage`,不带 `-ForceUpdateFromAnyVersion`,**即使包还在,
   Windows 也会拒绝安装更低的版本**。

而分发源 `store.rg-adguard.net` 只提供最新版(实测 `Retail` / `Slow` / `Fast` 三个 ring
都只返回同一个版本),删掉的安装包**再也下不回来**。

### 保留策略

一句话:**缓存里「版本 ≤ 已安装版本」的包,按版本倒序保留最新 2 个,其余删掉**。

- 下限是 2 而不是 1:新装上的那一版的包,作用是**下一次**更新时的回退目标。只留 1 个
  (只剩刚装上的),下次更新完就没有可退的版本,功能等于不存在。
- 版本**高于**已安装版本的包(已下载未安装)不动;其他应用的包、`.partial` 半成品也不动。
- 按 2 个 800 MB 级的包算,缓存常驻约 **1.67 GB**。

剪枝发生在安装 worker 里(装完就知道新版本号、且正站在缓存目录里),所以安装一结束缓存
就回到 2 个包,不会先涨到 3 个(2.5 GB)再慢慢清。

### 怎么用

- **Desktop 应用**:「版本历史」卡片列出缓存里的安装包,标出「当前已安装 / 可回退 /
  比当前新」,可回退的那一行给「回退到此版本」按钮;刚更新完就出问题时,失败告警卡里也有
  同一颗按钮。回退会先关闭正在运行的 Codex,装完再自动启动。
- **插件侧**:

```powershell
# 只读:列出缓存里的安装包(版本、架构、大小、时间、与当前版本的关系)
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\scripts\list-cached-codex-packages.ps1 -DownloadDirectory "<缓存目录>"

# 回退到指定安装包(关 Codex → 安装 → 重启)
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\scripts\install-codex-msix-and-restart.ps1 -PackagePath "<msix 路径>" -AllowDowngrade
```

### 三个实现要点

1. **允许降级只在回退路径上**。`-AllowDowngrade` 才会带上 `-ForceUpdateFromAnyVersion`;
   一键更新的行为保持不变,日志里也能看出这一跑是哪种模式。
2. **降级后的版本校验用相等判定**。降级被 Windows 拒绝时系统里仍是那个更高的版本,沿用
   升级路径的 `-lt` 恰好为假,会把一次什么都没发生的降级**报成安装成功**;相等判定把它变成
   一个看得见的错误(`Downgrade did not take effect`)。
3. **回退同样先校验签名**。旧安装包在磁盘上可能已经躺了几周,校验这道闸门不比新下载的松。

### 一个必须知道的限制

回退**只能依赖本应用自己留下来的安装包**,而且必须是「**已经带着新保留策略更新过一次**」
之后。装上这个功能就想退到升级前那一版是做不到的 —— 那一次的安装包在旧策略下已经被删掉了。

实测本机三个缓存目录,现存的包(`26.924.2738.0`、`26.917.6896.0`)都比已安装的
`26.901.6511.0` **新**,都不是回退目标;`26.901.6511.0` 的安装包已经找不回来。所以这个
功能要等**下一次更新**才会第一次真正可用 —— 那时 `26.901` 的包会被保留下来。界面上的空
列表给的也是这段解释,不是一个空盒子。

### 手工验证一次真实回退

`-ForceUpdateFromAnyVersion` 对 Store 签名包是否放行,只有真的降一次才算验过(本机没有
更旧的包,这一步没做过)。可复现步骤:

1. 正常更新一次,让缓存里出现两个包(新装的 + 上一版);
2. `list-cached-codex-packages.ps1` 确认上一版那条的 relation 是 `older`;
3. 点「回退到此版本」(或跑上面那条 `-AllowDowngrade` 命令);
4. 看安装日志里 `Add-AppxPackage` 之后 `Get-AppxPackage` 报的版本是否**真的退回去了**。

降级被拒不会静默成功 —— 会以「降级没有生效,当前仍是 X」的错误暴露出来。

## 健康自检与窗口探测(扩展)

Codex Desktop(商店版)有一个官方 bug:**更新后进程在运行,但主窗口不出现**。
原因是 MSIX 加密资源搬迁到用户目录时,App 的 `fs.copyFileSync` 复制失败
(`errno=-4094`)。本仓库提供只读自检与可选启动探测:

```powershell
# 只读体检:各搬迁 bundle 是否存在 / 是否残留 .staging-*
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\scripts\check-codex-desktop-health.ps1

# 自检后启动 App 并等待主窗口(复现「进程在、无窗口」)
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\scripts\check-codex-desktop-health.ps1 -Probe -ProbeSeconds 25
```

退出码:`0` 健康 / `1` 组件缺失或降级 / `2` 未安装 / `3` 探测超时未出现主窗口。

- `-InstallWithRestart` 安装后也会自动探测窗口;若未出现主窗口,安装日志会写
  `WINDOW_PROBE=FAILED`、一行 `STARTUP_DIAGNOSIS=` 判定与 Codex 的可见顶层窗口清单。
  判定分三档:`still-preparing`(还在把运行时物化到用户缓存,稍等即可)、
  `relocation-bug`(确为搬迁问题)、`unknown`(现有证据判不出来)。
- **只有判定为 `relocation-bug` 时**日志才会给出修复脚本那一行。首次启动要物化几百 MB
  运行时(实测约 132 秒),30 秒的探针本来就可能没等到窗口 —— 那不代表出问题了,所以
  探针会在拿到「最近仍有写入」的证据时自动延长(最多再等 150 秒)。
- 若确认是该 bug,运行 `docs\` 下的修复脚本即可恢复(见下)。

## 修复文档:docs/codex-desktop-encrypted-copy-fix

`docs/codex-desktop-encrypted-copy-fix/` 记录了「Codex Desktop 启动后无窗口」
问题的完整调查与修复:

- `README.md` —— 现象、根因(加密 MSIX 资源 + Node copyFile 失败)、影响面、
  Bundle ID 计算、手动与脚本修复、验证结果、回滚方法;
- `repair-codex-desktop-bundles.ps1` —— **可复用、幂等**的修复脚本。它会动态
  计算当前安装版本的五个组件 bundle ID(win-cli / win-rg / wsl-cli / wsl-rg /
  cua_node),用字节流复制绕过加密复制失败,并对每个组件做 SHA-256 全量校验。

修复脚本用法(需先退出 Codex):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\codex-desktop-encrypted-copy-fix\repair-codex-desktop-bundles.ps1
```

> 安全边界:脚本只写 `%LOCALAPPDATA%\OpenAI\Codex` 与 `%USERPROFILE%\.codex`,
> **绝不改动** `C:\Program Files\WindowsApps` 下的文件 / ACL / 所有权。每次重跑
> 对已健康的缓存输出 `SKIP`,不会破坏既有状态。每次 Store 更新后若复发,直接
> 重跑即可(脚本按当前安装版本动态计算 ID,可跨版本)。

## 版本管理与 CI

插件版本唯一来源是
`plugins\codex-ms-desktop-updater\.codex-plugin\plugin.json` 的 `version` 字段。
推送仓库改动前请递增该版本(数值 SemVer 风格,当前 `0.4.3`)。GitHub CI 在 PR 和
push 到 `main` 时运行 `tools\Test-PluginVersionBump.ps1`,要求 head 版本大于
基线版本。

## 测试

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\Install.Tests.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\tests\CodexStoreUpdater.Tests.ps1
```

## 维护说明

- 仓库根 `AGENTS.md`:面向只负责「把插件装进本机 Codex」的 Codex agent。
- `.codex/AGENTS.md`:面向维护本仓库本身(版本管理、验证流程)。
