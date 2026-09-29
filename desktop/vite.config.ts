import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 渲染进程只加载本地资源，但它在 contextIsolation + sandbox 之下仍通过 IPC 触发
// PowerShell 命令，所以按最小权限收紧 CSP 是值得的。只在 build 时注入：dev 模式
// 需要 Vite 的 HMR 内联脚本和 ws 连接，注入会直接打断开发服务器。
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function productionCsp() {
  return {
    name: "codex-updater-production-csp",
    apply: "build" as const,
    transformIndexHtml(html: string) {
      return html.replace(
        "</head>",
        `    <meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />\n  </head>`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), productionCsp()],
  // 打包后由 Electron 的 loadFile() 以 file:// 加载，绝对路径 /assets/... 会被解析成
  // 盘符根（file:///C:/assets/...）导致 404 白屏。dev 模式走 http://127.0.0.1:1420
  // 看不出这个问题，所以必须是相对路径。
  base: "./",
  clearScreen: false,
  server: { port: 1420, strictPort: true },
});
