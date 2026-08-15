import fs from "node:fs";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";

export function loadImage(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const decoded = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  }
  const end = buf.lastIndexOf(Buffer.from("IEND"));
  const png = PNG.sync.read(end >= 0 ? buf.subarray(0, end + 8) : buf);
  return { width: png.width, height: png.height, data: png.data };
}

export function savePng(image, file) {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  fs.writeFileSync(file, PNG.sync.write(png));
}
