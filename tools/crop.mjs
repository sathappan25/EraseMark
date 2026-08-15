import fs from "node:fs";
import path from "node:path";
import { loadImage, savePng } from "./imageIo.mjs";

const [, , src, outDir] = process.argv;
const image = loadImage(src);
console.log("size", image.width, image.height);

function crop(x, y, w, h, scale, name) {
  const out = { width: w * scale, height: h * scale, data: new Uint8Array(w * scale * h * scale * 4) };
  for (let oy = 0; oy < out.height; oy += 1) {
    const sy = Math.min(image.height - 1, y + Math.floor(oy / scale));
    for (let ox = 0; ox < out.width; ox += 1) {
      const sx = Math.min(image.width - 1, x + Math.floor(ox / scale));
      const sp = (sy * image.width + sx) * 4;
      const dp = (oy * out.width + ox) * 4;
      out.data[dp] = image.data[sp];
      out.data[dp + 1] = image.data[sp + 1];
      out.data[dp + 2] = image.data[sp + 2];
      out.data[dp + 3] = 255;
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  savePng(out, path.join(outDir, name));
}

const cw = Math.min(240, image.width);
const ch = Math.min(150, image.height);
crop(image.width - cw, image.height - ch, cw, ch, 3, "bottom-right.png");
crop(0, image.height - ch, cw, ch, 3, "bottom-left.png");
