#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Codex Desktop 更新工具 Web UI —— 本地桥接服务。

前端按钮 → 本服务代执行项目内 PowerShell 脚本 → SSE 推送实时日志。
零第三方依赖（仅 Python 标准库），仅监听 127.0.0.1。
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import subprocess
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# 项目根（webui/ 的上级）
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN_SCRIPTS = os.path.join(
    PROJECT_ROOT, "plugins", "codex-ms-desktop-updater", "scripts"
)
PLUGIN_MANIFEST = os.path.join(
    PROJECT_ROOT, "plugins", "codex-ms-desktop-updater", ".codex-plugin", "plugin.json"
)
INDEX_HTML = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")

# action 白名单 —— 只允许执行项目内固定脚本 + 固定参数，外部不可注入任意命令
ACTIONS = {
    "check_codex": {
        "label": "检查 Codex 更新",
        "script": "check-codex-update.ps1",
        "args": ["-CheckOnly", "-NoProxy"],
    },
    "install_restart": {
        "label": "下载并安装 + 重启",
        "script": "check-codex-update.ps1",
        "args": ["-InstallWithRestart", "-NoProxy"],
    },
    "check_plugin": {
        "label": "检查插件更新",
        "script": "update-installed-plugin.ps1",
        "args": ["-CheckOnly", "-NoProxy"],
    },
    "update_plugin": {
        "label": "更新插件",
        "script": "update-installed-plugin.ps1",
        "args": ["-NoProxy"],
    },
    "check_health": {
        "label": "健康自检（不启动）",
        "script": "check-codex-desktop-health.ps1",
        "args": [],
    },
    "check_health_probe": {
        "label": "健康自检 + 窗口探测",
        "script": "check-codex-desktop-health.ps1",
        "args": ["-Probe"],
    },
}

# 状态查询：已安装版本 + 运行进程数 + 是否有可见主窗口（输出 JSON）
# window=1 表示存在带主窗口的进程；window=0 且 processes>0 即为
# “进程在跑但主窗口不出现”的加密资源搬迁失败特征。
_STATUS_CMD = (
    "$pkg = Get-AppxPackage -Name OpenAI.Codex | "
    "Sort-Object Version -Descending | Select-Object -First 1;"
    "$v = if ($pkg) { [string]$pkg.Version } else { '' };"
    "$procs = @(Get-Process -ErrorAction SilentlyContinue | "
    "Where-Object { $_.Path -like '*\\WindowsApps\\OpenAI.Codex_*' });"
    "$p = @($procs).Count;"
    "$w = @($procs | Where-Object { $_.MainWindowHandle -ne 0 }).Count;"
    "if (-not $p) { $p = 0 }; if (-not $w) { $w = 0 };"
    "@{ version = $v; processes = $p; window = $w } | ConvertTo-Json -Compress"
)

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# task_id -> {lock, events, done, exit_code, subscribers}
_tasks: dict[str, dict] = {}
_tasks_lock = threading.Lock()


def find_powershell() -> str:
    """优先 PowerShell 7 (pwsh)，回退 Windows PowerShell 5.1。"""
    pwsh = shutil.which("pwsh")
    if pwsh:
        return pwsh
    ps = shutil.which("powershell.exe")
    return ps if ps else "powershell.exe"


def _build_command(code: str) -> list[str]:
    return [
        find_powershell(),
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        code,
    ]


def build_action_command(script_path: str, args: list[str]) -> list[str]:
    """构造执行项目脚本的命令：UTF-8 输出 + 不弹窗。"""
    quoted = script_path.replace("'", "''")
    arg_text = " ".join(args)
    code = (
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"
        f" & '{quoted}' {arg_text}"
    )
    return _build_command(code)


def build_status_command() -> list[str]:
    code = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" + _STATUS_CMD
    return _build_command(code)


def run_action(action: str) -> str:
    """按白名单启动一个任务，返回 task_id。"""
    if action not in ACTIONS:
        raise ValueError(f"Unknown action: {action}")
    task_id = uuid.uuid4().hex
    task = {
        "lock": threading.Lock(),
        "events": [],
        "done": False,
        "exit_code": -1,
        "subscribers": [],
    }
    with _tasks_lock:
        _tasks[task_id] = task
    threading.Thread(target=_execute_task, args=(task_id, action), daemon=True).start()
    return task_id


