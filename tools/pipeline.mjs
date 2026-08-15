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
const total = base.width * base.height;

function withMark(kind) {
  const data = new Uint8ClampedArray(base.data);
  const truth = new Uint8Array(base.width * base.height);
  const blend = (x, y, alpha, tone = 255) => {
    if (x < 0 || y < 0 || x >= base.width || y >= base.height) return;
    const p = (y * base.width + x) * 4;
    for (let c = 0; c < 3; c += 1) data[p + c] = data[p + c] * (1 - alpha) + tone * alpha;
    if (alpha >= 0.3) truth[y * base.width + x] = 1;
  };
  if (kind === "sparkle" || kind === "translucent") {
    const alpha = kind === "sparkle" ? 0.92 : 0.55;
    const cx = base.width - 40;
    const cy = base.height - 36;
    const size = 13;
    for (let y = -size; y <= size; y += 1) {
      for (let x = -size; x <= size; x += 1) {
        const star = Math.pow(Math.abs(x) / size, 0.55) + Math.pow(Math.abs(y) / size, 0.55);
        if (star <= 1) blend(cx + x, cy + y, alpha);
        else if (star <= 1.08) blend(cx + x, cy + y, alpha * 0.45);
      }
    }
  }
  if (kind === "darkText") {
    const y0 = base.height - 30;
    for (let g = 0; g < 7; g += 1) {
      const gx = 30 + g * 13;
      for (let y = 0; y < 15; y += 1) {
        blend(gx, y0 + y, 0.9, 10);
        blend(gx + 1, y0 + y, 0.9, 10);
        blend(gx + 7, y0 + y, 0.9, 10);
      }
      for (let x = 0; x <= 7; x += 1) blend(gx + x, y0 + 7, 0.9, 10);
    }
  }
  return { image: new ImageDataShim(data, base.width, base.height), truth };
}

function maskAgreement(mask, truth) {
  let hit = 0;
  let markPixels = 0;
  let maskPixels = 0;
  for (let i = 0; i < truth.length; i += 1) {
    const inMask = mask.data[i * 4] > 16;
    if (truth[i]) markPixels += 1;
    if (inMask) maskPixels += 1;
    if (truth[i] && inMask) hit += 1;
  }
  return {
    markPixels,
    maskPixels,
    recall: markPixels ? hit / markPixels : 0,
    precision: maskPixels ? hit / maskPixels : 0,
  };
}

function regionError(a, b, box) {
  let sum = 0;
  let n = 0;
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const p = (y * base.width + x) * 4;
      for (let c = 0; c < 3; c += 1) sum += Math.abs(a.data[p + c] - b.data[p + c]);
      n += 3;
    }
  }
  return n ? sum / n : 0;
}

/** Mirrors restoreConservatively: crop around the mask, inpaint the crop, composite masked pixels only. */
function runRestore(input, mask) {
  const analysis = pipeline.analyzeMask(mask);
  if (!analysis.bbox) return null;
  const crop = pipeline.paddedCropRect(analysis.bbox, input.width, input.height, pipeline.CROP_PADDING);

  const cropImage = new ImageDataShim(crop.width, crop.height);
  const cropMask = new Uint8Array(crop.width * crop.height);
  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      const sp = ((crop.y + y) * input.width + (crop.x + x)) * 4;
      const dp = (y * crop.width + x) * 4;
      for (let c = 0; c < 4; c += 1) cropImage.data[dp + c] = input.data[sp + c];
      cropMask[y * crop.width + x] = mask.data[sp];
    }
  }

  const filled =
    process.env.ENGINE === "diffusion"
      ? pipeline.inpaintTeleaJs(cropImage, cropMask, 3)
      : process.env.ENGINE === "exemplar"
        ? pipeline.exemplarFill(cropImage, cropMask)
        : pipeline.nearestNeighborFill(cropImage, cropMask);
  const inpainted = new ImageDataShim(new Uint8ClampedArray(input.data), input.width, input.height);
  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      const sp = (y * crop.width + x) * 4;
      const dp = ((crop.y + y) * input.width + (crop.x + x)) * 4;
      for (let c = 0; c < 4; c += 1) inpainted.data[dp + c] = filled.data[sp + c];
    }
  }

  const composited = pipeline.compositeMaskedPixels(input, inpainted, mask);
  return { analysis, crop, composited };
}

for (const kind of ["none", "sparkle", "translucent", "darkText"]) {
  const { image: input, truth } = withMark(kind);
  const detection = pipeline.detectUnwantedOverlay(input);
  if (!detection.detected || !detection.mask) {
    console.log(`${kind.padEnd(12)} detected=false reason=${detection.reason} confidence=${detection.confidence.toFixed(2)}`);
    continue;
  }

  const restored = runRestore(input, detection.mask);
  const { analysis, composited } = restored;
  const outsideChanged = pipeline.verifyOutsideMaskUnchanged(input, composited, detection.mask);
  const totalChanged = pipeline.countChangedPixels(input, composited);
  const baseImage = new ImageDataShim(new Uint8ClampedArray(base.data), base.width, base.height);
  const box = analysis.bbox;
  const before = regionError(input, baseImage, box);
  const after = regionError(composited, baseImage, box);

  const agreement = maskAgreement(detection.mask, truth);
  console.log(
    `${kind.padEnd(12)} conf=${detection.confidence.toFixed(2)} ` +
      `mask=${analysis.pixels}px mark=${agreement.markPixels}px ` +
      `recall=${(agreement.recall * 100).toFixed(0)}% precision=${(agreement.precision * 100).toFixed(0)}% ` +
      `changed=${totalChanged} outside=${outsideChanged} ` +
      `err before=${before.toFixed(1)} after=${after.toFixed(1)}`,
  );

  const out = new Uint8Array(composited.data);
  for (let i = 0; i < total; i += 1) out[i * 4 + 3] = 255;
  savePng({ width: base.width, height: base.height, data: out }, path.join("tools", "out", `restored-${kind}.png`));

  const cw = 150;
  const chh = 110;
  const scale = 4;
  const zoom = { width: cw * scale, height: chh * scale, data: new Uint8Array(cw * scale * chh * scale * 4) };
  const ox = Math.max(0, Math.min(base.width - cw, box.x + box.width / 2 - cw / 2)) | 0;
  const oy = Math.max(0, Math.min(base.height - chh, box.y + box.height / 2 - chh / 2)) | 0;
  for (let y = 0; y < zoom.height; y += 1) {
    for (let x = 0; x < zoom.width; x += 1) {
      const sp = ((oy + Math.floor(y / scale)) * base.width + ox + Math.floor(x / scale)) * 4;
      const dp = (y * zoom.width + x) * 4;
      zoom.data[dp] = composited.data[sp];
      zoom.data[dp + 1] = composited.data[sp + 1];
      zoom.data[dp + 2] = composited.data[sp + 2];
      zoom.data[dp + 3] = 255;
    }
  }
  savePng(zoom, path.join("tools", "out", `restored-${kind}-zoom.png`));
}
