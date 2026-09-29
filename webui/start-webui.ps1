# Codex 更新工具 Web UI 启动脚本
# 双击 webui/start-webui.bat 即可（此脚本由 bat 调用，也可直接运行）。

$ErrorActionPreference = "Stop"

$webuiDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPy = Join-Path $webuiDir "server.py"
$port = 8765
$url = "http://127.0.0.1:$port"

# 检测 Python（py 启动器优先，其次 python / python3）
function Find-Python {
    foreach ($candidate in @("py", "python", "python3")) {
        $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($cmd) {
            return @{ Command = $cmd.Source; Name = $candidate }
        }
    }
    return $null
}

# 快速检测本机端口是否已监听（比 Test-NetConnection 快）
function Test-PortListening {
    param([int]$TargetPort)
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $client.Connect("127.0.0.1", $TargetPort)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

if (-not (Test-Path -LiteralPath $serverPy)) {
    Write-Host "缺少文件：$serverPy" -ForegroundColor Red
    Read-Host "按回车退出"
    exit 1
}

# 已运行则直接打开浏览器
if (Test-PortListening -TargetPort $port) {
    Write-Host "Web UI 已在运行，正在打开 $url"
    Start-Process $url
    exit 0
}

$python = Find-Python
if (-not $python) {
    Write-Host "未找到 Python，请先安装 Python 3 并加入 PATH。" -ForegroundColor Red
    Read-Host "按回车退出"
    exit 1
}

Write-Host "正在启动本地服务（$($python.Name): $($python.Command)）..."
$stdoutLog = Join-Path $webuiDir "server.log"
$stderrLog = Join-Path $webuiDir "server.err.log"

$serverProc = Start-Process -FilePath $python.Command -ArgumentList @(
    $serverPy, "--host", "127.0.0.1", "--port", $port
) -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru

# 等待端口就绪（最长 10 秒）
$deadline = (Get-Date).AddSeconds(10)
while (-not (Test-PortListening -TargetPort $port)) {
    if ((Get-Date) -gt $deadline) {
        Write-Host "服务启动失败，请查看：" -ForegroundColor Red
        Write-Host "  日志: $stdoutLog" -ForegroundColor Red
        Write-Host "  错误: $stderrLog" -ForegroundColor Red
        Read-Host "按回车退出"
        exit 1
    }
    Start-Sleep -Milliseconds 300
}

Write-Host "已就绪，正在打开 $url"
Write-Host "保持本窗口开启即可正常使用；关闭本窗口不会停止 Web UI。"
Write-Host "如需停止服务：任务管理器结束进程 server.py，或运行: Get-Process | Where-Object { $_.Path -like '*webui*' }"
Start-Process $url
