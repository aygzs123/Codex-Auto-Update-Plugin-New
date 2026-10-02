// 生成应用图标（resources/icon.ico）。跑 `npm run icon:make` 重建。
//
// 为什么是「代码画」而不是入库一张 png/ico：仓库里根本没有设计资源，而打包日志一直写着
// `default Electron icon is used reason=application icon is not set` —— 装到同事机器上，
// 任务栏、「添加/删除程序」列表里都是一个 Electron 原子图标。生成器入库的好处是它可重建、
// 也可替换：将来有设计稿，把 insideGlyph / BRAND 换掉重跑一次就行，不必逆向一个二进制。
//
// 为什么条目用 32 位 DIB（BMP）而不是内嵌 PNG：ICO 允许条目内嵌 PNG，Windows 也认，但
// electron-builder 打包时会用自己的解析去校验图标，DIB 是它一定认的形状。代价是文件大一些
// （256×256 一条就 270 KB），这点体积对本仓库无所谓，换来的是「打包不会因为图标格式失败」。
//
// 几何全在 0..1 的归一化坐标里描述，同一份定义喂给所有尺寸；每个像素用 4×4 超采样算覆盖率，
// 免得小尺寸下边缘全是锯齿。

const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { deflateSync } = require("node:zlib");

// Windows 会在不同场合挑不同尺寸：16 = 任务栏/列表，32 = 桌面快捷方式，48 = 中图标，
// 256 = 「大图标」视图与安装程序。缺哪一档系统就用邻近的缩放，糊。
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SUPERSAMPLE = 4;

/** 界面主色 #1677ff，与 styles.css 的品牌色一致。 */
const BRAND = [22, 119, 255];
const GLYPH = [255, 255, 255];

/**
 * 圆角矩形。判据是把点夹到「内缩 radius 的矩形」上再比距离 —— 这是圆角矩形 SDF 的标准写法，
 * 比「四个角分别判圆」少一半分支。
 */
function insideRoundedRect(x, y, x0, y0, x1, y1, radius) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
}

/** 尖朝下的等腰三角形：上边从 (cx±halfWidth, top) 开始，到 (cx, apex) 收成一点。 */
function insideDownTriangle(x, y, cx, top, apex, halfWidth) {
  if (y < top || y > apex) return false;
  const half = halfWidth * (1 - (y - top) / (apex - top));
  return Math.abs(x - cx) <= half;
}

/** 圆角方形的底盘，圆角按 Windows 11 图标的观感取 0.2。 */
function insideTile(x, y) {
  return insideRoundedRect(x, y, 0, 0, 1, 1, 0.2);
}

/**
 * 白色的「下载/更新」标记：一根竖杆 + 一个箭头 + 底部一个托盘。
 *
 * 选这个形状有两个理由：它不依赖任何字体（画字的话得在脚本里塞字形数据），
 * 而且在 16px 下还能看出是个「往下装东西」的动作 —— 这正是这个应用唯一的用途。
 */
function insideGlyph(x, y) {
  const stem = insideRoundedRect(x, y, 0.44, 0.2, 0.56, 0.5, 0.02);
  const head = insideDownTriangle(x, y, 0.5, 0.43, 0.68, 0.2);
  const tray = insideRoundedRect(x, y, 0.25, 0.735, 0.75, 0.8, 0.03);
  return stem || head || tray;
}

