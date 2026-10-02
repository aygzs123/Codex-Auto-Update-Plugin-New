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
  桌面应用**不套用这条策略**:它把缓存全部留着,界面上显示占用了多少、给一个
  「清空缓存」按钮,由用户决定什么时候清(见下文「保留策略」)。
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
`%USERPROFILE%\.codex` 下的插件,新用户零前置条件。安装本体位置、下载缓存目录、日志
目录等收在折叠的「高级设置」里,默认路径开箱可用。**安装包缓存单独一张卡片,排在所有
设置之前**:它显示缓存里现在有几个包、共占多少,旁边就是「打开缓存目录」和「清空缓存」,
不用先展开设置去找 —— 磁盘占用是这台机器上唯一会自己涨的东西,藏起来不合适(见下文
「保留策略」)。

诊断功能是做实了的,不是摆设:健康自检逐项列出 5 个资源组件(win-cli / win-rg /
wsl-cli / wsl-rg / cua_node)的实际状态与路径,启动探测能识别「进程在跑但没有主
窗口」这个官方 bug,并给出修复入口。签名校验不通过会**中止安装**,不会放行。

界面按「发给别人用」的标准收过一遍:单实例锁(双击两次只会把已有窗口叫到前台,不会
出现两个更新器同时点「一键安装」)、窗口位置尺寸记忆(外接显示器拔掉时会退回默认位置,
不会开到看不见的地方)、应用图标(由 `npm run icon:make` 代码生成,生成器入库)、
任务栏进度条、安装途中关窗会先问一句、跟随系统深浅色。顶栏在启动那次自动检查跑完后
会写「上次检查 HH:MM」,「诊断 → 复制诊断信息」能把完整现场(版本、结论、5 个组件、
缓存目录、安装日志路径)一段文本复制出来,同事报障时直接粘过来即可。

「关窗后留在托盘里」和「开机自动启动」是**可选项,默认关闭**,在「后台与启动(可选)」
卡片里开。打开后也只是**让更新器自己起来查一次,发现新版本弹一条系统通知**,同一个
版本只提醒一次;**绝不自动安装** —— 需要管理员授权的安装永远由人点(见上文「后台运行
绝不弹 UAC」)。系统通知需要带 AppUserModelID 的快捷方式才会显示,所以要用安装包装
出来的版本才能看到,直接跑源码时不一定弹得出来。

「版本历史」卡片(列出缓存里的包、给「回退到此版本」按钮)可以在「安装包缓存」卡片里
**关掉显示**,给不需要回退的同事一个干净界面。这个开关**只隐藏卡片,不改任何行为** ——
缓存照旧一个不删,回退入口在失败告警卡里也仍然在(更新完了才发现问题的那一刻,正是最
需要它的时候,不该因为关了卡片就找不到)。

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

### 组件缺失推断不出启动会坏:修复横幅只认「未完成的物化残留」

组件的四种状态里,只有一种能说明「物化试过、但没跑完」:

| 符号 | 状态 | 是否弹修复横幅 |
| --- | --- | --- |
| `[PART ]` | `partial` —— 目标目录不在,**但**留着 `.staging-*` / `.repair-*` 中转目录 | 是 |
| `[MISS ]` | `missing` —— 目标目录不在,连残留都没有 | 否 |
| `[ERR  ]` | `error` —— 连 MSIX 自己的源文件都缺,修复脚本从同一份源复制,救不了 | 否 |
| `[OK   ]` | `ok` | 否 |

`partial` 的判据是**证据**,不是「只有它修得了」——修复脚本对裸 `missing` 同样物化得动。
`missing` 是首次启动前的常态(新机器上五项全 `missing`,App 按需物化),拿它当触发条件
就会得到一张常驻的假警报:2026-10-02 一台**完全正常**的机器上 `wsl-cli` 就是 `missing`
(它只是 WSL 侧那份 CLI 副本,与 Windows 桌面端能不能开窗口是两件事),界面却一直挂着
「Codex 可能无法正常打开窗口」。

