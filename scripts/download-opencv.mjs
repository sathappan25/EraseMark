import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(rootDir, "public");
const target = resolve(publicDir, "opencv.js");
const packaged = resolve(rootDir, "node_modules/@techstark/opencv-js/dist/opencv.js");

mkdirSync(publicDir, { recursive: true });

if (existsSync(target) && statSync(target).size > 1_000_000) {
  console.log("OpenCV.js already present.");
  process.exit(0);
}

if (existsSync(packaged) && statSync(packaged).size > 1_000_000) {
  copyFileSync(packaged, target);
  console.log(`Copied OpenCV.js (${Math.round(statSync(target).size / 1024 / 1024)} MB)`);
  process.exit(0);
}

console.warn(
  "Could not find OpenCV.js. Install @techstark/opencv-js or the editor will use the built-in fallback engine.",
);
process.exit(0);
