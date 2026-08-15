import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(rootDir, "public");
mkdirSync(publicDir, { recursive: true });
mkdirSync(resolve(publicDir, "icons"), { recursive: true });

function crc32(buffer) {
  let crc = ~0;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function writePng(path, width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  return new Promise((resolveWrite, reject) => {
    const stream = createWriteStream(path);
    stream.on("finish", resolveWrite);
    stream.on("error", reject);
    stream.end(png);
  });
}

function setPixel(rgba, width, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= width || y >= rgba.length / (width * 4)) return;
  const i = (y * width + x) * 4;
  rgba[i] = r;
  rgba[i + 1] = g;
  rgba[i + 2] = b;
  rgba[i + 3] = a;
}

function fillRect(rgba, width, x0, y0, x1, y1, r, g, b, a = 255) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      setPixel(rgba, width, x, y, r, g, b, a);
    }
  }
}

function roundedRectMask(size, radius) {
  return (x, y) => {
    const dx = Math.min(x, size - 1 - x);
    const dy = Math.min(y, size - 1 - y);
    if (dx >= radius || dy >= radius) return true;
    const cx = radius - dx;
    const cy = radius - dy;
    return cx * cx + cy * cy <= radius * radius;
  };
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const inside = roundedRectMask(size, Math.round(size * 0.22));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (inside(x, y)) setPixel(rgba, size, x, y, 37, 99, 235, 255);
      else setPixel(rgba, size, x, y, 0, 0, 0, 0);
    }
  }

  const sunX = Math.round(size * 0.34);
  const sunY = Math.round(size * 0.34);
  const sunR = Math.max(2, Math.round(size * 0.08));
  for (let y = sunY - sunR; y <= sunY + sunR; y += 1) {
    for (let x = sunX - sunR; x <= sunX + sunR; x += 1) {
      if ((x - sunX) ** 2 + (y - sunY) ** 2 <= sunR * sunR) {
        setPixel(rgba, size, x, y, 255, 255, 255, 255);
      }
    }
  }

  const left = Math.round(size * 0.18);
  const right = Math.round(size * 0.82);
  const base = Math.round(size * 0.78);
  const peak1x = Math.round(size * 0.36);
  const peak1y = Math.round(size * 0.46);
  const peak2x = Math.round(size * 0.58);
  const peak2y = Math.round(size * 0.4);
  for (let y = peak2y; y <= base; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const t1 =
        (x - left) / Math.max(1, peak1x - left) * (base - peak1y) <= base - y &&
        x <= peak1x;
      const t2 =
        (right - x) / Math.max(1, right - peak2x) * (base - peak2y) <= base - y &&
        x >= peak2x;
      const mid =
        x >= peak1x &&
        x <= peak2x &&
        y >= Math.min(peak1y, peak2y);
      if (t1 || t2 || mid) {
        const ridge =
          Math.abs((x - peak1x) / Math.max(1, peak2x - peak1x) * (peak2y - peak1y) + peak1y - y) <
          Math.round(size * 0.18);
        if (y >= peak1y - Math.round(size * 0.02) || ridge || x <= peak1x || x >= peak2x) {
          if (
            (x - peak1x) * (base - peak1y) >= (left - peak1x) * (y - peak1y) &&
            (x - peak2x) * (base - peak2y) <= (right - peak2x) * (y - peak2y) &&
            y <= base
          ) {
            setPixel(rgba, size, x, y, 255, 255, 255, 255);
          }
        }
      }
    }
  }

  fillRect(
    rgba,
    size,
    left,
    Math.round(size * 0.7),
    right,
    base,
    255,
    255,
    255,
    255,
  );

  const arcX = Math.round(size * 0.78);
  const arcY = Math.round(size * 0.24);
  const arcR = Math.max(3, Math.round(size * 0.12));
  for (let a = 20; a <= 230; a += 1) {
    const rad = (a * Math.PI) / 180;
    const x = Math.round(arcX + Math.cos(rad) * arcR);
    const y = Math.round(arcY + Math.sin(rad) * arcR);
    setPixel(rgba, size, x, y, 255, 255, 255, 255);
    setPixel(rgba, size, x + 1, y, 255, 255, 255, 255);
  }

  return rgba;
}

const sizes = [16, 32, 48, 128];
await Promise.all(
  sizes.flatMap((size) => {
    const rgba = drawIcon(size);
    return [
      writePng(resolve(publicDir, `icon${size}.png`), size, size, rgba),
      writePng(resolve(publicDir, "icons", `icon${size}.png`), size, size, rgba),
    ];
  }),
);

console.log("Generated Image Restore icons.");
