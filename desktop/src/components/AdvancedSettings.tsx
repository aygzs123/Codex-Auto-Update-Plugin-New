import type { Settings } from "../types";

/**
 * 高级设置：Codex 本体装在哪儿 + 日志 / 诊断入口。
 *
 * **缓存目录的输入框搬走了**，去了上面的「安装包缓存」卡片：那张卡片标题上写着缓存占了
 * 多少（`3 个 · 2.34 GB`），而「占了多少」和「放在哪个盘」是同一个问题的两半，分在两张
 * 卡片里用户就得自己对。这里保留 installLocation，因为它是另一个问题。
 *
 * 下面 links 里那颗「打开缓存目录」刻意留着：它是这张卡片「所有路径的快捷入口」清单的
 * 一员（旁边就是打开日志目录），删掉它并不会让人少一次点击，只会让这个清单缺一块。
 * 缓存目录的**设置**在另一张卡片，入口在两张卡片上都能看到 —— 这是有意的重复。
 *
 * 关于「能不能设置 Codex 的安装位置」：不能，而这正是要把它**显示出来**的原因。
 * MSIX 应用装到哪个盘由 Windows 的部署服务决定（Add-AppxPackage 不带 -Volume 就
 * 落在系统卷），我们的安装器没有发言权 —— 用户在设置里找不到这一项，只会以为是
 * 我们漏做了，或者以为 Codex 一定是装在 C 盘。所以这里做两件事：
 *   1. 把 Get-AppxPackage 报回来的真实路径原样显示（可能是 D:\WindowsApps\...），
 *      让「装哪儿了、C 盘是不是被占了」有据可查，而不是靠猜；
 *   2. 把那个目录**真的打开**给用户看（WindowsApps 那一级是锁的，但包目录本身对
 *      Users 可读，Explorer 打得开）。改默认盘的那条路仍然写在说明文字里 —— 只是
 *      不再占着这颗按钮：用户问过「为什么不是打开路径的」，而他问的是对的，
 *      那颗按钮原来打开的是 Windows 的存储设置页，跟这一行显示的路径没有关系。
 * 真正由本应用控制的是缓存目录（在上面的卡片里）：安装包（几百 MB）先下到那里再交给
 * 系统安装，换盘放它是能省 C 盘空间的。
 */
export function AdvancedSettings({
  settings,
  installLocation,
  cacheDirectory,
  onOpen,
  onOpenInstallLocation,
  onCopyDiagnostics,
}: {
  settings: Settings | null;
  installLocation: string | null;
  /**
   * 「打开缓存目录」要打开的真实路径，由 App 按 effectiveDownloadDirectory 算好传进来。
   *
   * 刻意不在这里自己读 settings：这里以前读的是 defaultDownloadDirectory，于是用户
   * 自定义缓存目录之后，输入框显示的是新目录、旁边的链接却打开旧的默认目录 ——
   * 同一张卡片上两个控件对同一件事给出两种答案。判据只留在 store 那一处。
   */
  cacheDirectory: string;
  onOpen: (path: string) => void;
  /**
   * 打开 Codex 的安装目录。刻意不接收路径参数：它要打开的就是上面那个 installLocation，
   * 而那个值由主进程解析后自己记着 —— 让渲染进程把路径传回去，等于给 open_path 的白名单
   * 开了一个后门（「打开任意目录」）。这里只负责说「打开」。
   */
  onOpenInstallLocation: () => void;
  onCopyDiagnostics: () => void;
}) {
  if (!settings) return null;

  return (
    <details className="panel settings-card">
      <summary>高级设置</summary>
      <div className="settings-body">
        <label className="field-label" htmlFor="install-location">
          Codex 本体安装位置（由 Windows 决定，只读）
        </label>
        <div className="path-row">
          <input
            id="install-location"
            className="field-input"
            readOnly
            value={installLocation ?? "尚未检测到已安装的 Codex"}
            title={installLocation ?? ""}
          />
          <button type="button" className="button" onClick={onOpenInstallLocation}>
            打开安装目录
          </button>
        </div>
        <p className="field-help">
          MSIX 应用装到哪个盘由 Windows 的部署服务决定，安装器（包括本应用）都改不了，
          所以这一项没有可选项。上面显示的是 <code>Get-AppxPackage</code> 报回来的真实路径
          —— 如果你把系统设置里的「新的应用将保存到」改成了别的盘，这里就会显示那个盘上的
          路径。右边的按钮打开的就是这个目录（<code>WindowsApps</code> 这一级是锁着的，
          包目录本身能读，打得开）。要改默认盘，得自己去
          <code>设置 → 系统 → 存储 → 高级存储设置</code>。
        </p>

        <div className="settings-links">
          <button type="button" className="link-button" onClick={() => onOpen(cacheDirectory)}>
            打开缓存目录
          </button>
          <button type="button" className="link-button" onClick={() => onOpen(settings.logsDirectory)}>
            打开日志目录
          </button>
          {/* 复制诊断信息：同事报障时点一下就能把现场粘到聊天窗口里，不必截图。
              刻意不置灰（它不跑命令、瞬间返回），而且最需要它的时刻恰恰是安装刚失败、
              界面还忙着的那个时候。 */}
          <button type="button" className="link-button" onClick={onCopyDiagnostics}>
            复制诊断信息
          </button>
        </div>
      </div>
    </details>
  );
}
