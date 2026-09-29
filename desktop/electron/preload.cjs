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
    // 最大化状态下按钮要显示「还原」图标：先查一次初始值，再订阅后续变化。
    isMaximized: () => ipcRenderer.invoke("desktop:window", "is-maximized"),
    onStateChange: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("desktop:window-state", listener);
      return () => ipcRenderer.removeListener("desktop:window-state", listener);
    },
  },
  drag: {
    start: (screenX, screenY) => ipcRenderer.send("desktop:drag-start", { screenX, screenY }),
    move: (screenX, screenY) => ipcRenderer.send("desktop:drag-move", { screenX, screenY }),
    end: () => ipcRenderer.send("desktop:drag-end"),
  },
});
