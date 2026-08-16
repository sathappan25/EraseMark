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

const bundle = path.join("tools", "out", "detector.mjs");
await esbuild.build({
  entryPoints: ["src/utils/watermarkDetector.ts"],
  bundle: true,
  format: "esm",
  outfile: bundle,
  logLevel: "error",
});
const { debugOverlayCandidates } = await import(`${new URL(`file:///${path.resolve(bundle)}`).href}?t=${Date.now()}`);

const base = loadImage(process.argv[2]);
const data = new Uint8ClampedArray(base.data);
const cx = base.width - 40;
const cy = 36;
const size = 13;
for (let y = -size; y <= size; y += 1) {
  for (let x = -size; x <= size; x += 1) {
    const star = Math.pow(Math.abs(x) / size, 0.55) + Math.pow(Math.abs(y) / size, 0.55);
    if (star > 1.08) continue;
    const px = cx + x;
    const py = cy + y;
    const p = (py * base.width + px) * 4;
    const a = star <= 1 ? 0.92 : 0.4;
    for (let c = 0; c < 3; c += 1) data[p + c] = data[p + c] * (1 - a) + 255 * a;
  }
}
const candidates = debugOverlayCandidates(new ImageDataShim(data, base.width, base.height), 0);
console.table(candidates.slice(0, 12));
