const { contextBridge, ipcRenderer } = require("electron");

/**
 * 首帧之前把已保存的主题写到根节点。
 *
 * 这是防闪白的关键：等 React 启动、get_settings 回来再上色，用户已经看到一帧浅色。
 * 主进程在 whenReady 里已把 settings.theme 同步给 nativeTheme，所以 sendSync 拿到的
 * resolved 就是最终值；拿不到（浏览器预览、测试桩）时退回 matchMedia。
 */
function applyInitialTheme() {
  let theme = null;
  try {
    theme = ipcRenderer.sendSync("desktop:initial-theme");
  } catch {
    theme = null;
  }
  const prefersDark =
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = theme?.resolved || (prefersDark ? "dark" : "light");
  const root = document.documentElement;
  if (!root) return;
  root.dataset.theme = resolved;
  root.dataset.themePreference = theme?.preference || "system";
  root.style.colorScheme = resolved;
}

applyInitialTheme();

contextBridge.exposeInMainWorld("desktop", {
  invoke: (command, args = {}) => ipcRenderer.invoke("desktop:command", command, args),
  onMenuAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("desktop:menu-action", listener);
    return () => ipcRenderer.removeListener("desktop:menu-action", listener);
  },
  // 长任务（下载 / 安装 / 修复）的真实进度。主进程逐条推送，渲染进程只读。
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("desktop:progress", listener);
    return () => ipcRenderer.removeListener("desktop:progress", listener);
  },
  // 更新器自身的安装包下载进度。与 Codex 安装链路分开：两边的 phase 语义不同，
  // 混在一个通道里会让「正在安装 Codex」和「正在下载更新器」互相覆盖。
  onAppUpdateProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("desktop:app-update", listener);
    return () => ipcRenderer.removeListener("desktop:app-update", listener);
  },
  // 系统配色变化（只在偏好为「跟随系统」时界面需要跟随）。主进程推解析后的值，
  // 渲染层不自己再读一次 prefers-color-scheme —— 两条链路会给出不同答案。
  onThemeUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("desktop:theme-updated", listener);
    return () => ipcRenderer.removeListener("desktop:theme-updated", listener);
  },
  // 缓存目录里的文件发生了变化（外部删除 / 新增 / 我们的下载完成）。只发「变了」，
  // 具体内容仍由界面重新执行 list_cached_packages 获取 —— 事件里不带路径，
  // 避免它变成第二个数据来源。
  onCacheChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("desktop:cache-changed", listener);
    return () => ipcRenderer.removeListener("desktop:cache-changed", listener);
  },
  // 缓存迁移进度（复制 / 校验阶段）。与安装进度分开：迁移不会关 Codex。
  onCacheMigrationProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("desktop:cache-migration", listener);
    return () => ipcRenderer.removeListener("desktop:cache-migration", listener);
  },
  window: {
    minimize: () => ipcRenderer.invoke("desktop:window", "minimize"),
    maximize: () => ipcRenderer.invoke("desktop:window", "maximize"),
    close: () => ipcRenderer.invoke("desktop:window", "close"),
    /** 真正退出应用（不是藏到托盘）。 */
    quit: () => ipcRenderer.invoke("desktop:window", "quit"),
    // 最大化状态下按钮要显示「还原」图标：先查一次初始值，再订阅后续变化。
    isMaximized: () => ipcRenderer.invoke("desktop:window", "is-maximized"),
    onStateChange: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("desktop:window-state", listener);
      return () => ipcRenderer.removeListener("desktop:window-state", listener);
    },
  },
  // 后台模式下主进程每 6 小时敲一次，让界面自己再查一遍「是不是最新」。
  // 主进程不发命令、只发「该查了」：走的是和启动时完全相同的那条路径（autoCheckUpdate），
  // 不新增第二条会走网络的代码。
  onBackgroundCheck: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("desktop:background-check", listener);
    return () => ipcRenderer.removeListener("desktop:background-check", listener);
  },
  drag: {
    start: (screenX, screenY) => ipcRenderer.send("desktop:drag-start", { screenX, screenY }),
    move: (screenX, screenY) => ipcRenderer.send("desktop:drag-move", { screenX, screenY }),
    end: () => ipcRenderer.send("desktop:drag-end"),
  },
});