反过来也不成立:2026-09-07 那次**真实**的搬迁 bug 里,`win-cli` 自己物化是成功的,
主窗口照样没出现。所以组件状态预测不了窗口能不能开,**两个方向都不行** —— 界面因此
只说「有的资源副本不在」,不再断言后果;能不能开以窗口自检的结论为准。

判据只有一处实现(`desktop/electron/parse.cjs` 的 `healthRepairTargets`),渲染进程
只负责把组件名翻成中文。这条在 `desktop/tests/parse.test.cjs` 有回归测试钉着
(真机形状 → 不弹、`partial` → 弹并点名)。

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
- **启动时就联网查一次「是不是最新版本」,不用点。** 以前 `bootstrap` 只跑三条全本地
  命令(设置 / 状态 / 缓存清单),装的是不是最新只有点一下「仅检查更新」才知道,点了还
  会弹一个居中对话框。现在启动顺手发一次 `check_update`,结论落在两处:顶栏那一行
  (「已安装 X · 已是最新」/「已安装 X · 可更新到 Y」),和主区那行大字。主区原来只写
  「已安装 X」、副标题再补一句资源自检结论,于是整个页面最显眼的两行字里**一个更新结论
  都没有**(用户原话:「第一次检测后显示的已安装 26.930.2377.0 启动所需资源完整 不太对
  吧,应该显示已是最新版:xxx」)。现在它写「已是最新版:X」/「可更新到 Y」,副标题交代
  当前装的是哪一版,**资源自检结论仍然保留**——那是另一个问题(这台机器上的 Codex 能不能
  正常起来),degraded 时必须看得见,只是不再是主区的主角。结论还没回来(没查 / 查失败)
  时才退回「已安装 X」:那时候确实没有结论可说,编一个「已是最新」比什么都不说更糟。
  主按钮随之变成「打开 Codex」或「一键更新到 X」,次按钮
  「仅检查更新」在已是最新时隐去。这条路与用户点出来的那次
  共用同一条命令,差别只在**怎么呈现**,三处都是刻意的:不弹模态(用户什么都没要求,
  启动就糊一个对话框是打扰)、失败不报错(离线或分发源抽风不该把启动界面染红,静默退回
  未检查态)、**带 30 秒超时**(`ps.cjs` 没有进程级超时,而自动检查卡住就是启动即永久
  锁死 —— 用户什么都没点,连「是不是在等」都无从判断)。它同样置 `checkingUpdate` 并走
  同一个 `isCommandRunning` 判据,所以启动那几秒所有入口一致置灰。另外 `-CheckOnly`
  **本来也会剪枝下载缓存**(那个剪枝点排在 `-CheckOnly` 的提前 `return` 之前),所以
  桌面应用给三个调用都带上 `-KeepAll`,拿到结果后仍然按 `removedCacheFiles` 刷新
  「版本历史」卡片 —— 桌面这条路上它现在是空的,但脚本侧的契约没变,不能据此删掉刷新。
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
  「打开安装目录」按钮把这个目录真的开给用户看。`C:\Program Files\WindowsApps` 那一级
  是锁着的(连列目录都被拒),但具体到 `OpenAI.Codex_<版本>_<arch>__<hash>` 这个包目录,
  `BUILTIN\Users` 有 `ReadAndExecute` —— Explorer 打得开,看得见里面的文件。想把新应用
  装到别的盘,那是 Windows「新的应用将保存到」这一项的事,办法写在界面说明里
  (设置 → 系统 → 存储 → 高级存储设置)。
  这颗按钮改过两次,两次都值得记:最早它打开的是 `ms-settings:storagesense` —— 那是
  「存储感知」,一个自动删旧文件的开关,跟装到哪个盘毫无关系,而注释、界面说明和本文三处
  都写着「新的应用将保存到」,只有真正打开的那一页不是;先改成 `savelocations`(对的那页),
  用户接着问「打开 window 存储位置为什么不是打开路径的」——他问得对:按钮的字面意思和它
  旁边显示的路径都指向「打开这个目录」,它却把人送去别处。现在它做字面上的事,
  去 Windows 改默认盘的办法留在说明文字里,那条路不会因为按钮改用途就从界面上消失。
  本应用真正能替你选的只有**安装包缓存目录**(几百 MB 的安装包先下到
  那里再交给系统安装,换盘放它同样省 C 盘空间)。桌面应用**不自动清理**这个目录,
  界面上写着它现在占了多少,想腾空间点「清空缓存」,详见下文「版本回退」。
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

   **推论:被 App 调用的脚本本身,也只能用 .NET Framework 4.8 里存在的 API。**
   解释器既然是 5.1,任何 pwsh 7 / .NET 5+ 专有的静态方法在运行时根本不存在。
   典型禁区:`[System.Security.Cryptography.SHA256]::HashData()`、
   `[Convert]::ToHexString()`,在 5.1 下都抛「找不到方法」;对应写法是
   `[System.Security.Cryptography.SHA256]::Create()` + `ComputeHash()`、
   `[System.BitConverter]::ToString()`(`::new()` 是安全的,PowerShell 5.0 起支持)。
   2026-10-02 的「点击修复资源副本没反应」就栽在这里:`repair-codex-desktop-bundles.ps1`
   用了 `HashData()`,而它是 `Get-BundleId` 的第一行 —— 脚本在写任何东西之前就抛,
   用户目录零残留、界面只闪一下。人工用 pwsh 7 手动跑是通的,所以这个 bug 躺了很久:
   **人工验证不能替代 5.1 验证**。详见
   `docs/codex-desktop-encrypted-copy-fix/README.md` §7.1。
