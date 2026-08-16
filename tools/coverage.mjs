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
const { detectUnwantedOverlay } = await import(`${new URL(`file:///${path.resolve(bundle)}`).href}?t=${Date.now()}`);

const base = loadImage(process.argv[2]);

function stamp(kind, placement) {
  const data = new Uint8ClampedArray(base.data);
  const blend = (x, y, a, tone = 255) => {
    if (x < 0 || y < 0 || x >= base.width || y >= base.height) return;
    const p = (y * base.width + x) * 4;
    for (let c = 0; c < 3; c += 1) data[p + c] = data[p + c] * (1 - a) + tone * a;
  };
  const places = {
    br: [base.width - 40, base.height - 36],
    bl: [40, base.height - 36],
    tr: [base.width - 40, 36],
    tl: [40, 36],
    bottom: [base.width / 2, base.height - 28],
    top: [base.width / 2, 28],
    right: [base.width - 28, base.height / 2],
    left: [28, base.height / 2],
  };
  const [cx, cy] = places[placement];
  if (kind === "sparkle") {
    const size = 13;
    for (let y = -size; y <= size; y += 1) {
      for (let x = -size; x <= size; x += 1) {
        const star = Math.pow(Math.abs(x) / size, 0.55) + Math.pow(Math.abs(y) / size, 0.55);
        if (star <= 1) blend(cx + x, cy + y, 0.92);
        else if (star <= 1.08) blend(cx + x, cy + y, 0.4);
      }
    }
  } else if (kind === "logo") {
    for (let y = -10; y <= 10; y += 1) {
      for (let x = -18; x <= 18; x += 1) {
        if (Math.abs(x) > 16 && Math.abs(y) > 7) continue;
        blend(cx + x, cy + y, 0.85);
      }
    }
  } else if (kind === "text") {
    for (let g = 0; g < 8; g += 1) {
      const gx = cx - 50 + g * 13;
      for (let y = 0; y < 14; y += 1) {
        blend(gx, cy - 7 + y, 0.9, 10);
        blend(gx + 1, cy - 7 + y, 0.9, 10);
        blend(gx + 7, cy - 7 + y, 0.9, 10);
      }
      for (let x = 0; x <= 7; x += 1) blend(gx + x, cy, 0.9, 10);
    }
  }
  return new ImageDataShim(data, base.width, base.height);
}

const cases = [
  ["none", "br"],
  ["sparkle", "br"],
  ["sparkle", "bl"],
  ["sparkle", "tr"],
  ["sparkle", "tl"],
  ["logo", "br"],
  ["logo", "right"],
  ["logo", "left"],
  ["text", "bottom"],
  ["text", "top"],
];

for (const [kind, place] of cases) {
  const img = kind === "none" ? new ImageDataShim(new Uint8ClampedArray(base.data), base.width, base.height) : stamp(kind, place);
  const result = detectUnwantedOverlay(img);
  console.log(
    `${kind.padEnd(8)} ${place.padEnd(6)} detected=${String(result.detected).padEnd(5)} conf=${result.confidence.toFixed(2)} reason=${result.reason ?? "-"}`,
  );
}
