// 缓存迁移是唯一一个会同时动「用户的安装包」与「设置里的缓存目录」的功能。
// 这里用临时目录做真实文件操作（不碰任何本机缓存），钉住几条底线：
//
//   - 源目标相同 / 互相嵌套直接拒绝；
//   - 目录里的无关文件不迁移；
//   - 复制后源文件被清理、设置只在全部校验通过后才切换；
//   - 目标已有同名且内容不同的文件时立即中止，绝不覆盖；
//   - 取消后源目录与设置都不动。

const assert = require("node:assert/strict");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const migration = require("../electron/cache-migration.cjs");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const PKG_A = "OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0.msix";
const PKG_B = "OpenAI.Codex_26.1103.4239.0_x64__2p2nqsd0c76g0.msix";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "codex-migration-test-"));
  const source = join(root, "cache");
  const target = join(root, "target");
  mkdirSync(source, { recursive: true });
  return {
    root,
    source,
    target,
    write: (directory, name, content) => writeFileSync(join(directory, name), content),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("预检：拒绝同一个目录", async () => {
  const space = workspace();
  try {
    space.write(space.source, PKG_A, "package-a");
    await assert.rejects(
      migration.precheck({ sourceDirectory: space.source, targetDirectory: space.source }),
      /相同/,
    );
  } finally {
    space.cleanup();
  }
});

test("预检：拒绝目标在源目录里面，以及源在目标里面", async () => {
  const space = workspace();
  try {
    space.write(space.source, PKG_A, "package-a");
    await assert.rejects(
      migration.precheck({
        sourceDirectory: space.source,
        targetDirectory: join(space.source, "nested"),
      }),
      /里面/,
    );
    await assert.rejects(
      migration.precheck({
        sourceDirectory: space.source,
        targetDirectory: space.root,
      }),
      /上级/,
    );
  } finally {
    space.cleanup();
  }
});

test("预检：只枚举 Codex 安装包与固定标记，无关文件不参与", async () => {
  const space = workspace();
  try {
    space.write(space.source, PKG_A, "package-a");
    space.write(space.source, PKG_B, "package-bb");
    space.write(space.source, ".codex-pins.json", "[]");
    space.write(space.source, "notes.txt", "not ours");

    const plan = await migration.precheck({
      sourceDirectory: space.source,
      targetDirectory: space.target,
    });
    assert.deepEqual(
      plan.files.map((file) => file.name).sort(),
      [PKG_A, PKG_B, ".codex-pins.json"].sort(),
    );
    assert.equal(plan.totalBytes, "package-a".length + "package-bb".length + 2);
    assert.equal(plan.conflicts.length, 0);
    assert.ok(plan.freeBytes > 0, "目标目录所在磁盘应能读到可用空间");
    assert.ok(existsSync(space.target), "预检应创建目标目录");
  } finally {
    space.cleanup();
  }
});

test("迁移：复制 → 校验 → 切换设置 → 清理源文件，无关文件留在原目录", async () => {
  const space = workspace();
  try {
    space.write(space.source, PKG_A, "package-a");
    space.write(space.source, PKG_B, "package-bb");
    space.write(space.source, ".codex-pins.json", '["' + PKG_A + '"]');
    space.write(space.source, "notes.txt", "not ours");

    const progress = [];
    let switchedTo = null;
    const result = await migration.migrate({
      sourceDirectory: space.source,
      targetDirectory: space.target,
      onProgress: (event) => progress.push(event),
      switchDirectory: (target) => {
        switchedTo = target;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.cancelled, false);
    assert.equal(switchedTo, space.target, "设置必须在全部校验通过后才切换");
    assert.equal(result.copiedCount, 3);
    assert.equal(result.cleanedCount, 3);
    assert.equal(result.cleanupFailures.length, 0);
    assert.equal(readFileSync(join(space.target, PKG_A), "utf8"), "package-a");
    assert.equal(readFileSync(join(space.target, PKG_B), "utf8"), "package-bb");
    assert.equal(readFileSync(join(space.target, ".codex-pins.json"), "utf8"), '["' + PKG_A + '"]');
    assert.ok(!existsSync(join(space.source, PKG_A)), "源安装包应被清理");
    assert.ok(!existsSync(join(space.source, PKG_B)), "源安装包应被清理");
    assert.equal(readFileSync(join(space.source, "notes.txt"), "utf8"), "not ours", "无关文件不能动");
    assert.ok(progress.length > 0, "迁移必须上报进度");
    assert.equal(progress.at(-1).totalFiles, 3);
    assert.ok(progress.at(-1).copiedBytes >= progress.at(-1).totalBytes - 1);
  } finally {
    space.cleanup();
  }
});

test("迁移：目标已有内容相同的副本时跳过复制，但仍清理源文件", async () => {
  const space = workspace();
  try {
    space.write(space.source, PKG_A, "same-content");
    mkdirSync(space.target, { recursive: true });
    space.write(space.target, PKG_A, "same-content");

    const result = await migration.migrate({
      sourceDirectory: space.source,
      targetDirectory: space.target,
      switchDirectory: () => {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.copiedCount, 0);
    assert.equal(result.skippedCount, 1);
    assert.equal(result.cleanedCount, 1);
    assert.ok(!existsSync(join(space.source, PKG_A)));
    assert.equal(readFileSync(join(space.target, PKG_A), "utf8"), "same-content");
  } finally {
    space.cleanup();
  }
});

test("迁移：目标同名但内容不同时中止，不覆盖、不切换、不删源文件", async () => {
  const space = workspace();
  try {
    space.write(space.source, PKG_A, "source-content");
    mkdirSync(space.target, { recursive: true });
    space.write(space.target, PKG_A, "different!");

    let switched = false;
    await assert.rejects(
      migration.migrate({
        sourceDirectory: space.source,
        targetDirectory: space.target,
        switchDirectory: () => {
          switched = true;
        },
      }),
      /内容不同|未覆盖/,
    );

    assert.equal(switched, false, "校验失败时绝不能切换设置");
    assert.equal(readFileSync(join(space.target, PKG_A), "utf8"), "different!", "已有文件不能被覆盖");
    assert.equal(readFileSync(join(space.source, PKG_A), "utf8"), "source-content", "源文件必须保留");
    assert.ok(!readdirSync(space.target).some((name) => name.endsWith(".codex-migrating")), "临时文件要清理");
  } finally {
    space.cleanup();
  }
});

test("迁移：取消发生在复制阶段时，源目录与设置都不动，临时文件被清理", async () => {
  const space = workspace();
  try {
    space.write(space.source, PKG_A, "package-a");
    space.write(space.source, PKG_B, "package-bb");

    let switched = false;
    const result = await migration.migrate({
      sourceDirectory: space.source,
      targetDirectory: space.target,
      // 第一次进度回调节点取消：下一个分块边界就会停下来。
      onProgress: () => migration.cancelMigration(),
      switchDirectory: () => {
        switched = true;
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.equal(switched, false, "取消后不能切换设置");
    assert.ok(existsSync(join(space.source, PKG_A)), "源文件必须保留");
    assert.ok(existsSync(join(space.source, PKG_B)), "源文件必须保留");
    assert.ok(!readdirSync(space.target).some((name) => name.endsWith(".codex-migrating")), "临时文件要清理");
  } finally {
    space.cleanup();
  }
});

test("空缓存及尚未创建的缓存目录均可预检，目标就是所选文件夹", async () => {
  const space = workspace();
  try {
    for (const source of [space.source, join(space.root, "missing")]) {
      const plan = await migration.precheck({ sourceDirectory: source, targetDirectory: space.target });
      assert.deepEqual(plan.files, []);
      assert.equal(plan.totalBytes, 0);
      assert.equal(plan.targetDirectory, space.target);
      assert.deepEqual(readdirSync(space.target), []);
    }
  } finally { space.cleanup(); }
});

test("非法路径不会锁死后续迁移", async () => {
  const space = workspace();
  try {
    await assert.rejects(migration.migrate({ sourceDirectory: "relative", targetDirectory: space.target }), /绝对路径/);
    const result = await migration.migrate({ sourceDirectory: space.source, targetDirectory: space.target, switchDirectory() {} });
    assert.equal(result.ok, true);
  } finally { space.cleanup(); }
});

test("目录联接指向源目录时拒绝迁移，保留源文件", async () => {
  const space = workspace();
  try {
    space.write(space.source, PKG_A, "original");
    symlinkSync(space.source, space.target, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(migration.precheck({ sourceDirectory: space.source, targetDirectory: space.target }), /相同/);
    assert.equal(readFileSync(join(space.source, PKG_A), "utf8"), "original");
  } finally {
    // 先解除本测试创建的目录联接，避免 Windows 下递归清理遇到悬空联接。
    if (existsSync(space.target)) rmdirSync(space.target);
    space.cleanup();
  }
});

test("源文件被同大小内容替换时保留，不误报已释放空间", async () => {
  for (const alreadyPresent of [false, true]) {
    const space = workspace();
    try {
      space.write(space.source, PKG_A, "original");
      if (alreadyPresent) {
        mkdirSync(space.target);
        space.write(space.target, PKG_A, "original");
      }
      const result = await migration.migrate({
        sourceDirectory: space.source, targetDirectory: space.target,
        switchDirectory() { space.write(space.source, PKG_A, "replaced"); },
      });
      assert.equal(result.ok, true);
      assert.equal(result.cleanedCount, 0);
      assert.equal(result.cleanupFailures.length, 1);
      assert.equal(readFileSync(join(space.source, PKG_A), "utf8"), "replaced");
      assert.equal(readFileSync(join(space.target, PKG_A), "utf8"), "original");
    } finally { space.cleanup(); }
  }
});

test("预检后新出现的同名文件不会被覆盖，设置不会切换", async () => {
  const space = workspace();
  try {
    space.write(space.source, PKG_A, "original");
    let switched = false;
    let injected = false;
    await assert.rejects(migration.migrate({
      sourceDirectory: space.source, targetDirectory: space.target,
      onProgress() {
        if (!injected) { injected = true; space.write(space.target, PKG_A, "external"); }
      },
      switchDirectory() { switched = true; },
    }), /exist/i);
    assert.equal(switched, false);
    assert.equal(readFileSync(join(space.target, PKG_A), "utf8"), "external");
    assert.equal(readFileSync(join(space.source, PKG_A), "utf8"), "original");
    assert.deepEqual(readdirSync(space.target), [PKG_A]);
  } finally { space.cleanup(); }
});

test("设置保存失败时保留源文件", async () => {
  const space = workspace();
  try {
    space.write(space.source, PKG_A, "original");
    await assert.rejects(migration.migrate({
      sourceDirectory: space.source, targetDirectory: space.target,
      switchDirectory() { throw new Error("设置不可写"); },
    }), /设置不可写/);
    assert.equal(readFileSync(join(space.source, PKG_A), "utf8"), "original");
  } finally { space.cleanup(); }
});

// ---------- runner ----------

let failed = 0;
(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${error.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} 通过`);
  process.exit(failed === 0 ? 0 : 1);
})();
