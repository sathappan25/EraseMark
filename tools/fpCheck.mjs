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
const image = new ImageDataShim(new Uint8ClampedArray(base.data), base.width, base.height);

const detection = pipeline.detectUnwantedOverlay(image);
console.log("detected", detection.detected, "conf", detection.confidence.toFixed(2), detection.reason ?? "-");
for (const corner of ["br", "bl", "tr", "tl"]) {
  const hits = pipeline.debugSparkleHits(image, corner);
  console.log(corner, hits.length ? hits.slice(0, 5) : "none");
}