/** 光栅化成一个 RGBA（非预乘）缓冲区。 */
function rasterize(size) {
  const out = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SUPERSAMPLE);
  const total = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let covered = 0;
      let inked = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px * SUPERSAMPLE + sx + 0.5) * step;
          const y = (py * SUPERSAMPLE + sy + 0.5) * step;
          if (!insideTile(x, y)) continue;
          covered += 1;
          if (insideGlyph(x, y)) inked += 1;
        }
      }
      // 白笔画的占比只按「底盘内的采样点」算：直接除以总采样数的话，边缘那一圈半透明的
      // 像素会被算成「一半是白的」，图标边缘就会出现一圈发白的描边。
      const ink = covered === 0 ? 0 : inked / covered;
      const index = (py * size + px) * 4;
      out[index] = Math.round(BRAND[0] + (GLYPH[0] - BRAND[0]) * ink);
      out[index + 1] = Math.round(BRAND[1] + (GLYPH[1] - BRAND[1]) * ink);
      out[index + 2] = Math.round(BRAND[2] + (GLYPH[2] - BRAND[2]) * ink);
      out[index + 3] = Math.round((covered / total) * 255);
    }
  }
  return out;
}

/**
 * 一个 ICO 条目：40 字节 BITMAPINFOHEADER + 自下而上的 BGRA 位图 + 1bpp 的 AND 掩码。
 *
 * 掩码全零是**对的**：32 位条目带 alpha 通道，Windows 以 alpha 为准，掩码只是格式要求。
 * 老程序不看 alpha 时会把整个方块当不透明 —— 那也比缺失掩码（解析直接崩）好。
 */
function encodeDib(size) {
  const pixels = rasterize(size);
  const rowStride = size * 4;
  const maskStride = Math.ceil(size / 32) * 4;

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  // 高度写两倍：XOR 位图 + AND 掩码叠在一起，这是 ICO 里 DIB 的老规矩。
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(rowStride * size + maskStride * size, 20);

  const xor = Buffer.alloc(rowStride * size);
  for (let y = 0; y < size; y += 1) {
    const source = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x += 1) {
      const target = y * rowStride + x * 4;
      xor[target] = pixels[source + x * 4 + 2];
      xor[target + 1] = pixels[source + x * 4 + 1];
      xor[target + 2] = pixels[source + x * 4];
      xor[target + 3] = pixels[source + x * 4 + 3];
    }
  }

  return Buffer.concat([header, xor, Buffer.alloc(maskStride * size)]);
}

/** 完整 .ico：6 字节目录头 + 每图 16 字节目录项 + 各条目数据。 */
function buildIco() {
  const images = SIZES.map((size) => ({ size, data: encodeDib(size) }));
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2); // 1 = 图标（2 是光标）
  directory.writeUInt16LE(images.length, 4);

  let offset = directory.length;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    // 宽高是单字节，256 只能写 0 —— 这不是「未知」，是这一档的规定写法。
    directory[entry] = image.size >= 256 ? 0 : image.size;
    directory[entry + 1] = image.size >= 256 ? 0 : image.size;
    directory[entry + 2] = 0; // 调色板数：真彩色没有调色板
    directory[entry + 3] = 0;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });

  return Buffer.concat([directory, ...images.map((image) => image.data)]);
}

// ---------- 预览（只为人工看一眼，不参与打包） ----------

// --preview=<文件>：导出一张 PNG。图标本身是二进制的，光看「生成成功」四个字说明不了它长得对不对，
// 而 PNG 能直接打开看。手写 PNG 只是为了不给这个脚本引依赖，就一个 deflate + CRC。
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function buildPreviewPng(size) {
  const pixels = rasterize(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // 每行前的过滤器字节：0 = None
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 真彩色 + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function main() {
  const target = join(__dirname, "..", "resources", "icon.ico");
  const ico = buildIco();
  writeFileSync(target, ico);
  console.log(`已写入 ${target}（${SIZES.join(" / ")}，共 ${ico.length} 字节）`);

  const preview = process.argv.find((argument) => argument.startsWith("--preview="));
  if (preview) {
    const path = preview.split("=")[1] || join(__dirname, "..", "release-verify", "icon-preview.png");
    writeFileSync(path, buildPreviewPng(256));
    console.log(`预览：${path}`);
  }
}

if (require.main === module) main();

module.exports = { buildIco, buildPreviewPng, rasterize, SIZES };
