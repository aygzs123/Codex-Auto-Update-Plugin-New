// PowerShell 调用层。
//
// 三个硬约束决定了这里的写法：
//
// 1. 只能用 Windows PowerShell 5.1 的 powershell.exe，不能用 pwsh。
//    install-codex-msix-and-restart.ps1 用 Join-Path $PSHOME "powershell.exe" 拉起
//    分离的安装 worker；在 pwsh 下 $PSHOME 指向 PowerShell 7 的目录，那里只有
//    pwsh.exe，Start-Process 会抛错，而 $ErrorActionPreference="Stop" 会让整个安装
//    静默失败。（webui/server.py 优先选 pwsh，装 Codex 那一步实际上是坏的。）
//
// 2. 参数不能用数组展开（@argv）传递。实测：数组展开传的是「位置参数值」而不是
//    参数名，`@('-CheckOnly','-NoProxy','-DownloadDirectory','C:/cache')` 会把
//    $PackageName 覆盖成字符串 "-CheckOnly"、$DownloadDirectory 覆盖成 "-NoProxy"，
//    真正的开关完全不生效。所以这里自己拼 token：开关原样写、值一律单引号包裹。
//    单引号字符串是 PowerShell 里唯一不做任何展开的字面量，因此值里带引号、$、反引号
//    都安全，也不会把值误当参数名。
//
// 3. 需要 [Console]::OutputEncoding=UTF8 前缀。否则 5.1 按 OEM 代码页输出（中文系统
//    是 936），非 ASCII 的安装路径会变成乱码。这也是不能用 -File 的原因：-File 没法
//    插入这段前缀。
//
// 4. 必须显式把退出码带出来（末尾的 exit $LASTEXITCODE）。实测在 -Command 里用
//    `& '脚本'` 调用时，脚本内的 exit N 只结束该脚本、不会结束宿主进程，-Command
//    最终返回的是 1 而不是 N。而退出码是数据：check-codex-desktop-health.ps1 用
//    0/1/2/3 表达健康/降级/未安装/无窗口，被压平成 1 就会把没装 Codex 的机器报成
//    已安装 —— 正是「一键安装」最要紧的那个场景。补上 exit $LASTEXITCODE 后实测
//    三类都正确：显式 exit N → N，正常走完 → 0，脚本内部原生命令失败后正常走完 → 0
//    （脚本里对 $LASTEXITCODE 的赋值不会回泄到父作用域，所以不存在污染）。

const { spawn } = require("node:child_process");

const POWERSHELL = process.platform === "win32" ? "powershell.exe" : "pwsh";

const BASE_FLAGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];

// 开关和参数名的白名单形状。值永远走单引号，所以不可能伪装成开关。
const FLAG_PATTERN = /^-[A-Za-z][A-Za-z0-9]*$/;

/** 按行切分流式输出，最后一段无换行的内容不当作完整行（避免半行误报）。 */
function createLineSplitter(onLine) {
  let buffer = "";
  return (chunk, flush = false) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/);
    buffer = flush ? "" : parts.pop();
    for (const part of parts) {
      if (part.length > 0) onLine(part);
    }
    if (flush && buffer.length > 0) onLine(buffer);
  };
}

/** 单引号字面量：内部单引号写两遍即转义，其余字符原样。 */
function quoteValue(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// 见文件头第 4 条：UTF-8 前缀 + 显式带出退出码。
const UTF8_PREAMBLE = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8";
const PROPAGATE_EXIT = "; exit $LASTEXITCODE";

/** 把一段 PowerShell 代码包成「设好编码、跑完带着退出码退出」的完整命令。 */
function wrapCommand(body) {
  // 先归零，避免同一条命令串里残留的旧 $LASTEXITCODE 被当成脚本的退出码。
  return `${UTF8_PREAMBLE}; $LASTEXITCODE = 0; ${body}${PROPAGATE_EXIT}`;
}

/**
 * 拼出一条 `& '<脚本>' -开关 '值'` 调用。
 *
 * @param {string} scriptPath 内置脚本路径
 * @param {{ flags?: string[], values?: Record<string, string|number> }} options
 */
function buildInvocation(scriptPath, { flags = [], values = {} } = {}) {
  const tokens = [`& ${quoteValue(scriptPath)}`];
  for (const flag of flags) {
    if (!FLAG_PATTERN.test(flag)) throw new Error(`非法开关：${flag}`);
    tokens.push(flag);
  }
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    if (!FLAG_PATTERN.test(name)) throw new Error(`非法参数名：${name}`);
    tokens.push(name, quoteValue(value));
  }
  return tokens.join(" ");
}

