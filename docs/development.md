# 开发与校验

改这个仓库的人要的细节都在这里。README 只留了三条承重约束的结论，
这份文档写它们的**完整论证**，以及每个 `verify:*` 到底在验什么、为什么非验不可。

## 三条必须遵守的实现约束

### 1. 脚本走 `extraResources`，不能进 asar

PowerShell 无法执行 `app.asar` 内的 `.ps1`，且 `CodexStoreUpdater.psm1` 必须与被调脚本
同目录（每个脚本都用 `Import-Module (Join-Path $scriptRoot "CodexStoreUpdater.psm1")`
定位模块）。`npm run verify:render:packaged` 会校验脚本确实落在 asar 之外。

### 2. 只能调 `powershell.exe`（5.1），不能调 `pwsh`

安装脚本用 `Join-Path $PSHOME "powershell.exe"` 拉起分离的安装 worker；在 pwsh 下
`$PSHOME` 指向 PowerShell 7 目录，那里只有 `pwsh.exe`，`Start-Process` 抛错后整个安装会
静默失败。

提权子进程不能照抄这一句：它的 `Start-Process` 包在「UAC 被拒绝」的 `catch` 里，
路径拼错会被当成用户点了否，报一句与真实原因无关的话 —— 所以它用
`Get-CurrentPowerShellPath`（问当前进程自己的 `Path`，`$PSHOME` 只作兜底）。

**推论：被 App 调用的脚本本身，也只能用 .NET Framework 4.8 里存在的 API。**
解释器既然是 5.1，任何 pwsh 7 / .NET 5+ 专有的静态方法在运行时根本不存在。典型禁区：

| 禁区（.NET 5+ / pwsh 7 才有） | 5.1 下的写法 |
| --- | --- |
| `[System.Security.Cryptography.SHA256]::HashData()` | `[System.Security.Cryptography.SHA256]::Create()` + `ComputeHash()` |
| `[Convert]::ToHexString()` | `[System.BitConverter]::ToString()` |

`::new()` 是安全的（PowerShell 5.0 起支持）。

2026-10-02 的「点击修复资源副本没反应」就栽在这里：`repair-codex-desktop-bundles.ps1`
用了 `HashData()`，而它是 `Get-BundleId` 的第一行 —— 脚本在写任何东西之前就抛，
用户目录零残留、界面只闪一下。人工用 pwsh 7 手动跑是通的，所以这个 bug 躺了很久：
**人工验证不能替代 5.1 验证**。详见
[`codex-desktop-encrypted-copy-fix/README.md`](codex-desktop-encrypted-copy-fix/README.md) §7.1。

### 3. 参数不能靠数组展开传递

`@argv` 传的是位置参数值而不是参数名，会把开关当成字符串值绑到第一个位置参数上。
`electron/ps.cjs` 因此自己拼 token：开关原样写、值一律单引号包裹（单引号是 PowerShell 里
唯一不做展开的字面量）。

## 路径必须通用，不能绑定本机

每个用户的安装位置都不一样，所以脚本里**不允许出现写死的路径特征**：

- 判断进程是否属于 Codex 包，一律用 `Get-CodexPackageProcess`，按包自己的
  `InstallLocation` 前缀匹配 —— 而不是字面量 `*\WindowsApps\<包名>_*`。MSIX 可以
  装在别的盘或别的目录，写死目录名在那些机器上会一个进程都匹配不到，把正常状态
  报成故障，或者该关掉的进程没关掉、留着锁文件；
- `AppUserModelId` 优先从已安装包的 `AppxManifest.xml` 解析 `<Application Id>`，
  兜底值也必须是 manifest 里真实存在的那个 id（`App`），而不是猜的 `Codex`；
- 读取进程 `.Path` 会因权限抛错，必须逐个 `try/catch` —— 在
  `$ErrorActionPreference='Stop'` 下，一个受保护进程就能中断整条管道。

这三条都有回归测试钉住（`plugins/codex-ms-desktop-updater/tests/CodexStoreUpdater.Tests.ps1`
与 `desktop/tests/launch.test.cjs`）。另外有一条更硬的：**生产代码里一个盘符路径字面量
都不许有**，由 `desktop/tests/install-location.test.cjs` 逐行扫描脚本 / 渲染进程 /
主进程来保证 —— 这类 bug 在开发机上（C 盘）永远不会显形。

