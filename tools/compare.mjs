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

const bundle = path.join("tools", "out", "pipeline.bundle.mjs");
await esbuild.build({
  entryPoints: ["tools/pipelineEntry.ts"],
  bundle: true,
  format: "esm",
  outfile: bundle,
  logLevel: "error",
});
const pipeline = await import(`${new URL(`file:///${path.resolve(bundle)}`).href}?t=${Date.now()}`);

const base = loadImage(process.argv[2]);
const data = new Uint8ClampedArray(base.data);
const cx = base.width - 40;
const cy = base.height - 36;
const size = 13;
for (let y = -size; y <= size; y += 1) {
  for (let x = -size; x <= size; x += 1) {
    const star = Math.pow(Math.abs(x) / size, 0.55) + Math.pow(Math.abs(y) / size, 0.55);
    if (star > 1.08) continue;
    const px = cx + x;
    const py = cy + y;
    const p = (py * base.width + px) * 4;
    const alpha = star <= 1 ? 0.92 : 0.4;
    for (let c = 0; c < 3; c += 1) data[p + c] = data[p + c] * (1 - alpha) + 255 * alpha;
  }
}
const input = new ImageDataShim(data, base.width, base.height);
const detection = pipeline.detectUnwantedOverlay(input);
if (!detection.detected) {
  console.log("no detection");
  process.exit(1);
}

const analysis = pipeline.analyzeMask(detection.mask);
const crop = pipeline.paddedCropRect(analysis.bbox, base.width, base.height, pipeline.CROP_PADDING);
const cropImage = new ImageDataShim(crop.width, crop.height);
const cropMask = new Uint8Array(crop.width * crop.height);
for (let y = 0; y < crop.height; y += 1) {
  for (let x = 0; x < crop.width; x += 1) {
    const sp = ((crop.y + y) * base.width + (crop.x + x)) * 4;
    const dp = (y * crop.width + x) * 4;
    for (let c = 0; c < 4; c += 1) cropImage.data[dp + c] = input.data[sp + c];
    cropMask[y * crop.width + x] = detection.mask.data[sp];
  }
}

for (const [name, filled] of [
  ["nearest", pipeline.nearestNeighborFill(cropImage, cropMask)],
  ["exemplar", pipeline.exemplarFill(cropImage, cropMask)],
  ["diffusion", pipeline.inpaintTeleaJs(cropImage, cropMask, 3)],
]) {
  const out = new ImageDataShim(new Uint8ClampedArray(input.data), base.width, base.height);
  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      const sp = (y * crop.width + x) * 4;
      const dp = ((crop.y + y) * base.width + (crop.x + x)) * 4;
      for (let c = 0; c < 4; c += 1) out.data[dp + c] = filled.data[sp + c];
    }
  }
  const composited = pipeline.compositeMaskedPixels(input, out, detection.mask);

  // Build a side-by-side: original unmarked | marked | restored, all zoomed on the mark.
  const pad = 40;
  const x0 = Math.max(0, cx - pad);
  const y0 = Math.max(0, cy - pad);
  const w = Math.min(base.width - x0, pad * 2);
  const h = Math.min(base.height - y0, pad * 2);
  const scale = 5;
  const panel = { width: w * scale * 3, height: h * scale, data: new Uint8Array(w * scale * 3 * h * scale * 4) };
  const sources = [base, input, composited];
  for (let s = 0; s < 3; s += 1) {
    for (let y = 0; y < h * scale; y += 1) {
      for (let x = 0; x < w * scale; x += 1) {
        const sx = x0 + Math.floor(x / scale);
        const sy = y0 + Math.floor(y / scale);
        const sp = (sy * base.width + sx) * 4;
        const dp = (y * panel.width + s * w * scale + x) * 4;
        panel.data[dp] = sources[s].data[sp];
        panel.data[dp + 1] = sources[s].data[sp + 1];
        panel.data[dp + 2] = sources[s].data[sp + 2];
        panel.data[dp + 3] = 255;
      }
    }
  }
  savePng(panel, path.join("tools", "out", `compare-${name}.png`));

  const outside = pipeline.verifyOutsideMaskUnchanged(input, composited, detection.mask);
  let markMae = 0;
  let n = 0;
  for (let i = 0; i < base.width * base.height; i += 1) {
    if (detection.mask.data[i * 4] <= 16) continue;
    const p = i * 4;
    for (let c = 0; c < 3; c += 1) {
      markMae += Math.abs(composited.data[p + c] - base.data[p + c]);
      n += 1;
    }
  }
  console.log(name, { outside, markMae: +(markMae / n).toFixed(1), mask: analysis.pixels });
}
