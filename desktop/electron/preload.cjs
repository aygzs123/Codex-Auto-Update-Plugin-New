const { contextBridge, ipcRenderer } = require("electron");

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
