import path from "node:path";
import * as esbuild from "esbuild";
import { loadImage } from "./imageIo.mjs";

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

// Bilinear, so upscaled test images do not gain unnaturally flat blocks of identical pixels.
function resize(image, factor) {
  const width = Math.round(image.width * factor);
  const height = Math.round(image.height * factor);
  const out = new ImageDataShim(width, height);
  for (let y = 0; y < height; y += 1) {
    const fy = Math.min(image.height - 1, y / factor);
    const y0 = Math.floor(fy);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = Math.min(image.width - 1, x / factor);
      const x0 = Math.floor(fx);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const wx = fx - x0;
      const dp = (y * width + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const p00 = image.data[(y0 * image.width + x0) * 4 + c];
        const p10 = image.data[(y0 * image.width + x1) * 4 + c];
        const p01 = image.data[(y1 * image.width + x0) * 4 + c];
        const p11 = image.data[(y1 * image.width + x1) * 4 + c];
        const top = p00 * (1 - wx) + p10 * wx;
        const bottom = p01 * (1 - wx) + p11 * wx;
        out.data[dp + c] = top * (1 - wy) + bottom * wy;
      }
    }
  }
  return out;
}

function stamp(image, cx, cy, size, alpha) {
  const out = new ImageDataShim(new Uint8ClampedArray(image.data), image.width, image.height);
  for (let y = -size; y <= size; y += 1) {
    for (let x = -size; x <= size; x += 1) {
      const star = Math.pow(Math.abs(x) / size, 0.55) + Math.pow(Math.abs(y) / size, 0.55);
      if (star > 1.06) continue;
      const px = Math.round(cx + x);
      const py = Math.round(cy + y);
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
      const a = star <= 1 ? alpha : alpha * 0.45;
      const p = (py * image.width + px) * 4;
      for (let c = 0; c < 3; c += 1) out.data[p + c] = out.data[p + c] * (1 - a) + 255 * a;
    }
  }
  return out;
}

// Mark radius in pixels held constant while the photo grows, which is the realistic case for a
// stamped mark on a large export.
for (const factor of [0.5, 1, 2, 3]) {
  const scaled = resize(base, factor);
  for (const markRadius of [8, 14, 24]) {
    const cx = scaled.width - markRadius - 20;
    const cy = scaled.height - markRadius - 18;
    const marked = stamp(scaled, cx, cy, markRadius, 0.95);
    const startedAt = Date.now();
    const detection = pipeline.detectUnwantedOverlay(marked);
    const elapsed = Date.now() - startedAt;
    let hitsMark = false;
    if (detection.mask) {
      const p = (Math.round(cy) * scaled.width + Math.round(cx)) * 4;
      hitsMark = detection.mask.data[p] > 16;
    }
    console.log(
      `${scaled.width}x${scaled.height} mark r=${markRadius} -> detected=${detection.detected} ` +
        `onMark=${hitsMark} conf=${detection.confidence.toFixed(2)} ${elapsed}ms`,
    );

    if (!hitsMark) {
      const rows = pipeline.debugSparkleAt(marked, cx, cy);
      const near = rows.filter((row) => row.metrics.inside > 120).slice(0, 14);
      for (const row of near) {
        const m = row.metrics;
        console.log(
          `    r=${String(row.radius).padStart(2)} in=${m.inside.toFixed(0)} out=${m.outside.toFixed(0)} ` +
            `score=${m.score.toFixed(0)} quad=${m.weakestQuadrant.toFixed(0)} wedge=${m.wedgeLift.toFixed(0)} ` +
            `inDev=${m.insideDeviation.toFixed(0)} ringDev=${m.ringDeviation.toFixed(0)} adj=${m.adjusted.toFixed(0)} ` +
            `${row.passes ? "PASS" : "fail"}`,
        );
      }
    }
  }
}