3. **参数不能靠数组展开传递。** `@argv` 传的是位置参数值而不是参数名,会把开关
   当成字符串值绑到第一个位置参数上。`electron/ps.cjs` 因此自己拼 token:开关原样
   写、值一律单引号包裹(单引号是 PowerShell 里唯一不做展开的字面量)。

### 校验命令

```powershell
npm test                        # 解析层 + PowerShell 拼装层 + 窗口/结论对话框/安装位置/命令锁/修复路径接线/启动自动检查单元测试,不联网
npm run verify:render           # 把 dist/ 真正加载进 Electron,跑十二个界面场景
npm run verify:render:packaged  # 同上(已安装/未安装/窗口缺失),校验 app.asar 产物与 asar 外的脚本布局
npm run verify:package          # 验收打包产物:app.asar 索引自洽 + 打出来的 exe 真的能起来(需先打包)
npm run verify:backend         # 真实调用内置脚本(含网络),校验解析对得上脚本输出
npm run verify:simulate        # 模拟安装流程:不下载不安装,只跑进度管线
npm run verify:launch          # 真机启动一次 Codex 并等主窗口(会真的把 Codex 拉起来)
```

`verify:render` 覆盖十二个场景:已安装(启动自动检查跑完后主按钮变「一键更新到 X」,
顶栏写着「已安装 X · 可更新到 Y」,外加 5 个健康组件行)、未安装(**这个 exe 的主用途**:
「一键安装 Codex」,且断言**一个字节的 `check_update` 都没发出去**——没装就没有「是不是
最新」可言)、已是最新(启动后什么都不点,顶栏就该写着「 · 已是最新」、**主区标题写着
「已是最新版:X」并带上版本号**、主按钮变「打开 Codex」、次按钮「仅检查更新」隐去,而且
**没有弹出任何对话框**——这几条正是「启动只读版本,必须点一下才知道是不是最新」那个反馈
的回归测试;主区标题那一条针对的是另一个反馈:「第一次检测后显示的已安装 X 启动所需资源
完整 不太对吧,应该显示已是最新版」)、安装进度流(不确定
进度条 → 百分比推进 → 软告警 → 日志区)、打开 Codex 但主窗口没出现(断言窗口缺失横幅、
修复按钮可点且没被遮挡、原始诊断仍在页面上)、命令结论对话框(从菜单触发「检查更新」,
断言对话框**水平垂直都居中**、完整落在视口内、确认按钮命中测试通过且已获得焦点、
点完真的关闭,顺带断言页面上不再有任何 `.toast`,以及**手动点之前没有对话框**——
启动那次自动检查必须是静默的,弹框与否取决于谁触发的)、命令执行中的交互锁(桩把
`check_update` **挂住不返回**,于是**启动时那次自动检查本身就提供了「命令跑着」的窗口**:
先按主按钮 disabled 轮询确认界面已经置忙,再连发四次命令断言 `check_update` 的 IPC
次数**没有增加**——`disabled` 只说明按钮点不动,证明不了快捷键那条路,所以这里数的是
真实 IPC;最后放行,断言界面**重新点得动**,标志位漏清就会在这里露出来)、下拉菜单
(默认宽度 + 760px 窄窗口各跑一遍)。除内容断言外,它还会把内容区滚到底,确认窗口按钮
仍在视口内(顶栏没被内容顶走),并校验卡片上的装饰圆点(红黄绿三个、够圆、且没有变成
可点元素)、窗口按钮的可点尺寸,以及对菜单项做命中测试——菜单坐标正确但被内容盖住这种
「量得到、点不到」的问题,只有命中测试能发现。菜单场景还会真的点一次「诊断 → 复制诊断
信息」,把剪贴板内容读回来断言它是一份完整现场(应用与 Codex 版本、更新结论、健康结论、
5 个组件、缓存目录、日志路径),并确认这个入口在**界面置忙时仍然可点**——同事报障时正是
安装刚失败的那一刻。已安装场景另外断言顶栏写出了「上次检查 HH:MM」:一个没有时间戳的
「可更新到 X」无法判断是不是上周留下的结论。窄窗口那一遍专门盯住「窗口拖小后菜单不许
消失、也不许和窗口按钮或顶栏右边界撞上」,并逐行量「高级设置」里**每一条**路径行的按钮
有没有折行或被挤压。安装位置那一行断言的是桩数据里那个 **D 盘**路径被原样显示出来。
每个场景还会展开**全部**设置卡片(不是只展开第一张)去量「安装包缓存」卡片:summary
写出「N 个 · X GB」、有「打开缓存目录」、有「清空缓存」按钮且**置忙时是灰的**、以及
「版本历史」开关的勾选状态 —— 缓存清单读不出来时必须是「占用未知」而不是「0 个」,
后者会让用户以为缓存是空的。

