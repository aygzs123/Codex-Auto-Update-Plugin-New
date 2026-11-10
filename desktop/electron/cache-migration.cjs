// 安装包缓存迁移：预检 → 复制 → SHA-256 校验 → 切换设置 → 清理源文件。
//
// 这一整套只搬三类东西：`OpenAI.Codex_*.msix/msixbundle`、`.codex-pins.json`
// 以及（切换后）源目录里这些已验证的文件。目录里的其他文件一律不碰 —— 用户可能把
// 缓存目录指到了自己的下载文件夹，那里面的东西不归我们管。
//
// 几条硬约束，都是「宁可什么都不做，也不能把用户回退用的安装包弄丢」：
//   - 预检与执行各枚举一次源目录，执行时不复用界面拿到的清单（那是可以过期的数据）；
//   - 目标目录已有同名文件时先比大小、再比 SHA-256：内容相同才跳过，不同立即中止，绝不覆盖；
//   - 每个文件先写到临时名，校验通过后才排他发布为正式文件名 —— 复制失败不会留下一个
//     看起来完整、实际缺半截的安装包；
//   - 复制与校验全部通过后才切换设置；设置写失败时源目录原样保留；
//   - 源文件清理失败逐个报告，界面据此提示「原目录仍有文件」，不虚报已释放空间。

const { createHash, randomUUID } = require("node:crypto");
const { createReadStream, constants } = require("node:fs");
const fsp = require("node:fs/promises");
const { dirname, isAbsolute, join, resolve, sep } = require("node:path");

const PACKAGE_PATTERN = /^OpenAI\.Codex_.+\.(msix|msixbundle)$/i;
const PINS_FILE = ".codex-pins.json";
const PART_SUFFIX = ".codex-migrating";
const COPY_CHUNK = 4 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 160;

let migrationActive = false;
let cancelRequested = false;

/** 请求取消。只在迁移真正在跑时生效；下一个文件/分块边界会停下来。 */
function cancelMigration() {
  if (!migrationActive) return { cancelling: false };
  cancelRequested = true;
  return { cancelling: true };
}

function isCancelled() {
  return cancelRequested;
}

function cancelledError() {
  const error = new Error("迁移已取消");
  error.cancelled = true;
  return error;
}

/** Windows 路径大小写不敏感；比较前统一归一化。 */
function pathKey(path) {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isInside(parent, child) {
  const root = pathKey(parent);
  const target = pathKey(child);
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}

function describeStatFailure(error, path) {
  if (error && error.code === "ENOENT") return `目录不存在：${path}`;
  if (error && (error.code === "EACCES" || error.code === "EPERM")) return `没有访问权限：${path}`;
  return `无法读取目录 ${path}：${error?.message || error}`;
}

/** 列出源目录里可迁移的文件。其他文件（用户自己的东西）不参与。 */
async function listMigratableFiles(directory) {
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(describeStatFailure(error, directory));
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name !== PINS_FILE && !PACKAGE_PATTERN.test(entry.name)) continue;
    const stats = await fsp.stat(join(directory, entry.name));
    if (!stats.isFile()) continue;
    files.push({ name: entry.name, sizeBytes: stats.size, mtimeMs: stats.mtimeMs });
  }
  files.sort((left, right) => left.name.localeCompare(right.name));
  return files;
}

/**
 * 目标目录所在磁盘的可用空间。
 *
 * 路径可能还不存在（用户选了一个新文件夹），所以向上找第一个存在的祖先再取文件系统信息。
 * 返回 null 表示读不到 —— 界面显示「未知」，不拿一个编出来的数字继续判断。
 */
