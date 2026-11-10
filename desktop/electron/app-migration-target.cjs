const fs = require("node:fs/promises");
const { isAbsolute } = require("node:path");

/** 用实际文件系统设备匹配应用卷，避免按盘符猜测时误判挂载点或目录联接。 */
async function resolveAppMigrationTarget(selectedDirectory, capability, filesystem = fs) {
  if (typeof selectedDirectory !== "string" || !isAbsolute(selectedDirectory)) {
    throw new Error("请选择绝对路径的文件夹。");
  }
  const result = { selectedDirectory, volumePath: null, reason: "" };
  const canonical = await filesystem.realpath(selectedDirectory);
  const selected = await filesystem.stat(canonical);
  if (!selected.isDirectory()) throw new Error("所选位置不是文件夹。");

  const matches = [];
  for (const volume of capability.volumes) {
    try {
      const location = await filesystem.realpath(volume.path);
      const stats = await filesystem.stat(location);
      if (stats.isDirectory() && selected.dev !== 0 && stats.dev === selected.dev) matches.push(volume);
    } catch {
      // 离线或不可访问的应用卷不能作为可迁移目标。
    }
  }
  if (matches.length !== 1) {
    result.reason = "无法唯一确定此文件夹对应的 Windows 应用卷。请更换文件夹，或在 Windows 存储设置中配置应用保存位置后重新检测。";
    return result;
  }
  const target = matches[0];
  if (target.path.toLowerCase() === String(capability.packageVolume || "").toLowerCase()) {
    result.reason = "所选文件夹与 Codex 位于同一应用卷，无需迁移。";
  } else if (!capability.installed || !capability.movable) {
    result.reason = capability.reason || "当前 Codex 不满足迁移条件。";
  } else {
    result.volumePath = target.path;
    result.reason = "应用将安装在此 Windows 应用存储位置下，具体版本子目录由系统创建；不会安装进所选文件夹。";
  }
  return result;
}

module.exports = { resolveAppMigrationTarget };
