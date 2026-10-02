# Codex Desktop(Windows 商店版)「启动后无窗口」修复记录

> 适用仓库:`Codex-Auto-Update-Plugin`
> 记录日期:2026-09-07
> 涉及版本:OpenAI.Codex `26.901.6511.0`(内部 Electron build `152.0.7977.83`)
> 配套脚本:[`repair-codex-desktop-bundles.ps1`](./repair-codex-desktop-bundles.ps1)

## 1. 一句话结论

Codex Desktop 在**每次启动早期**要把它安装在加密 MSIX 目录里的内置组件(codex.exe、rg、WSL 助手、cua_node 运行时等)复制到普通用户目录。它用的 Node.js `copyFile` 在复制这类**带 `Encrypted` 文件属性**的文件时稳定失败(`errno=-4094` / `code=UNKNOWN`),而 App 自带的补救逻辑只认 `errno=6000` 没有兜住——于是组件搬不过去、启动引导被阻断,**进程活着、响应正常,但主窗口永远不创建**。

这是 **OpenAI 官方 App 的 bug,不是本机权限/安装问题**,也没有被 `26.901` 修复。

## 2. 问题现象

- 双击桌面图标 / 通过商店入口启动,**没有任何窗口出现**;
- 任务管理器里能看到多个 `ChatGPT.exe`(Electron 主进程 + crashpad + 渲染基础设施)全部 `Responding=True`,但 `MainWindowHandle` 全为 `0`;
- 用 Win32 `EnumWindows` 枚举,只能看到搜狗输入法、`Chrome_StatusTrayWindow`、crashpad 等**不可见基础设施窗口**,没有任何可见主窗口;
- 干净杀掉进程后重启动依然复现——不是"僵尸实例抢锁"。

## 3. 根因机制

```text
加密的 MSIX 资源 (C:\Program Files\WindowsApps\...\app\resources\*, 带 Encrypted 属性)
        ↓  App 使用 Node fs.copyFileSync 复制到用户缓存
        返回 errno=-4094, code=UNKNOWN
        ↓  官方兜底仅匹配 errno===6000, 未命中
        运行时缓存未生成 / 半途失败(留下 .staging-*)
        ↓  启动 bootstrap 被阻断
        主窗口永不创建
```

### 3.1 为什么不是权限问题(本机实测证据)

用 Node 对同一个带 `Encrypted` 属性的源文件做三种操作:

```text
[readable]       源文件可完整读取, sha256 可算      → 不是 ACL/读权限问题
[copyFileSync]   失败 errno=-4094 code=UNKNOWN syscall=copyfile   ← App 用的方法
[stream]         成功, 目标 sha256 与源完全一致, 且不带 Encrypted 属性
```

- PowerShell / Node 都能打开并读取 `WindowsApps` 下的源文件;
- 源文件可被完整读取并计算 SHA-256;
- 字节流(`read stream → write stream`)复制成功且内容一致,落盘文件不再带 `Encrypted` 属性。

结论:**失败点是 Windows 加密文件的复制语义(App 用了错误的复制 API),而非"没权限"。** 因此修改 `WindowsApps` 的 ACL / 所有权 / 关闭加密都不会修复,反而破坏包签名与 Store 更新能力,一律不做。

## 4. 影响面:哪些"包 → 用户目录"复制路径会踩中

| 组件 | 目标根目录 | 语义 |
|---|---|---|
| Windows CLI(codex.exe 等 4 个) | `%LOCALAPPDATA%\OpenAI\Codex\bin\<id>` | 失败则找不到 Codex CLI |
| Windows rg | `%LOCALAPPDATA%\OpenAI\Codex\bin\<id>` | 失败则搜索功能异常 |
| WSL CLI(codex、codex-code-mode-host) | `%USERPROFILE%\.codex\bin\wsl\<id>` | 失败则 WSL 模式异常 |
| WSL rg | `%USERPROFILE%\.codex\bin\wsl\<id>` | 同上 |
| `cua_node` 运行时(整树 ~4000 文件) | `%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\<id>` | 失败则 computer-use 等异常 |
| bundled plugins(整个 marketplace) | `%USERPROFILE%\.codex\.tmp\bundled-marketplaces\openai-bundled` | 失败则内置插件无法物化 |

> 各组件缓存目录名 = 该组件描述文件的 **bundle ID**(见第 6 节),不同版本 ID 不同。

### 4.1 本次(26.901)实测的失败形态