async function freeSpaceFor(path) {
  let current = resolve(path);
  for (;;) {
    try {
      const stats = await fsp.statfs(current);
      const blockSize = Number(stats.bsize);
      return { freeBytes: blockSize * Number(stats.bavail), totalBytes: blockSize * Number(stats.blocks) };
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** 目标目录可写性：真的写一个临时文件再删掉，不能只看权限位。 */
async function assertWritable(directory) {
  const probe = join(directory, `.codex-migration-probe-${process.pid}-${Date.now()}`);
  try {
    await fsp.writeFile(probe, "probe", { flag: "wx" });
  } catch (error) {
    if (error && (error.code === "EACCES" || error.code === "EPERM")) {
      throw new Error(`没有写入权限：${directory}`);
    }
    if (error && error.code === "ENOSPC") throw new Error(`目标磁盘空间不足：${directory}`);
    throw new Error(`目标目录不可写：${directory}（${error?.message || error}）`);
  } finally {
    await fsp.unlink(probe).catch(() => {});
  }
}

function assertDistinctDirectories(sourceDirectory, targetDirectory) {
  const sourceKey = pathKey(sourceDirectory);
  const targetKey = pathKey(targetDirectory);
  if (sourceKey === targetKey) throw new Error("目标目录和当前缓存目录相同，不需要迁移。");
  if (isInside(sourceDirectory, targetDirectory)) {
    throw new Error("目标目录不能放在当前缓存目录里面，否则迁移会把新文件当成源文件。");
  }
  if (isInside(targetDirectory, sourceDirectory)) {
    throw new Error("目标目录不能是当前缓存目录的上级目录，请选择另一个位置。");
  }
}

function assertAbsoluteDirectory(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`没有指定${label}`);
  if (!isAbsolute(text)) throw new Error(`${label}必须是绝对路径`);
  return resolve(text);
}

/**
 * 预检：可创建目标目录并写入探针，不迁移源文件、不修改设置。返回界面确认用的摘要。
 * 这个结果**不是**执行授权，migrate 会重新枚举一次。
 */
async function precheck({ sourceDirectory, targetDirectory }) {
  const source = assertAbsoluteDirectory(sourceDirectory, "源目录");
  const target = assertAbsoluteDirectory(targetDirectory, "目标目录");
  assertDistinctDirectories(source, target);

  const files = await listMigratableFiles(source);

  try {
    await fsp.mkdir(target, { recursive: true });
  } catch (error) {
    throw new Error(`无法创建目标目录：${error?.message || error}`);
  }
  const realSource = await fsp.realpath(source).catch((error) => {
    if (error.code === "ENOENT") return source;
    throw error;
  });
  assertDistinctDirectories(realSource, await fsp.realpath(target));
  await assertWritable(target);

  const space = await freeSpaceFor(target);
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const freeBytes = space?.freeBytes ?? 0;

  // 同名文件全部列为「冲突提示」：执行时先比大小再比 SHA-256，内容一致才跳过，
  // 不一致立即中止。让用户在确认前就知道目标目录不是空的。
  const conflicts = [];
  for (const file of files) {
    const existing = await fsp.stat(join(target, file.name)).catch(() => null);
    if (existing) conflicts.push(file.name);
  }

  return {
    sourceDirectory: source,
    targetDirectory: target,
    files: files.map((file) => ({ name: file.name, sizeBytes: file.sizeBytes })),
    totalBytes,
    freeBytes,
    conflicts,
  };
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * 复制单个文件并同时计算 SHA-256。
 *
 * 用显式分块而不是 pipeline：取消要在文件内部也能停下来，否则一个 800 MB 的包复制到
 * 一半点「取消」，界面还得等它跑完。返回的 hash 是**源文件**的摘要，用于和目标文件比对。
 */
async function copyFile(sourcePath, targetPath, onBytes) {
  const source = await fsp.open(sourcePath, "r");
  let target;
  try {
    target = await fsp.open(targetPath, "wx");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_CHUNK);
    let position = 0;
    for (;;) {
      if (isCancelled()) throw cancelledError();
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await target.write(buffer, written, bytesRead - written, position + written);
        if (bytesWritten === 0) throw new Error("写入目标文件失败，源文件已保留。");
        written += bytesWritten;
      }
      position += bytesRead;
      onBytes(bytesRead);
    }
    // 先把数据刷到磁盘再校验：否则校验读到的可能还是内存里的页缓存。
    await target.sync();
    return { sha256: hash.digest("hex"), sizeBytes: position };
  } finally {
    await source.close().catch(() => {});
    await target?.close().catch(() => {});
  }
}

async function partPathFor(directory, name) {
  return join(directory, `.${name}.${randomUUID()}${PART_SUFFIX}`);
}

async function publishFile(partPath, targetPath) {
  try {
    // 硬链接发布不会覆盖预检后新出现的同名文件，且无需额外复制大包。
    await fsp.link(partPath, targetPath);
  } catch (error) {
    if (!["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS"].includes(error.code)) throw error;
    // 不支持硬链接的文件系统仍坚持排他创建；失败时源缓存与设置保留。
    await fsp.copyFile(partPath, targetPath, constants.COPYFILE_EXCL);
  }
  await fsp.unlink(partPath);
}

/**
 * 执行迁移。
 *
 * @param {object} options
 * @param {string} options.sourceDirectory 当前缓存目录（由主进程解析）
 * @param {string} options.targetDirectory 目标目录（界面选择，已预检）
 * @param {(path: string) => Promise<void>|void} options.switchDirectory
 *   所有文件校验通过后调用，把设置切到新目录。它抛错时源目录与设置保持原样。
 * @param {(progress: object) => void} [options.onProgress]
 */
async function migrate({ sourceDirectory, targetDirectory, switchDirectory, onProgress }) {
  if (migrationActive) throw new Error("已有一次缓存迁移在进行中。");
  const source = assertAbsoluteDirectory(sourceDirectory, "源目录");
  const target = assertAbsoluteDirectory(targetDirectory, "目标目录");
  migrationActive = true;
  cancelRequested = false;

  const result = {
    ok: false,
    cancelled: false,
    sourceDirectory: source,
    targetDirectory: target,
    copiedCount: 0,
    copiedBytes: 0,
    skippedCount: 0,
    cleanedCount: 0,
    cleanupFailures: [],
  };

  let lastEmit = 0;
  let copiedFiles = 0;
  // 进度按「已处理字节」算：已在目标目录里的同名文件也算处理完，否则进度条永远到不了头。
  // result.copiedBytes 只统计真正复制过去的部分，界面上的「共移动 X」不会把跳过的算进去。
  let processedBytes = 0;
  const emitProgress = (currentFile, force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return;
    lastEmit = now;
    onProgress?.({
      copiedFiles,
      totalFiles: totalFiles,
      copiedBytes: processedBytes,
      totalBytes,
      currentFile,
    });
  };

  let totalFiles = 0;
  let totalBytes = 0;

  try {
    // 执行前重新预检：界面上的清单可能已经过期（这期间下载完成、用户删了文件）。
    const plan = await precheck({ sourceDirectory: source, targetDirectory: target });
    totalFiles = plan.files.length;
    totalBytes = plan.totalBytes;

    // 已存在的同名文件里，内容不同的必须在动任何文件之前就中止。
    const pending = [];
    for (const file of plan.files) {
      if (isCancelled()) throw cancelledError();
      const targetPath = join(target, file.name);
      const existing = await fsp.stat(targetPath).catch(() => null);
      if (!existing) {
        pending.push(file);
        continue;
      }
      if (!existing.isFile() || existing.size !== file.sizeBytes) {
        throw new Error(`目标目录已有同名但内容不同的文件：${file.name}。未覆盖，源目录与设置保持不变。`);
      }
      emitProgress(file.name, true);
      const [sourceHash, targetHash] = await Promise.all([hashFile(join(source, file.name)), hashFile(targetPath)]);
      if (sourceHash !== targetHash) {
        throw new Error(`目标目录已有同名但内容不同的文件：${file.name}。未覆盖，源目录与设置保持不变。`);
      }
      // 目标位置已有一份校验一致的副本：不必再复制，但切换后可以安全地清理源文件。
      result.skippedCount += 1;
      copiedFiles += 1;
      processedBytes += file.sizeBytes;
      pending.push({ ...file, alreadyPresent: true, sha256: sourceHash });
    }

    const requiredBytes = pending.reduce((sum, file) => sum + (file.alreadyPresent ? 0 : file.sizeBytes), 0);
    if (requiredBytes > plan.freeBytes) throw new Error("目标磁盘空间不足或无法确认可用空间，请更换目录后重试。");

    // 复制。单个文件失败（含取消）会抛出，下面的 catch 会清掉本轮的临时文件。
    const createdParts = new Set();
    try {
      for (const file of pending) {
        if (file.alreadyPresent) continue;
        if (isCancelled()) throw cancelledError();
        const partPath = await partPathFor(target, file.name);
        createdParts.add(partPath);
        emitProgress(file.name, true);
        const copied = await copyFile(join(source, file.name), partPath, (bytes) => {
          result.copiedBytes += bytes;
          processedBytes += bytes;
          emitProgress(file.name);
        });
        // 写完再从头读一遍目标文件：校验的是真实落盘的内容，而不是流里的摘要。
        const targetHash = await hashFile(partPath);
        if (targetHash !== copied.sha256) {
          throw new Error(`文件校验失败：${file.name}。目标副本已删除，源文件未改动。`);
        }
        file.sha256 = copied.sha256;
        await publishFile(partPath, join(target, file.name));
        createdParts.delete(partPath);
        result.copiedCount += 1;
        copiedFiles += 1;
        emitProgress(file.name, true);
      }
    } finally {
      for (const partPath of createdParts) await fsp.unlink(partPath).catch(() => {});
    }

    if (isCancelled()) throw cancelledError();

    // 到这里所有文件都已经在目标目录里且校验一致。切换设置是「提交点」。
    await switchDirectory(target);
    result.ok = true;

    // 清理源目录里已经验证过的文件。失败不影响迁移结果，但必须如实上报。
    for (const file of pending) {
      if (isCancelled()) {
        // 设置已经切走，不能再报「已取消」：剩下的源文件记为未清理即可。
        result.cleanupFailures.push({ name: file.name, message: "已取消清理，源文件仍保留在原目录" });
        continue;
      }
      const sourcePath = join(source, file.name);
      try {
        // 复制期间源文件若被替换/追加，就不再删它 —— 删掉的可能不是我们校验过的那份。
        const current = await fsp.stat(sourcePath);
        if (!current.isFile() || current.size !== file.sizeBytes ||
            await hashFile(sourcePath) !== file.sha256 ||
            await hashFile(join(target, file.name)) !== file.sha256) {
          result.cleanupFailures.push({ name: file.name, message: "文件在迁移期间发生变化，已保留" });
          continue;
        }
        const afterHash = await fsp.stat(sourcePath);
        if (afterHash.mtimeMs !== current.mtimeMs || afterHash.ino !== current.ino || afterHash.size !== current.size) {
          result.cleanupFailures.push({ name: file.name, message: "文件在校验期间发生变化，已保留" });
          continue;
        }
        await fsp.unlink(sourcePath);
        result.cleanedCount += 1;
      } catch (error) {
        if (error && error.code === "ENOENT" &&
            await fsp.lstat(sourcePath).then(() => false, (cause) => cause.code === "ENOENT")) {
          result.cleanedCount += 1;
          continue;
        }
        result.cleanupFailures.push({ name: file.name, message: error?.message || String(error) });
      }
    }

    return result;
  } catch (error) {
    if (error?.cancelled) {
      result.cancelled = true;
      result.ok = false;
      return result;
    }
    throw error;
  } finally {
    migrationActive = false;
    cancelRequested = false;
  }
}

module.exports = {
  cancelMigration,
  precheck,
  migrate,
  listMigratableFiles,
  freeSpaceFor,
  assertWritable,
  PACKAGE_PATTERN,
  PINS_FILE,
};