## 校验命令

```powershell
npm test                        # 解析层 + PowerShell 拼装层 + 窗口/结论对话框/安装位置/命令锁/修复路径接线/启动自动检查单元测试，不联网
npm run verify:render           # 把 dist/ 真正加载进 Electron，跑十三个界面场景
npm run verify:render:packaged  # 同上（已安装/未安装/窗口缺失），校验 app.asar 产物与 asar 外的脚本布局
npm run verify:package          # 验收打包产物：app.asar 索引自洽 + 打出来的 exe 真的能起来（需先打包）
npm run verify:backend         # 真实调用内置脚本（含网络），校验解析对得上脚本输出
npm run verify:simulate        # 模拟安装流程：不下载不安装，只跑进度管线
npm run verify:launch          # 真机启动一次 Codex 并等主窗口（会真的把 Codex 拉起来）
```

> 跑 `verify:package` / `verify:render:packaged` 之前**必须先关掉正在运行的
> Codex Updater**。这两个脚本是 spawn 一个真实 exe 再要求它存活若干秒，而应用有单实例
> 锁：已经有一个实例在跑时，新起来的那个会立刻退出，脚本会判成「启动后立刻退出」而失败。
> 这是单实例锁的正常行为，不是打包出了问题。

## `verify:render` 的十三个场景

「十三个」是 `desktop/package.json` 里 electron 调用的次数（去重后只有 12 个不同标志，
下拉菜单按默认宽度和 760px 窄窗口各跑一遍），不是 12 个。

- **启动第一段**（`--boot`）—— 把 bootstrap 的第一条命令 `get_settings` **挂住不返回**，
  界面就停在「正在读取本机」那一段上。启动是两段的：先只读本机（`Get-AppxPackage` +
  资源清单，不走网络），再联网查最新版。这一段只有一次 IPC 往返、快到一闪而过，不挂住
  根本量不到，而它恰好是最容易让人以为「卡住了」的时候。断言主区大字说的是在**读本机**、
  副标题交代了**不联网**、小标题不再掉到「One-click Setup」（标题说着在读本机、小标题
  却在承诺一键安装，两句话互相拆台），以及最硬的一条：**此刻 `check_update` 发出 0 次**
  —— 本机还没读完，网络那一步一个字节都不该发。这一整段来自反馈「读取本机的时候应该
  给一下更好的提示吧，不然不知道」。
- **已安装** —— 启动自动检查跑完后主按钮变「一键更新到 X」，顶栏写着「已安装 X ·
  可更新到 Y」，外加 5 个健康组件行。另外断言顶栏写出了「上次检查 HH:MM」：一个没有
  时间戳的「可更新到 X」无法判断是不是上周留下的结论。
- **未安装** —— **这个 exe 的主用途**：「一键安装 Codex」，且断言**一个字节的
  `check_update` 都没发出去** —— 没装就没有「是不是最新」可言。
- **已是最新** —— 启动后什么都不点，顶栏就该写着「 · 已是最新」、**主区标题写着
  「已是最新版：X」并带上版本号**、主按钮变「打开 Codex」、次按钮「仅检查更新」隐去，
  而且**没有弹出任何对话框**。这几条正是「启动只读版本，必须点一下才知道是不是最新」
  那个反馈的回归测试；主区标题那一条针对的是另一个反馈：「第一次检测后显示的已安装 X
  启动所需资源完整 不太对吧，应该显示已是最新版」。
- **安装进度流** —— 不确定进度条 → 百分比推进 → 软告警 → 日志区。
- **打开 Codex 但主窗口没出现** —— 断言窗口缺失横幅、修复按钮可点且没被遮挡、
  原始诊断仍在页面上。
- **命令结论对话框** —— 从菜单触发「检查更新」，断言对话框**水平垂直都居中**、完整落在
  视口内、确认按钮命中测试通过且已获得焦点、点完真的关闭，顺带断言页面上不再有任何
  `.toast`，以及**手动点之前没有对话框**（启动那次自动检查必须是静默的，弹框与否取决于
  谁触发的）。
