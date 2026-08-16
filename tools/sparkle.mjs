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

function withSparkle(cx, cy, size, alpha) {
  const data = new Uint8ClampedArray(base.data);
  const truth = new Uint8Array(base.width * base.height);
  for (let y = -size; y <= size; y += 1) {
    for (let x = -size; x <= size; x += 1) {
      const star = Math.pow(Math.abs(x) / size, 0.55) + Math.pow(Math.abs(y) / size, 0.55);
      if (star > 1.06) continue;
      const px = Math.round(cx + x);
      const py = Math.round(cy + y);
      if (px < 0 || py < 0 || px >= base.width || py >= base.height) continue;
      const a = star <= 1 ? alpha : alpha * 0.45;
      const p = (py * base.width + px) * 4;
      for (let c = 0; c < 3; c += 1) data[p + c] = data[p + c] * (1 - a) + 255 * a;
      if (a >= 0.3) truth[py * base.width + px] = 1;
    }
  }
  return { image: new ImageDataShim(data, base.width, base.height), truth };
}

const cases = [
  ["clean", null],
  ["br-24-opaque", [base.width - 38, base.height - 34, 12, 0.95]],
  ["br-40-opaque", [base.width - 52, base.height - 48, 20, 0.95]],
  ["br-16-soft", [base.width - 30, base.height - 28, 8, 0.6]],
  ["bl-24-opaque", [40, base.height - 36, 12, 0.95]],
  ["tr-24-opaque", [base.width - 38, 34, 12, 0.95]],
  ["tl-30-soft", [46, 40, 15, 0.7]],
];

for (const [name, spec] of cases) {
  const { image, truth } = spec
    ? withSparkle(spec[0], spec[1], spec[2], spec[3])
    : { image: new ImageDataShim(new Uint8ClampedArray(base.data), base.width, base.height), truth: new Uint8Array(base.width * base.height) };

  const detection = pipeline.detectUnwantedOverlay(image);
  if (!detection.detected || !detection.mask) {
    console.log(`${name.padEnd(14)} detected=false reason=${detection.reason ?? "-"} conf=${detection.confidence.toFixed(2)}`);
    continue;
  }

  let hit = 0;
  let markPixels = 0;
  let maskPixels = 0;
  for (let i = 0; i < truth.length; i += 1) {
    const inMask = detection.mask.data[i * 4] > 16;
    if (truth[i]) markPixels += 1;
    if (inMask) maskPixels += 1;
    if (truth[i] && inMask) hit += 1;
  }

  const analysis = pipeline.analyzeMask(detection.mask);
  console.log(`  bbox=${JSON.stringify(analysis.bbox)} pixels=${analysis.pixels}`);
  const crop = pipeline.paddedCropRect(analysis.bbox, image.width, image.height, pipeline.CROP_PADDING);
  const cropImage = new ImageDataShim(crop.width, crop.height);
  const cropMask = new Uint8Array(crop.width * crop.height);
  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      const sp = ((crop.y + y) * image.width + (crop.x + x)) * 4;
      const dp = (y * crop.width + x) * 4;
      for (let c = 0; c < 4; c += 1) cropImage.data[dp + c] = image.data[sp + c];
      cropMask[y * crop.width + x] = detection.mask.data[sp];
    }
  }
  const spread = pipeline.surroundingSpread(cropImage, cropMask);
  const engine = "hybrid";
  const filled = pipeline.hybridFill(cropImage, cropMask, 3);
  const inpainted = new ImageDataShim(new Uint8ClampedArray(image.data), image.width, image.height);
  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      const sp = (y * crop.width + x) * 4;
      const dp = ((crop.y + y) * image.width + (crop.x + x)) * 4;
      for (let c = 0; c < 4; c += 1) inpainted.data[dp + c] = filled.data[sp + c];
    }
  }
  const out = pipeline.compositeMaskedPixels(image, inpainted, detection.mask);
  const outside = pipeline.verifyOutsideMaskUnchanged(image, out, detection.mask);

  // Residual: how much of the mark's brightness survives inside the mark area.
  let leftover = 0;
  let leftoverCount = 0;
  for (let i = 0; i < truth.length; i += 1) {
    if (!truth[i]) continue;
    const p = i * 4;
    const before = (image.data[p] + image.data[p + 1] + image.data[p + 2]) / 3;
    const after = (out.data[p] + out.data[p + 1] + out.data[p + 2]) / 3;
    const orig = (base.data[p] + base.data[p + 1] + base.data[p + 2]) / 3;
    leftover += Math.abs(after - orig) < Math.abs(before - orig) ? 0 : 1;
    leftoverCount += 1;
  }

  console.log(
    `${name.padEnd(14)} detected=true conf=${detection.confidence.toFixed(2)} ` +
      `engine=${engine} spread=${spread.toFixed(1)} ` +
      `recall=${markPixels ? ((hit / markPixels) * 100).toFixed(0) : "n/a"}% ` +
      `mask=${maskPixels}px outside=${outside} notImproved=${leftoverCount ? ((leftover / leftoverCount) * 100).toFixed(0) : "0"}%`,
  );

  if (spec) {
    const worst = [];
    for (let y = crop.y; y < crop.y + crop.height; y += 1) {
      for (let x = crop.x; x < crop.x + crop.width; x += 1) {
        const p = (y * base.width + x) * 4;
        const diff =
          Math.abs(out.data[p] - base.data[p]) +
          Math.abs(out.data[p + 1] - base.data[p + 1]) +
          Math.abs(out.data[p + 2] - base.data[p + 2]);
        worst.push({ x, y, diff, inMask: detection.mask.data[p] > 16 });
      }
    }
    worst.sort((a, b) => b.diff - a.diff);
    console.log(
      `  worst residuals: ${worst
        .slice(0, 5)
        .map((w) => `(${w.x},${w.y})d=${w.diff}${w.inMask ? "" : " OUTSIDE"}`)
        .join(" ")}`,
    );
  }

  if (true) {
    const size = 130;
    const scale = 4;
    const cx = spec ? spec[0] : analysis.bbox.x + analysis.bbox.width / 2;
    const cy = spec ? spec[1] : analysis.bbox.y + analysis.bbox.height / 2;
    const ox = Math.max(0, Math.min(base.width - size, Math.round(cx - size / 2)));
    const oy = Math.max(0, Math.min(base.height - size, Math.round(cy - size / 2)));
    const panel = { width: size * scale * 2, height: size * scale, data: new Uint8Array(size * scale * 2 * size * scale * 4) };
    for (let y = 0; y < size * scale; y += 1) {
      for (let x = 0; x < size * scale; x += 1) {
        const sx = ox + Math.floor(x / scale);
        const sy = oy + Math.floor(y / scale);
        const sp = (sy * base.width + sx) * 4;
        const left = (y * panel.width + x) * 4;
        const right = (y * panel.width + size * scale + x) * 4;
        for (let c = 0; c < 3; c += 1) {
          panel.data[left + c] = image.data[sp + c];
          panel.data[right + c] = out.data[sp + c];
        }
        panel.data[left + 3] = 255;
        panel.data[right + 3] = 255;
      }
    }
    savePng(panel, path.join("tools", "out", `sparkle-${name}.png`));
  }
}