自动检查是异步的(`bootstrap` 刻意不 `await` 它),所以脚本在「界面就绪」之后还会轮询
顶栏,等结论真的落到 `.build` 那一行再断言——少了这段等待,那些断言就是在跟一次异步
IPC 赛跑,快机器上绿、慢机器上红。

`verify:render:packaged` 跑其中的「已安装 / 未安装 / 窗口缺失」三遍:打包产物才是
用户真正拿到的那一份,而这两条路径(exe 的主用途、官方 bug 的可见形态)最不能被
打包差异悄悄弄坏。它同时校验 5 个脚本确实落在 `app.asar` 之外。

`verify:package` 验收的是**产物本身**,已挂进 `electron:build` 与
`electron:build:local`,所以每次打包都会跑 —— 本地和发 Release 的 CI 都绕不过去。
它做两件事:一是校验 `app.asar` 的索引自洽,数据区是紧凑排布的,「所有条目声明的大小
之和」必须**恰好等于**「文件长度 - 数据区起点」,少一个字节就说明写进去的内容和索引记的
不是同一份,排在错位点之后的条目会整体偏移;二是**真的把打包出来的 exe 拉起来**,
确认它没有立刻退出。

> 跑 `verify:package` / `verify:render:packaged` 之前**必须先关掉正在运行的 Codex
> Updater**。这两个脚本是 spawn 一个真实 exe 再要求它存活若干秒,而应用有单实例锁:
> 已经有一个实例在跑时,新起来的那个会立刻退出,脚本会判成「启动后立刻退出」而失败。
> 这是单实例锁的正常行为,不是打包出了问题。

