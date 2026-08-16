import path from "node:path";
import * as esbuild from "esbuild";
import { PNG } from "pngjs";
import fs from "node:fs";

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

const bundle = path.join("tools", "out", "pipeline.bundle.mjs");
await esbuild.build({
  entryPoints: ["tools/pipelineEntry.ts"],
  bundle: true,
  format: "esm",
  outfile: bundle,
  logLevel: "error",
});
const pipeline = await import(`${new URL(`file:///${path.resolve(bundle)}`).href}?t=${Date.now()}`);

function makeScene(kind) {
  const w = 800;
  const h = 500;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = (y * w + x) * 4;
      if (kind === "green") {
        data[p] = 40 + (x % 17);
        data[p + 1] = 120 + (y % 13);
        data[p + 2] = 55;
      } else {
        data[p] = 180 + ((x + y) % 20);
        data[p + 1] = 200 + ((x * 3) % 15);
        data[p + 2] = 220;
      }
      data[p + 3] = 255;
    }
  }
  return new ImageDataShim(data, w, h);
}

function addSparkle(img, cx, cy) {
  const data = new Uint8ClampedArray(img.data);
  const size = 14;
  for (let y = -size; y <= size; y += 1) {
    for (let x = -size; x <= size; x += 1) {
      const star = Math.pow(Math.abs(x) / size, 0.55) + Math.pow(Math.abs(y) / size, 0.55);
      if (star > 1.08) continue;
      const px = cx + x;
      const py = cy + y;
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      const p = (py * img.width + px) * 4;
      const a = star <= 1 ? 0.95 : 0.4;
      for (let c = 0; c < 3; c += 1) data[p + c] = data[p + c] * (1 - a) + 255 * a;
    }
  }
  return new ImageDataShim(data, img.width, img.height);
}

function addLogo(img, cx, cy) {
  const data = new Uint8ClampedArray(img.data);
  for (let y = -12; y <= 12; y += 1) {
    for (let x = -22; x <= 22; x += 1) {
      if (Math.abs(x) > 18 && Math.abs(y) > 8) continue;
      const px = cx + x;
      const py = cy + y;
      const p = (py * img.width + px) * 4;
      for (let c = 0; c < 3; c += 1) data[p + c] = data[p + c] * 0.15 + 255 * 0.85;
    }
  }
  return new ImageDataShim(data, img.width, img.height);
}

const cases = [
  ["green-clean", makeScene("green")],
  ["green-sparkle-br", addSparkle(makeScene("green"), 760, 460)],
  ["green-sparkle-tl", addSparkle(makeScene("green"), 40, 40)],
  ["green-logo-right", addLogo(makeScene("green"), 770, 250)],
  ["sky-clean", makeScene("sky")],
  ["sky-sparkle-br", addSparkle(makeScene("sky"), 760, 460)],
];

for (const [name, img] of cases) {
  const result = pipeline.detectUnwantedOverlay(img);
  let changed = 0;
  let outside = 0;
  if (result.detected && result.mask) {
    const analysis = pipeline.analyzeMask(result.mask);
    const crop = pipeline.paddedCropRect(analysis.bbox, img.width, img.height, pipeline.CROP_PADDING);
    const cropImage = new ImageDataShim(crop.width, crop.height);
    const cropMask = new Uint8Array(crop.width * crop.height);
    for (let y = 0; y < crop.height; y += 1) {
      for (let x = 0; x < crop.width; x += 1) {
        const sp = ((crop.y + y) * img.width + (crop.x + x)) * 4;
        const dp = (y * crop.width + x) * 4;
        for (let c = 0; c < 4; c += 1) cropImage.data[dp + c] = img.data[sp + c];
        cropMask[y * crop.width + x] = result.mask.data[sp];
      }
    }
    const filled = pipeline.exemplarFill(cropImage, cropMask);
    const inpainted = new ImageDataShim(new Uint8ClampedArray(img.data), img.width, img.height);
    for (let y = 0; y < crop.height; y += 1) {
      for (let x = 0; x < crop.width; x += 1) {
        const sp = (y * crop.width + x) * 4;
        const dp = ((crop.y + y) * img.width + (crop.x + x)) * 4;
        for (let c = 0; c < 4; c += 1) inpainted.data[dp + c] = filled.data[sp + c];
      }
    }
    const out = pipeline.compositeMaskedPixels(img, inpainted, result.mask);
    changed = pipeline.countChangedPixels(img, out);
    outside = pipeline.verifyOutsideMaskUnchanged(img, out, result.mask);
  }
  console.log(
    `${name.padEnd(20)} detected=${String(result.detected).padEnd(5)} conf=${result.confidence.toFixed(2)} ` +
      `reason=${result.reason ?? "-"} changed=${changed} outside=${outside}`,
  );
}
