// 图标契约：入库的那个 .ico 必须**就是生成器现在会生成的东西**。
//
// 生成器（scripts/make-icon.cjs）和产物（resources/icon.ico）都在仓库里，这就有一种很容易
// 发生的腐坏：有人改了蓝色、改了箭头形状、改了尺寸清单，跑一次 `npm run icon:make` 验证，
// 然后**忘记把新的 .ico 一起提交**。之后每个人 `npm run electron:build:local` 打出来的包，
// 图标都和生成器说的不一样，而且没有任何地方会报错 —— 直到有人真的去比对二进制。
//
// 所以这里直接比对字节。它同时也把 ICO 的结构钉住：electron-builder 打包时会自己解析这个
// 文件，格式错了它才报错，那时候已经跑完几分钟的构建了。

const assert = require("node:assert/strict");
const { existsSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const { buildIco, SIZES } = require("../scripts/make-icon.cjs");

const root = join(__dirname, "..");
const icoPath = join(root, "resources", "icon.ico");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("图标文件存在且不是空壳", () => {
  assert.ok(existsSync(icoPath), "resources/icon.ico 不存在：先跑 npm run icon:make");
  assert.ok(statSync(icoPath).size > 1024, "图标文件小得不像话，八成是写坏了");
});

test("入库文件与 buildIco() 的输出逐字节相同", () => {
  const built = buildIco();
  const committed = readFileSync(icoPath);
  // 只报长度差和第一个不同的位置：整个 buffer 打进断言消息里没人看得懂。
  if (!built.equals(committed)) {
    const at = built.findIndex((byte, index) => byte !== committed[index]);
    assert.fail(
      `resources/icon.ico 与生成器不一致（生成 ${built.length} 字节，入库 ${committed.length} 字节，` +
        `首个差异在偏移 ${at}）—— 改了生成器就要重跑 npm run icon:make 并把产物一起提交`,
    );
  }
});

test("ICO 目录头合法，条目数与尺寸清单一致", () => {
  const ico = readFileSync(icoPath);
  assert.equal(ico.readUInt16LE(0), 0, "ICO 保留字段必须是 0");
  assert.equal(ico.readUInt16LE(2), 1, "类型必须是 1（图标）；2 是光标");
  assert.equal(ico.readUInt16LE(4), SIZES.length, "条目数不对");

  const entries = [];
  for (let index = 0; index < SIZES.length; index += 1) {
    const at = 6 + index * 16;
    // 宽高是单字节，256 按 ICO 的规定写成 0（不是「未知」）。
    const width = ico[at] === 0 ? 256 : ico[at];
    const height = ico[at + 1] === 0 ? 256 : ico[at + 1];
    entries.push({
      width,
      height,
      bitCount: ico.readUInt16LE(at + 6),
      bytes: ico.readUInt32LE(at + 8),
      offset: ico.readUInt32LE(at + 12),
    });
  }

  assert.deepEqual(
    entries.map((entry) => entry.width),
    SIZES,
    "尺寸档位变了：Windows 在不同场合挑不同档位，缺哪一档就用邻近的缩放，糊",
  );
  for (const entry of entries) {
    assert.equal(entry.width, entry.height, `${entry.width} 这一档不是正方形`);
    assert.equal(entry.bitCount, 32, `${entry.width} 这一档不是 32 位真彩色：alpha 会丢，边缘变硬`);
  }
  // 26 = 任务栏/列表，48 = 中图标，256 = 大图标视图与安装程序。少了 256，安装程序图标会糊。
  assert.ok(entries.some((entry) => entry.width === 256), "缺少 256×256 一档");
  assert.ok(entries.some((entry) => entry.width === 16), "缺少 16×16 一档");
});

test("条目数据首尾相接、不越界，且都是 BI_RGB 的 DIB", () => {
  const ico = readFileSync(icoPath);
  let expected = 6 + SIZES.length * 16;

  for (let index = 0; index < SIZES.length; index += 1) {
    const at = 6 + index * 16;
    const bytes = ico.readUInt32LE(at + 8);
    const offset = ico.readUInt32LE(at + 12);
    const size = ico[at] === 0 ? 256 : ico[at]; // 只为让失败消息里带上是这一档

    assert.equal(offset, expected, `第 ${index} 个条目（${size}）的偏移不是紧接着上一段`);
    assert.ok(offset + bytes <= ico.length, `第 ${index} 个条目超出文件末尾：文件被截断了`);

    // BITMAPINFOHEADER
    assert.equal(ico.readUInt32LE(offset), 40, "DIB 头必须是 40 字节的 BITMAPINFOHEADER");
    assert.equal(ico.readUInt16LE(offset + 12), 1, "planes 必须是 1");
    assert.equal(ico.readUInt16LE(offset + 14), 32, "位深必须是 32");
    assert.equal(ico.readUInt32LE(offset + 16), 0, "压缩方式必须是 BI_RGB(0)：electron-builder 只认这个形状");
    // 高度写两倍：XOR 位图 + AND 掩码叠在一起，ICO 里的 DIB 就是这么存的。
    const dibHeight = ico.readInt32LE(offset + 8);
    const dibWidth = ico.readInt32LE(offset + 4);
    assert.equal(dibHeight, dibWidth * 2, `${dibWidth} 这一档的高度不是宽的两倍（掩码没算进去）`);
    assert.ok(
      ico.readUInt32LE(offset + 20) > 0,
      "biSizeImage 是 0：有些解析器据此判断「位图为空」",
    );

    expected += bytes;
  }
  assert.equal(expected, ico.length, "目录里的总长度和实际文件长度对不上");
});

// ---------- runner ----------

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