存在的原因是 2026-10-02 那次事故:索引里 `electron/codex.cjs` 少记了 1 字节,于是排在
它后面的条目全部前移 1 字节,而 `package.json` 恰好是数据区的最后一条,那 1 字节正好把
收尾的 `}` 挤出它的声明窗口 —— Electron 报 `Unable to parse .../package.json` 后以退出码
1 结束,用户双击**毫无反应**:没有窗口、没有日志、没有别的信息。当时两道验证都看不见它:
`verify:render:packaged` 只从 asar 里读 `dist/` 和脚本目录,而 `dist/` 排在错位点**之前**,
读出来完全正常;打包出来的 exe 则从来没有被真的启动过一次,CI 构建完就直接传 Release。

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

有**两条**保留策略,按「有没有人在看着」分:

**每日自动化(无人值守)—— 自动剪枝。** 一句话:**缓存里「版本 ≤ 已安装版本」的包,
按版本倒序保留最新 2 个,其余删掉**。

- 下限是 2 而不是 1:新装上的那一版的包,作用是**下一次**更新时的回退目标。只留 1 个
  (只剩刚装上的),下次更新完就没有可退的版本,功能等于不存在。
- 版本**高于**已安装版本的包(已下载未安装)不动;其他应用的包、`.partial` 半成品也不动。
- 按 2 个 800 MB 级的包算,缓存常驻约 **1.67 GB**。

剪枝发生在安装 worker 里(装完就知道新版本号、且正站在缓存目录里),所以安装一结束缓存
就回到 2 个包,不会先涨到 3 个(2.5 GB)再慢慢清。

**桌面应用(有人看着)—— 一个都不删。** 它给三个 PowerShell 调用都加上 `-KeepAll`,
把所有下载过的安装包留在原地,界面上「安装包缓存」卡片显示当前有几个、共占多少,想腾
空间点「清空缓存」(会弹一次确认)。

为什么分成两条:自动剪枝的判据(按版本倒序留 N 个)对用户是**隐形**的 —— 同事发现 C 盘
少了几个 GB 时,界面上一个字都没解释删了什么、为什么删。宁可让磁盘慢慢涨,由人决定什么
时候清。而后台那条路没人看着,不能让它无界增长,所以保持自动剪枝。

`-KeepAll` 是独立开关而不是把 `-KeepCount` 调大:`-KeepCount` 是「留 N 个」,`0` 表示
一个不留(照旧删光),没有任何取值等于「不限制」。

「清空缓存」只删 `Get-CachedCodexPackages` 认得出来的 Codex 安装包 —— 下载中的
`.partial`、别的应用的包、用户自己放进缓存目录的东西都不碰。缓存目录是用户自己选的任意
文件夹,这个动作**不等价于对整个目录 `rm -rf`**。删不掉的(被杀毒软件或安装进程占着)
会逐个记下来报给界面,不中断整批。

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

# 清空缓存里的全部 Codex 安装包(桌面应用那颗「清空缓存」按钮跑的就是它)
# 只删认得出来的 Codex 包,不碰 .partial、别的应用、别的文件;删不掉的逐个报出来
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\scripts\clear-cached-codex-packages.ps1 -DownloadDirectory "<缓存目录>"
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
推送仓库改动前请递增该版本(数值 SemVer 风格,当前 `0.6.1`)。GitHub CI 在 PR 和
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