function scriptEnvironment(env) {
  return {
    ...process.env,
    // 让脚本拉起的子进程（curl 等）也按 UTF-8 处理文本。
    PYTHONIOENCODING: "utf-8",
    ...env,
  };
}

/**
 * 以流式方式执行内置脚本。用于下载/安装这类长任务，stdout 与 stderr 逐行回调。
 */
function streamScript(scriptPath, options = {}) {
  const { flags, values, onStdoutLine, onStderrLine, env } = options;
  const code = wrapCommand(buildInvocation(scriptPath, { flags, values }));

  const child = spawn(POWERSHELL, [...BASE_FLAGS, "-Command", code], {
    windowsHide: true,
    env: scriptEnvironment(env),
  });

  const feedOut = createLineSplitter((line) => onStdoutLine?.(line));
  const feedErr = createLineSplitter((line) => onStderrLine?.(line));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => feedOut(chunk));
  child.stderr.on("data", (chunk) => feedErr(chunk));

  const done = new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: -1, error }));
    child.on("close", (code) => {
      feedOut("", true);
      feedErr("", true);
      resolve({ code: code ?? -1 });
    });
  });

  return { child, done };
}

/**
 * 收集式执行内置脚本：返回完整 stdout/stderr 与退出码，不因非零退出抛错。
 *
 * 有些脚本用退出码表达状态而不是表达失败 —— check-codex-desktop-health.ps1 的
 * 0/1/2/3 分别是健康/降级/未安装/无窗口。对这些脚本，退出码是数据，必须原样返回
 * 交给调用方解释。需要「非零即失败」语义的调用方用 runScript。
 */
async function captureScript(scriptPath, options = {}) {
  const stdout = [];
  const stderr = [];
  const { done } = streamScript(scriptPath, {
    ...options,
    onStdoutLine: (line) => {
      stdout.push(line);
      options.onStdoutLine?.(line);
    },
    onStderrLine: (line) => {
      stderr.push(line);
      options.onStderrLine?.(line);
    },
  });
  const { code, error } = await done;
  if (error) throw new Error(`无法启动 PowerShell: ${error.message}`);
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

/** 收集式执行内置脚本，非零退出时抛出（含 stderr 末尾）。 */
async function runScript(scriptPath, options = {}) {
  const result = await captureScript(scriptPath, options);
  if (result.code !== 0) throw new Error(describeFailure(result));
  return result;
}

/** 执行内联 PowerShell 片段。代码由本仓库编写，外部值一律经 env 传入。 */
async function runCode(code, { env } = {}) {
  const script = wrapCommand(code);
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, [...BASE_FLAGS, "-Command", script], {
      windowsHide: true,
      env: scriptEnvironment(env),
    });
    const stdout = [];
    const stderr = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => reject(new Error(`无法启动 PowerShell: ${error.message}`)));
    child.on("close", (code) => {
      const result = { code: code ?? -1, stdout: stdout.join(""), stderr: stderr.join("") };
      if (result.code !== 0) {
        reject(new Error(describeFailure(result)));
        return;
      }
      resolve(result);
    });
  });
}

/** 把脚本失败信息压成一句可读的话，优先用 stderr，其次 stdout 末尾。 */
function describeFailure({ code, stdout, stderr }) {
  const pick = (text) =>
    String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

  // PowerShell 的异常会摊成多行（+ CategoryInfo / + FullyQualifiedErrorId / 位置 行），
  // 真正有信息量的是最后那条消息本身，所以取末尾若干行。
  const detail = pick(stderr).length > 0 ? pick(stderr) : pick(stdout).slice(-6);
  if (detail.length === 0) return `PowerShell 退出码 ${code}`;
  return detail.slice(-4).join(" / ");
}

module.exports = { buildInvocation, wrapCommand, quoteValue, runScript, captureScript, runCode, streamScript, describeFailure, POWERSHELL };
