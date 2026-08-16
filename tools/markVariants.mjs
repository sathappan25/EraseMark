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

function starValue(x, y, size) {
  return Math.pow(Math.abs(x) / size, 0.55) + Math.pow(Math.abs(y) / size, 0.55);
}

/**
 * style: filled | outline
 * ink: [r, g, b] or "gradient" for the blue/purple ramp AI tools often use
 */
function stamp(image, cx, cy, size, { style, ink, alpha }) {
  const out = new ImageDataShim(new Uint8ClampedArray(image.data), image.width, image.height);
  const truth = new Uint8Array(image.width * image.height);
  for (let y = -size - 2; y <= size + 2; y += 1) {
    for (let x = -size - 2; x <= size + 2; x += 1) {
      const value = starValue(x, y, size);
      if (value > 1.06) continue;
      if (style === "outline" && value < 0.62) continue;
      const px = Math.round(cx + x);
      const py = Math.round(cy + y);
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
      const a = value <= 1 ? alpha : alpha * 0.45;
      let color = ink;
      if (ink === "gradient") {
        const t = (x + size) / (2 * size);
        color = [70 + 60 * t, 110 + 40 * t, 240 - 30 * t];
      }
      const p = (py * image.width + px) * 4;
      for (let c = 0; c < 3; c += 1) {
        out.data[p + c] = out.data[p + c] * (1 - a) + color[c] * a;
      }
      if (a >= 0.3) truth[py * image.width + px] = 1;
    }
  }
  return { image: out, truth };
}

const white = [255, 255, 255];
const black = [12, 12, 16];
const cases = [
  ["clean", null],
  ["white-filled", { style: "filled", ink: white, alpha: 0.95 }],
  ["white-outline", { style: "outline", ink: white, alpha: 0.95 }],
  ["gradient-filled", { style: "filled", ink: "gradient", alpha: 0.95 }],
  ["gradient-outline", { style: "outline", ink: "gradient", alpha: 0.95 }],
  ["black-filled", { style: "filled", ink: black, alpha: 0.9 }],
  ["white-soft", { style: "filled", ink: white, alpha: 0.55 }],
];

for (const [name, spec] of cases) {
  const size = 15;
  const cx = base.width - 40;
  const cy = base.height - 38;
  const { image, truth } = spec
    ? stamp(base, cx, cy, size, spec)
    : {
        image: new ImageDataShim(new Uint8ClampedArray(base.data), base.width, base.height),
        truth: new Uint8Array(base.width * base.height),
      };

  const detection = pipeline.detectUnwantedOverlay(image);
  if (!detection.detected || !detection.mask) {
    console.log(`${name.padEnd(17)} detected=false conf=${detection.confidence.toFixed(2)}`);
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

  // Residual: mean colour error against the untouched photo across the mark's own pixels.
  let residual = 0;
  let count = 0;
  for (let i = 0; i < truth.length; i += 1) {
    if (!truth[i]) continue;
    const p = i * 4;
    residual +=
      (Math.abs(out.data[p] - base.data[p]) +
        Math.abs(out.data[p + 1] - base.data[p + 1]) +
        Math.abs(out.data[p + 2] - base.data[p + 2])) /
      3;
    count += 1;
  }

  console.log(
    `${name.padEnd(17)} detected=true conf=${detection.confidence.toFixed(2)} ` +
      `recall=${markPixels ? ((hit / markPixels) * 100).toFixed(0) : "n/a"}% mask=${maskPixels}px ` +
      `outside=${outside} residual=${count ? (residual / count).toFixed(1) : "0"}`,
  );

  if (spec) {
    const view = 120;
    const zoom = 4;
    const ox = Math.max(0, Math.min(base.width - view, cx - view / 2));
    const oy = Math.max(0, Math.min(base.height - view, cy - view / 2));
    const panel = {
      width: view * zoom * 2,
      height: view * zoom,
      data: new Uint8Array(view * zoom * 2 * view * zoom * 4),
    };
    for (let y = 0; y < view * zoom; y += 1) {
      for (let x = 0; x < view * zoom; x += 1) {
        const sx = ox + Math.floor(x / zoom);
        const sy = oy + Math.floor(y / zoom);
        const sp = (sy * base.width + sx) * 4;
        const lp = (y * panel.width + x) * 4;
        const rp = (y * panel.width + view * zoom + x) * 4;
        for (let c = 0; c < 3; c += 1) {
          panel.data[lp + c] = image.data[sp + c];
          panel.data[rp + c] = out.data[sp + c];
        }
        panel.data[lp + 3] = 255;
        panel.data[rp + 3] = 255;
      }
    }
    savePng(panel, path.join("tools", "out", `variant-${name}.png`));
  }
}