- `cua_node`:App 反复尝试物化到 bundle `b474a88d5d105afa`,在 `runtimes\cua_node\` 下留下 **11 个 `.staging-b474a88d5d105afa-*` 残留**(每个几百到两千多个文件,均为失败的部分拷贝);
- bundled plugins:`.materialization-key` 从未生成;`plugins\cache\openai-bundled` 里的 `chrome` 停留在**旧版 26.707**;
- Windows CLI 那组(内部 build 152 相对新):这次 App 自己物化成功了(`bin\8e5b6932251c2c1c`,4 个文件均未加密)——说明官方对**主 CLI** 的复制路径部分修正,但 `cua_node` / 插件 / WSL 的递归复制路径仍未统一修。

## 5. 前置判断(做修复前先确认)

出现"进程在、无窗口"时,先做两件事:

1. **确认是否就是这个 bug**:对任一源资源跑一次 `copyFileSync`,看是否 `-4094`(见 3.1);
2. **确认哪些缓存缺失**:对比第 4 节各目标目录是否存在、内容是否与源一致。

> 如果窗口能正常出现、只是某些功能(插件)版本落后,不一定需要走完整修复;见第 10 节。
>
> **注意**:桌面端只在目标目录**不在、且留着 `.staging-*` / `.repair-*` 中转目录**时才
> 给出「修复资源副本」入口(见 `desktop/electron/parse.cjs` 的 `healthRepairTargets`)。
> 目录**仅仅不存在**(健康检查里的 `[MISS ]`)不算这个 bug 的证据 —— 首次启动前五个组件
> 全是这个状态,App 会按需物化。另外 `[ERR  ]`(连 MSIX 自己的源文件都缺)也不会给入口,
> 因为修复脚本正是从那份源复制,那种情况下它会在算 bundle ID 时就抛出。

## 6. Bundle ID 计算

App 对每个组件的"描述文件"按**固定顺序**拼接:

```text
relative_path + '\0' + sha256hex(lowercase) + '\0'
```

全部拼接后再做一次 SHA-256,取前 16 个十六进制字符,即为该组件缓存目录名。

- **顺序是算法的一部分**,不能先排序再算;
- 不同包版本描述文件内容变化 → ID 变化 → 旧缓存全部作废。

各组件描述文件(顺序即算法顺序):

```powershell
win-cli  = codex.exe, codex-code-mode-host.exe, codex-windows-sandbox-setup.exe, codex-command-runner.exe   # 相对 app\resources
win-rg   = rg.exe                                                                                            # 相对 app\resources
wsl-cli  = codex, codex-code-mode-host                                                                       # 相对 app\resources
wsl-rg   = rg                                                                                                # 相对 app\resources
cua_node = manifest.json, bin/node.exe, bin/node_repl.exe                                                    # 相对 app\resources\cua_node
```

> 本机 26.901 实测 ID(供核对,不要照抄到其它版本):
>
> ```text
> win-cli   = 8e5b6932251c2c1c      win-rg  = c60635126245daef
> wsl-cli   = b53f5e5f7452dd19      wsl-rg  = 1a4f6f66dd2f3710
> cua_node  = b474a88d5d105afa
> ```

## 7. 修复方法

### 7.1 用仓库内脚本(推荐,幂等)

```powershell
# 在项目根执行(建议用 pwsh 7+):
powershell -NoProfile -ExecutionPolicy Bypass -File docs/codex-desktop-encrypted-copy-fix/repair-codex-desktop-bundles.ps1
```

脚本行为:

1. 自动探测当前安装的 `OpenAI.Codex` 版本;
2. 结束正在运行的当前包 `ChatGPT.exe`(避免文件占用 / 与 App 竞争复制);
3. 动态计算五组 bundle ID;
4. 逐组件:目标已存在且逐文件 SHA-256 一致 → `SKIP`;缺失/不匹配 → 先改名备份 `*.pre-repair-<时间戳>`,再
   **字节流复制到 `.repair-*` staging → 全量校验 → 原子改名为最终 bundle ID**;
5. 输出每组件 `OK / SKIP` 与最终路径。

安全边界(与脚本外一致):

- 只写 `%LOCALAPPDATA%\OpenAI\Codex` 与 `%USERPROFILE%\.codex`;
- **绝不改动 `C:\Program Files\WindowsApps` 下的任何文件 / ACL / 所有权**;
- staging 必须逐文件校验 SHA-256 与未加密属性后才改名;
- 每次重跑对健康缓存都是 `SKIP`,不会破坏已修好的状态。

### 7.2 手动要点(脚本等价逻辑)

1. 确认 App 未运行;
2. `%LOCALAPPDATA%\OpenAI\Codex` 与 `%USERPROFILE%\.codex` 定位;
3. 对缺失组件:建 staging → 字节流逐文件复制(保留空目录)→ 比对相对文件集、大小、SHA-256、确认不带 `Encrypted` → 原子改名;
4. `cua_node` 必须整树复制,不是只复制 manifest + 两个 exe。

### 7.3 修复后

用商店白色入口重新启动:

```powershell
Start-Process explorer.exe -ArgumentList 'shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App'
```

## 8. 本次修复验证结果(2026-09-07)

| 组件 | bundle 目录 | 结果 |
|---|---|---|
| win-cli | `bin\8e5b6932251c2c1c` | 本就成功,复核 SKIP |
| win-rg | `bin\c60635126245daef` | 物化成功,`rg --version` = ripgrep 15.2.0 |
| wsl-cli | `.codex\bin\wsl\b53f5e5f7452dd19` | 物化成功 |
| wsl-rg | `.codex\bin\wsl\1a4f6f66dd2f3710` | 物化成功 |
| cua_node | `runtimes\cua_node\b474a88d5d105afa` | 物化成功,`node --version` = v24.19.0 |
| **App 主窗口** | — | ✅ 出现,标题 ChatGPT,进程来自当前包 |

修复后再次启动,App 不再在 `cua_node` 建 staging,并把历史 12 个失败 staging 清理为 0 → **证明 App 接受并复用了我们物化的缓存**。

## 9. 遗留问题:bundled plugins 仍未为当前版本物化

- 本次修复后**主界面能正常打开**;插件物化失败**不再阻断主窗口**;
- 但 `.codex\.tmp\bundled-marketplaces\openai-bundled\.materialization-key` 仍未生成,`plugins\cache\openai-bundled\chrome` 停留在旧版 `26.707`(历史缓存);
- 原因仍是同一个加密复制 bug(资源 `app\resources\plugins` → 用户目录)。

若需要让内置插件(browser、computer-use 等)按当前版本完整物化,可参考外部指南第 9.5–9.9 节的"插件恢复镜像 + 进程级变量引导"做法。注意:

- 覆盖变量 `CODEX_ELECTRON_BUNDLED_PLUGINS_RESOURCES_PATH` 只能用**进程级临时变量**引导一次,不要写入用户/系统环境;
- 引导完成后恢复普通入口启动,确认 `.materialization-key` 在无覆盖变量时保持稳定。

本次因主界面已恢复、不破坏用户当前会话,未执行插件引导;按需再做。

## 10. 什么时候不需要修复

若窗口能正常出现,只是少数功能异常,**不必**跑完整物化——先确认缺失的是否只是插件版本落后,必要时单独处理插件物化即可。

## 11. 回滚

本修复只在用户目录写缓存 + 对被替换的旧目录做了 `*.pre-repair-<时间戳>` 备份,不改 `WindowsApps`。要回退时:

1. 退出 App;
2. 将备份目录改名还原(或直接删掉手工物化目录,让 App 下次自行尝试——若官方已修复则会成功);
3. 确认用户级 `CODEX_CLI_PATH` / `CODEX_ELECTRON_BUNDLED_PLUGINS_RESOURCES_PATH` 均为空:
   ```powershell
   [Environment]::SetEnvironmentVariable('CODEX_CLI_PATH', $null, 'User')
   [Environment]::SetEnvironmentVariable('CODEX_ELECTRON_BUNDLED_PLUGINS_RESOURCES_PATH', $null, 'User')
   ```

## 12. 与上游 / 未来的关系

- 这是 **OpenAI 官方 bug**,社区/官方 issue 持续跟踪:
  - `openai/codex` #40700(Windows App cannot locate bundled Codex CLI)
  - `openai/codex` #40752(Current Windows Store release reports the same relocation failure)
  - `openai/codex` #38696(相关加密资源迁移问题)
- 本修复只是**本地绕过**,不是根治;
- **每次 Store 更新后若复发,直接重跑第 7.1 节脚本**即可(脚本动态算 ID,可跨版本);
- 若官方新包已修复(日志不再出现 relocation 失败、App 能自行生成缓存),则不再需要本脚本,重跑也只会 `SKIP`。

## 13. 参考来源

- 本仓库记录为本机 2026-09-07 实测;
- 方法与算法参考用户本地文档《chatgpt-app-codex-cli-msix-copy-failure-repair-guide.md》(2026-08-26 修复旧版 26.820 时留档),已按其 26.901 重新计算 ID 并验证。