def _broadcast(task_id: str, event: str, data: dict) -> None:
    with _tasks_lock:
        task = _tasks.get(task_id)
    if task is None:
        return
    item = {"event": event, **data}
    with task["lock"]:
        task["events"].append(item)
        subscribers = list(task["subscribers"])
    for sub in subscribers:
        sub.put(item)


def _execute_task(task_id: str, action: str) -> None:
    """后台执行 PowerShell 脚本，逐行广播日志。"""
    spec = ACTIONS[action]
    script = os.path.join(PLUGIN_SCRIPTS, spec["script"])
    cmd = build_action_command(script, spec["args"])
    task = _tasks[task_id]
    try:
        _broadcast(task_id, "start", {"label": spec["label"]})
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=_NO_WINDOW,
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.rstrip("\r\n")
            if line:
                _broadcast(task_id, "log", {"line": line})
        proc.wait()
        task["exit_code"] = proc.returncode
    except Exception as exc:  # 记录后结束任务，避免线程悬挂
        _broadcast(task_id, "log", {"line": f"ERROR: {exc}"})
        task["exit_code"] = 1
    finally:
        task["done"] = True
        _broadcast(task_id, "done", {"exit_code": task["exit_code"]})


def _encode_sse(item: dict) -> bytes:
    event = item.get("event", "message")
    data = json.dumps(item, ensure_ascii=False)
    return f"event: {event}\ndata: {data}\n\n".encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "CodexWebUI/0.1"

    def log_message(self, fmt, *args):
        # 抑制默认请求日志（服务在隐藏窗口运行）
        pass

    # ---------- 路由 ----------

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._serve_index()
        elif parsed.path == "/api/status":
            self._serve_status()
        elif parsed.path == "/api/events":
            self._serve_events(parse_qs(parsed.query))
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/run":
            self._serve_run()
        else:
            self._send_json(404, {"error": "not found"})

    # ---------- 实现 ----------

    def _serve_index(self):
        try:
            with open(INDEX_HTML, "r", encoding="utf-8") as f:
                html = f.read()
        except OSError:
            self._send_json(500, {"error": "index.html not found"})
            return
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_status(self):
        status = {"codex_version": "", "codex_processes": 0, "codex_window": 0, "plugin_version": ""}
        try:
            with open(PLUGIN_MANIFEST, "r", encoding="utf-8") as f:
                status["plugin_version"] = json.load(f).get("version", "")
        except (OSError, json.JSONDecodeError):
            pass
        try:
            proc = subprocess.run(
                build_status_command(),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=20,
                creationflags=_NO_WINDOW,
            )
            output = proc.stdout.strip()
            if output:
                data = json.loads(output.splitlines()[-1])
                status["codex_version"] = data.get("version", "")
                status["codex_processes"] = int(data.get("processes") or 0)
                status["codex_window"] = int(data.get("window") or 0)
        except Exception:
            pass
        self._send_json(200, status)

    def _serve_run(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b""
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "invalid JSON body"})
            return
        action = payload.get("action")
        if action not in ACTIONS:
            self._send_json(400, {"error": f"unknown action: {action}"})
            return
        task_id = run_action(action)
        self._send_json(200, {"task_id": task_id, "label": ACTIONS[action]["label"]})

    def _serve_events(self, query):
        task_id = (query.get("task_id") or [""])[0]
        self._stream_sse(task_id)

    def _stream_sse(self, task_id: str):
        with _tasks_lock:
            task = _tasks.get(task_id)
        if task is None:
            self._send_json(404, {"error": "unknown task"})
            return

        sub = queue.Queue()
        with task["lock"]:
            history = list(task["events"])
            already_done = task["done"]
            task["subscribers"].append(sub)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        try:
            for item in history:
                self.wfile.write(_encode_sse(item))
                self.wfile.flush()
            if already_done:
                return
            while True:
                try:
                    item = sub.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                self.wfile.write(_encode_sse(item))
                self.wfile.flush()
                if item.get("event") == "done":
                    break
        except (BrokenPipeError, ConnectionResetError):
            pass  # 客户端断开，任务本身仍由后台线程继续
        finally:
            with task["lock"]:
                if sub in task["subscribers"]:
                    task["subscribers"].remove(sub)

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description="Codex Desktop 更新工具 Web UI")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    print(f"Serving Codex Web UI on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
