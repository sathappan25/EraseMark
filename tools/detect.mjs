import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import { loadImage, savePng } from "./imageIo.mjs";

class ImageDataShim {
  constructor(a, b, c) {
    if (typeof a === "number") {
      this.width = a;
      this.height = b;
      this.data = new Uint8ClampedArray(a * b * 4);
    } else {
      this.data = a;
      this.width = b;
      this.height = c;
    }
  }
}
globalThis.ImageData = globalThis.ImageData ?? ImageDataShim;

const bundle = path.join("tools", "out", "detector.mjs");
fs.mkdirSync(path.dirname(bundle), { recursive: true });
await esbuild.build({
  entryPoints: ["src/utils/watermarkDetector.ts"],
  bundle: true,
  format: "esm",
  outfile: bundle,
  logLevel: "error",
});
const { detectUnwantedOverlay, debugOverlayCandidates } = await import(
  new URL(`file:///${path.resolve(bundle)}`).href
);

const [, , src, outName, ...flags] = process.argv;
const image = loadImage(src);
const data = new Uint8ClampedArray(image.data);

function blendPixel(x, y, alpha) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const p = (y * image.width + x) * 4;
  for (let c = 0; c < 3; c += 1) {
    data[p + c] = data[p + c] * (1 - alpha) + 255 * alpha;
  }
}

/** Four-point sparkle similar to AI-generator corner marks. */
function drawSparkle(cx, cy, size) {
  for (let y = -size; y <= size; y += 1) {
    for (let x = -size; x <= size; x += 1) {
      const nx = Math.abs(x) / size;
      const ny = Math.abs(y) / size;
      const star = Math.pow(nx, 0.55) + Math.pow(ny, 0.55);
      if (star <= 1) blendPixel(cx + x, cy + y, 0.92);
      else if (star <= 1.08) blendPixel(cx + x, cy + y, 0.4);
    }
  }
}

/** Horizontal bar of thin strokes, standing in for a text watermark. */
function drawTextBar(x0, y0, glyphs, glyphH) {
  for (let g = 0; g < glyphs; g += 1) {
    const gx = x0 + g * (glyphH * 0.8);
    for (let y = 0; y < glyphH; y += 1) {
      blendPixel(Math.round(gx), y0 + y, 0.9);
      blendPixel(Math.round(gx) + 1, y0 + y, 0.9);
      blendPixel(Math.round(gx + glyphH * 0.45), y0 + y, 0.9);
    }
    for (let x = 0; x <= glyphH * 0.45; x += 1) {
      blendPixel(Math.round(gx + x), y0 + Math.round(glyphH / 2), 0.9);
    }
  }
}

if (flags.includes("--sparkle")) {
  drawSparkle(image.width - 40, image.height - 36, 13);
}
if (flags.includes("--text")) {
  drawTextBar(24, image.height - 34, 8, 16);
}

const input = new ImageDataShim(data, image.width, image.height);
const result = detectUnwantedOverlay(input);

let pixels = 0;
let bbox = null;
if (result.mask) {
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (result.mask.data[(y * image.width + x) * 4] <= 16) continue;
      pixels += 1;
      bbox = bbox
        ? {
            minX: Math.min(bbox.minX, x),
            minY: Math.min(bbox.minY, y),
            maxX: Math.max(bbox.maxX, x),
            maxY: Math.max(bbox.maxY, y),
          }
        : { minX: x, minY: y, maxX: x, maxY: y };
    }
  }
}

console.log(path.basename(outName), {
  detected: result.detected,
  confidence: Number(result.confidence.toFixed(3)),
  reason: result.reason ?? null,
  maskPixels: pixels,
  maskPercent: Number(((pixels / (image.width * image.height)) * 100).toFixed(3)),
  bbox: bbox && {
    x: bbox.minX,
    y: bbox.minY,
    w: bbox.maxX - bbox.minX + 1,
    h: bbox.maxY - bbox.minY + 1,
  },
});

const candidates = debugOverlayCandidates(input, 0);
console.log(`candidates passing hard gates (${candidates.length}):`);
console.table(candidates.slice(0, 10));

const overlay = new Uint8Array(data.length);
overlay.set(data);
if (result.mask) {
  for (let i = 0; i < image.width * image.height; i += 1) {
    if (result.mask.data[i * 4] <= 16) continue;
    overlay[i * 4] = 255;
    overlay[i * 4 + 1] = 0;
    overlay[i * 4 + 2] = 0;
  }
}
for (let i = 0; i < image.width * image.height; i += 1) overlay[i * 4 + 3] = 255;
savePng({ width: image.width, height: image.height, data: overlay }, path.join("tools", "out", `${outName}.png`));

const cw = Math.min(260, image.width);
const ch = Math.min(170, image.height);
const scale = 3;
const crop = { width: cw * scale, height: ch * scale, data: new Uint8Array(cw * scale * ch * scale * 4) };
for (let y = 0; y < crop.height; y += 1) {
  const sy = image.height - ch + Math.floor(y / scale);
  for (let x = 0; x < crop.width; x += 1) {
    const sx = image.width - cw + Math.floor(x / scale);
    const sp = (sy * image.width + sx) * 4;
    const dp = (y * crop.width + x) * 4;
    crop.data[dp] = overlay[sp];
    crop.data[dp + 1] = overlay[sp + 1];
    crop.data[dp + 2] = overlay[sp + 2];
    crop.data[dp + 3] = 255;
  }
}
savePng(crop, path.join("tools", "out", `${outName}-corner.png`));
