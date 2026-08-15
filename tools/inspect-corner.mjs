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
await esbuild.build({
  entryPoints: ["src/utils/watermarkDetector.ts"],
  bundle: true,
  format: "esm",
  outfile: bundle,
  logLevel: "error",
});
const mod = await import(`${new URL(`file:///${path.resolve(bundle)}`).href}?t=${Date.now()}`);

const src = process.argv[2];
const image = loadImage(src);
const input = new ImageDataShim(new Uint8ClampedArray(image.data), image.width, image.height);

// Dump every component that survives only the softest filters by temporarily patching via debug at 0
const all = mod.debugOverlayCandidates(input, 0);
console.log("passing hard gates", all.length);
console.table(all);

// Also scan bottom-right brightness peaks for a remaining sparkle
const peaks = [];
for (let y = image.height - 80; y < image.height; y += 1) {
  for (let x = image.width - 120; x < image.width; x += 1) {
    const p = (y * image.width + x) * 4;
    const r = image.data[p];
    const g = image.data[p + 1];
    const b = image.data[p + 2];
    const yv = 0.299 * r + 0.587 * g + 0.114 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (yv >= 210 && chroma <= 35) peaks.push({ x, y, yv: Math.round(yv), chroma });
  }
}
console.log("bright near-white pixels in BR corner", peaks.length);
console.log(peaks.slice(0, 20));

const cropW = 120;
const cropH = 80;
const scale = 4;
const crop = {
  width: cropW * scale,
  height: cropH * scale,
  data: new Uint8Array(cropW * scale * cropH * scale * 4),
};
for (let y = 0; y < crop.height; y += 1) {
  const sy = image.height - cropH + Math.floor(y / scale);
  for (let x = 0; x < crop.width; x += 1) {
    const sx = image.width - cropW + Math.floor(x / scale);
    const sp = (sy * image.width + sx) * 4;
    const dp = (y * crop.width + x) * 4;
    crop.data[dp] = image.data[sp];
    crop.data[dp + 1] = image.data[sp + 1];
    crop.data[dp + 2] = image.data[sp + 2];
    crop.data[dp + 3] = 255;
  }
}
savePng(crop, path.join("tools", "out", "br-zoom.png"));