- **命令执行中的交互锁** —— 桩把 `check_update` **挂住不返回**，于是**启动时那次自动
  检查本身就提供了「命令跑着」的窗口**：先按主按钮 disabled 轮询确认界面已经置忙，
  再连发四次命令断言 `check_update` 的 IPC 次数**没有增加** —— `disabled` 只说明按钮点
  不动，证明不了快捷键那条路，所以这里数的是真实 IPC；最后放行，断言界面**重新点得动**，
  标志位漏清就会在这里露出来。它同时是唯一能看到「本机读完了、结论还在网络上飞」这个
  中间态的场景，于是顺带钉住主区副标题必须自己声明**「正在向 Microsoft Store 分发源
  查询最新版本…」**：那几秒里大字写着「已安装 X」，一个看起来已经定稿的答案，用户会以为
  查完了、只是没查到最新版；反过来，结论一旦回来还挂着这半句就是一句过期的谎话，
  所以别的场景反向断言它**不许出现**。
- **下拉菜单** —— 默认宽度 + 760px 窄窗口各跑一遍。

除内容断言外，它还会把内容区滚到底，确认窗口按钮仍在视口内（顶栏没被内容顶走），并校验
卡片上的装饰圆点（红黄绿三个、够圆、且没有变成可点元素）、窗口按钮的可点尺寸，以及对
菜单项做命中测试 —— 菜单坐标正确但被内容盖住这种「量得到、点不到」的问题，只有命中测试
能发现。菜单场景还会真的点一次「诊断 → 复制诊断信息」，把剪贴板内容读回来断言它是一份
完整现场（应用与 Codex 版本、更新结论、健康结论、5 个组件、缓存目录、日志路径），并确认
这个入口在**界面置忙时仍然可点** —— 同事报障时正是安装刚失败的那一刻。

窄窗口那一遍专门盯住「窗口拖小后菜单不许消失、也不许和窗口按钮或顶栏右边界撞上」，
并逐行量「高级设置」里**每一条**路径行的按钮有没有折行或被挤压。安装位置那一行断言的
是桩数据里那个 **D 盘**路径被原样显示出来。

每个场景还会展开**全部**设置卡片（不是只展开第一张）去量「安装包缓存」卡片：summary
写出「N 个 · X GB」、有「打开缓存目录」、有「清空缓存」按钮且**置忙时是灰的**、以及
「版本历史」开关的勾选状态 —— 缓存清单读不出来时必须是「占用未知」而不是「0 个」，
后者会让用户以为缓存是空的。

自动检查是异步的（`bootstrap` 刻意不 `await` 它），所以脚本在「界面就绪」之后还会轮询
顶栏，等结论真的落到 `.build` 那一行再断言 —— 少了这段等待，那些断言就是在跟一次异步
IPC 赛跑，快机器上绿、慢机器上红。

`verify:render:packaged` 跑其中的「已安装 / 未安装 / 窗口缺失」三遍：打包产物才是用户
真正拿到的那一份，而这两条路径（exe 的主用途、官方 bug 的可见形态）最不能被打包差异
悄悄弄坏。它同时校验 5 个脚本确实落在 `app.asar` 之外。

> `verify:render` 加载的是 `dist/`（打包态是 `app.asar` 里的 `dist/`），**不读 `src/`**。
> 改完 `src/` 做反证前必须先 `npm run build`，否则量到的还是上一次构建的界面，
> 反证会「通过」，得到一个假绿。

## `verify:package` 与 asar 少记 1 字节那起事故

`verify:package` 验收的是**产物本身**，已挂进 `electron:build` 与 `electron:build:local`，
所以每次打包都会跑 —— 本地和发 Release 的 CI 都绕不过去。它做两件事：

1. 校验 `app.asar` 的索引自洽。数据区是紧凑排布的，「所有条目声明的大小之和」必须
   **恰好等于**「文件长度 - 数据区起点」，少一个字节就说明写进去的内容和索引记的不是
   同一份，排在错位点之后的条目会整体偏移；
2. **真的把打包出来的 exe 拉起来**，确认它没有立刻退出。

