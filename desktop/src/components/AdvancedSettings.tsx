import type { Settings } from "../types";
import { Icon } from "./Icons";

/**
 * 高级设置：Codex 本体装在哪儿 + 日志 / 诊断入口。
 *
 * 缓存目录的输入框在「安装包缓存」卡片里：那张卡片标题上写着缓存占了多少
 * （`3 个 · 2.34 GB`），而「占了多少」和「放在哪个盘」是同一个问题的两半。这里保留
 * installLocation，因为它是另一个问题。
 *
 * 关于「能不能设置 Codex 的安装位置」：不能，而这正是要把它**显示出来**的原因。
 * MSIX 应用装到哪个盘由 Windows 的部署服务决定（Add-AppxPackage 不带 -Volume 就
 * 落在系统卷），我们的安装器没有发言权 —— 用户在设置里找不到这一项，只会以为是
 * 我们漏做了，或者以为 Codex 一定是装在 C 盘。所以这里做两件事：
 *   1. 把 Get-AppxPackage 报回来的真实路径原样显示（可能是 D:\WindowsApps\...），
 *      让「装哪儿了、C 盘是不是被占了」有据可查，而不是靠猜；
 *   2. 把那个目录**真的打开**给用户看（WindowsApps 那一级是锁的，但包目录本身对
 *      Users 可读，Explorer 打得开）。改默认盘的那条路仍然写在说明文字里。
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
   * 刻意不在这里自己读 settings：同一张卡片上两个控件对同一件事给出两种答案，
   * 判据只留在 store 那一处。
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
    <details className="panel settings-card card" open>
      <summary>高级设置</summary>
      <div className="settings-body">
        <div className="set-block">
          <div className="line">
            <strong>Codex 本体安装位置</strong>
            <span className="aside">由 Windows 决定，只读</span>
          </div>
          <div className="path-row">
            <input
              id="install-location"
              className="field-input input"
              readOnly
              value={installLocation ?? "尚未检测到已安装的 Codex"}
              title={installLocation ?? ""}
            />
            <button type="button" className="button" onClick={onOpenInstallLocation}>
              <Icon name="folder" size={14} />
              打开安装目录
            </button>
          </div>
          <p className="field-help">
            MSIX 应用装到哪个盘由 Windows 的部署服务决定，安装器（包括本应用）都改不了。
            上面显示的是 <code>Get-AppxPackage</code> 报回来的真实路径 —— 如果你把系统设置里的
            「新的应用将保存到」改成了别的盘，这里就会显示那个盘上的路径。要改默认盘，得自己去
            <code>设置 → 系统 → 存储 → 高级存储设置</code>。
          </p>
        </div>

        <div className="set-row">
          <div className="label">
            <strong>目录与诊断</strong>
            <p>安装包缓存、运行日志，以及一份可以直接粘给同事的诊断快照。</p>
          </div>
          <div className="settings-links inline">
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
      </div>
    </details>
  );
}
