const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resolve } = require("node:path");
const { resolveAppMigrationTarget } = require("../electron/app-migration-target.cjs");

// 路径与设备号故意不按盘符对应，覆盖目录联接和卷挂载点。
const selectedDirectory = resolve("test-selected-folder");
const canonical = resolve("test-mounted-volume", "中文 空格目录");
const currentVolume = resolve("test-current", "WindowsApps");
const targetVolume = resolve("test-other", "WindowsApps");
const capability = {
  installed: true, movable: true, packageVolume: currentVolume,
  volumes: [{ path: currentVolume }, { path: targetVolume }],
};
function filesystem(device = 20) {
  return {
    async realpath(path) { return path === selectedDirectory ? canonical : path; },
    async stat(path) {
      return { isDirectory: () => true, dev: path === canonical ? device : path === currentVolume ? 10 : 20 };
    },
  };
}

test("选中的文件夹按真实设备映射到应用卷，保留用户选择用于确认", async () => {
  const result = await resolveAppMigrationTarget(selectedDirectory, capability, filesystem());
  assert.equal(result.selectedDirectory, selectedDirectory);
  assert.equal(result.volumePath, targetVolume);
  assert.match(result.reason, /不会安装进所选文件夹/);
});

test("同卷、未知卷和不支持迁移均不给可执行目标", async () => {
  for (const device of [10, 30, 0]) {
    const result = await resolveAppMigrationTarget(selectedDirectory, capability, filesystem(device));
    assert.equal(result.volumePath, null);
    assert.ok(result.reason);
  }
  const result = await resolveAppMigrationTarget(selectedDirectory, { ...capability, movable: false, reason: "不可移动" }, filesystem());
  assert.equal(result.volumePath, null);
  assert.equal(result.reason, "不可移动");
});

test("目标离线或访问失败时不能按盘符猜一个应用卷", async () => {
  const io = filesystem();
  const original = io.stat;
  io.stat = async (path) => {
    if (path === targetVolume) throw new Error("离线");
    return original(path);
  };
  const result = await resolveAppMigrationTarget(selectedDirectory, capability, io);
  assert.equal(result.volumePath, null);
});

test("映射不唯一时阻止迁移", async () => {
  const result = await resolveAppMigrationTarget(selectedDirectory, {
    ...capability, volumes: [...capability.volumes, { path: resolve("duplicate-volume") }],
  }, filesystem());
  assert.equal(result.volumePath, null);
});

test("拒绝相对路径、文件和已删除的选择", async () => {
  await assert.rejects(resolveAppMigrationTarget("relative", capability), /绝对路径/);
  const io = filesystem();
  io.stat = async () => ({ isDirectory: () => false, dev: 20 });
  await assert.rejects(resolveAppMigrationTarget(selectedDirectory, capability, io), /不是文件夹/);
  io.realpath = async () => { throw new Error("目录不存在"); };
  await assert.rejects(resolveAppMigrationTarget(selectedDirectory, capability, io), /不存在/);
});
