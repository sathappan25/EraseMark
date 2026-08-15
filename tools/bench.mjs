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

for (const side of [30, 60, 120, 200]) {
  const w = Math.min(base.width, side + 80);
  const h = Math.min(base.height, side + 80);
  const crop = new ImageDataShim(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sp = (y * base.width + x) * 4;
      const dp = (y * w + x) * 4;
      for (let c = 0; c < 4; c += 1) crop.data[dp + c] = base.data[sp + c];
    }
  }
  const mask = new Uint8Array(w * h);
  let count = 0;
  const ox = ((w - side) / 2) | 0;
  const oy = ((h - side) / 2) | 0;
  for (let y = oy; y < oy + side; y += 1) {
    for (let x = ox; x < ox + side; x += 1) {
      mask[y * w + x] = 255;
      count += 1;
    }
  }

  const t0 = Date.now();
  pipeline.exemplarFill(crop, mask);
  const exemplarMs = Date.now() - t0;
  const t1 = Date.now();
  pipeline.nearestNeighborFill(crop, mask);
  const nearestMs = Date.now() - t1;
  console.log(`mask ${String(count).padStart(6)}px  exemplar ${exemplarMs}ms  nearest ${nearestMs}ms`);
}