存在的原因是 2026-10-02 那次事故：索引里 `electron/codex.cjs` 少记了 1 字节，于是排在
它后面的条目全部前移 1 字节，而 `package.json` 恰好是数据区的最后一条，那 1 字节正好把
收尾的 `}` 挤出它的声明窗口 —— Electron 报 `Unable to parse .../package.json` 后以退出码
1 结束，用户双击**毫无反应**：没有窗口、没有日志、没有别的信息。

当时两道验证都看不见它：`verify:render:packaged` 只从 asar 里读 `dist/` 和脚本目录，
而 `dist/` 排在错位点**之前**，读出来完全正常；打包出来的 exe 则从来没有被真的启动过
一次，CI 构建完就直接传 Release。

## `verify:simulate` 的四个场景

它是唯一能在**不真的装一次 Codex**的前提下看到完整安装过程的手段。安装的大部分时间花在
`Add-AppxPackage` 上，它是安静的长任务，没有百分比也没有回调，唯一可观测通道是 worker
写的日志文件。

这个脚本喂进格式与措辞都取自真实 `Write-InstallLog` 调用的日志，走一遍真实的
`tailInstallLog` 管线，把进度事件按时间线打出来，并断言进度不回退、静默期爬升不越过
里程碑、失败路径能收到补救提示。四个场景：`ok` / `slow-install`（8 秒静默，演示进度
爬升）/ `cleanup-warning` / `window-missing`（官方 bug 的结局）。

```powershell
npm run verify:simulate -- --scenario window-missing
```

## `verify:launch` 的退出码

**真机**校验，会真的启动 Codex 并等主窗口出现，按时间线打印阶段与日志。
退出码：`0` 主窗口出现 / `3` 进程在但窗口没出现 / `1` 出错。它不在默认校验链里，
因为它会改动本机状态（把 Codex 拉起来）。

## `EPERM: ... rename 'win-unpacked.tmp' -> 'win-unpacked'`

打包报这个错时，直接用本地已解压的 Electron，跳过「解压到 `.tmp` 再改名」那一步：

```powershell
npm run electron:build:local
# 等价于 npx electron-builder --win nsis -c.electronDist=node_modules/electron/dist
```

原因是本机的安全软件/索引器会攥住刚解压出来的
`win-unpacked.tmp\resources\default_app.asar`（实测：该文件可被只读共享打开，说明有人持着
读句柄），而 **Windows 只要目录里有文件被占用就拒绝重命名整个目录** —— 于是
electron-builder 在最后一步改名时失败。

这不是项目配置问题，但**重试通常没用**（实测连续三次、间隔二十多分钟仍然失败，占用不是
短时的）。`-c.electronDist` 那一路直接复制 `node_modules/electron/dist`，既不改名也不解压，
因此不受影响；代价是不再校验下载来的 Electron 压缩包完整性（该包本身已由 `npm install`
校验过）。

## 版本管理与 CI

插件版本唯一来源是
`plugins/codex-ms-desktop-updater/.codex-plugin/plugin.json` 的 `version` 字段。
推送仓库改动前请递增该版本（数值 SemVer 风格）。

版本闸门**不看改动路径**：改 `desktop/`、改文档、改 CI 配置，一样要 bump，否则 CI 红。
GitHub CI 在 PR 和 push 到 `main` 时运行 `tools/Test-PluginVersionBump.ps1`，要求 head
版本大于基线版本。

CI 有两个并行 job（`.github/workflows/ci.yml`）：`test`（PowerShell 测试 + 版本闸门）
与 `desktop`（`npm test` + `npm run verify:simulate`）。桌面端的 Release 由
`.github/workflows/desktop-release.yml` 在 `desktop-v*` 标签上触发（见
[`../desktop/README.md`](../desktop/README.md)）。

## 测试

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\Install.Tests.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\codex-ms-desktop-updater\tests\CodexStoreUpdater.Tests.ps1
```

`desktop/tests/*.test.cjs` 是**源码文本契约断言**，直接读源码文件比对，不需要构建。
切片边界要写 `\r?\n`：CI 是 CRLF 检出、本地是 LF，写死 `\n` 会导致本地永远复现不出 CI。
