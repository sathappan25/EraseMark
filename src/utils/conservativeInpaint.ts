import type { InpaintAlgorithm } from "../types";
import { createCanvas, getContext2d } from "./canvas";
import { hybridFill } from "./hybridFill";
import { nearestNeighborFill } from "./nearestNeighborFill";
import { restoreImageLocal, tryRestoreWithOpenCv } from "./inpaint";
import {
  CROP_PADDING,
  analyzeMask,
  compositeMaskedPixels,
  countChangedPixels,
  forceOriginalOutsideMask,
  paddedCropRect,
  verifyOutsideMaskUnchanged,
  type MaskAnalysis,
} from "./maskStats";

export const INPAINT_RADIUS_DEFAULT = 3;
export const INPAINT_RADIUS_ALLOWED = [3, 5] as const;
export type ConservativeInpaintRadius = (typeof INPAINT_RADIUS_ALLOWED)[number];

/** Only specks fall back to nearest-pixel copying; everything else uses patch matching. */
const NEAREST_MAX_MASK_PIXELS = 40;
const EXEMPLAR_MAX_MASK_PIXELS = 60_000;

export interface ConservativeRestoreResult {
  canvas: HTMLCanvasElement;
  engine: "nearest" | "exemplar" | "opencv" | "fallback";
  analysis: MaskAnalysis;
  outsideChanged: number;
  totalChanged: number;
}

function log(...args: unknown[]): void {
  console.log("[EraseMark]", ...args);
}

function cropCanvases(
  imageCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  crop: { x: number; y: number; width: number; height: number },
): { imageCrop: HTMLCanvasElement; maskCrop: HTMLCanvasElement } {
  const imageCrop = createCanvas(crop.width, crop.height);
  const maskCrop = createCanvas(crop.width, crop.height);
  (getContext2d(imageCrop) as CanvasRenderingContext2D).drawImage(
    imageCanvas,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  );
  (getContext2d(maskCrop) as CanvasRenderingContext2D).drawImage(
    maskCanvas,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  );
  return { imageCrop, maskCrop };
}

function fillCropWithTexture(
  imageCrop: HTMLCanvasElement,
  maskCrop: HTMLCanvasElement,
  maskPixels: number,
  radius: number,
): { canvas: HTMLCanvasElement; engine: "nearest" | "exemplar" } {
  const imageCtx = getContext2d(imageCrop) as CanvasRenderingContext2D;
  const maskCtx = getContext2d(maskCrop) as CanvasRenderingContext2D;
  const source = imageCtx.getImageData(0, 0, imageCrop.width, imageCrop.height);
  const maskData = maskCtx.getImageData(0, 0, maskCrop.width, maskCrop.height);
  const maskGray = new Uint8Array(maskCrop.width * maskCrop.height);
  for (let i = 0; i < maskGray.length; i += 1) {
    maskGray[i] = maskData.data[i * 4];
  }

  const engine = maskPixels <= NEAREST_MAX_MASK_PIXELS ? "nearest" : "exemplar";
  const filled =
    engine === "nearest" ? nearestNeighborFill(source, maskGray) : hybridFill(source, maskGray, radius);
  const output = createCanvas(imageCrop.width, imageCrop.height);
  (getContext2d(output) as CanvasRenderingContext2D).putImageData(filled, 0, 0);
  return { canvas: output, engine };
}

export function restoreConservatively(
  imageCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  radius: number = INPAINT_RADIUS_DEFAULT,
  algorithm: InpaintAlgorithm = "TELEA",
): ConservativeRestoreResult {
  if (imageCanvas.width !== maskCanvas.width || imageCanvas.height !== maskCanvas.height) {
    throw new Error("The mask must match the original image dimensions.");
  }

  const safeRadius = radius >= 5 ? 5 : 3;
  const originalCtx = getContext2d(imageCanvas) as CanvasRenderingContext2D;
  const maskCtx = getContext2d(maskCanvas) as CanvasRenderingContext2D;
  const original = originalCtx.getImageData(0, 0, imageCanvas.width, imageCanvas.height);
  const mask = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  const analysis = analyzeMask(mask);

  log("Original dimensions:", `${imageCanvas.width} x ${imageCanvas.height}`);
  log("Mask dimensions:", `${mask.width} x ${mask.height}`);
  log("Mask pixels:", analysis.pixels);
  log("Mask percentage:", `${analysis.percentage.toFixed(2)}%`);
  log(
    "Bounding box:",
    analysis.bbox
      ? `x=${analysis.bbox.x} y=${analysis.bbox.y} w=${analysis.bbox.width} h=${analysis.bbox.height}`
      : "none",
  );
  log("Inpainting radius:", safeRadius);

  if (analysis.pixels === 0 || !analysis.bbox) {
    throw new Error("No watermark area selected.");
  }

  const crop = paddedCropRect(analysis.bbox, imageCanvas.width, imageCanvas.height, CROP_PADDING);
  log("Processing crop:", `x=${crop.x} y=${crop.y} w=${crop.width} h=${crop.height}`);

  const { imageCrop, maskCrop } = cropCanvases(imageCanvas, maskCanvas, crop);
  let engine: ConservativeRestoreResult["engine"];
  let inpaintedCrop: HTMLCanvasElement | null = null;

  if (analysis.pixels <= EXEMPLAR_MAX_MASK_PIXELS) {
    const filled = fillCropWithTexture(imageCrop, maskCrop, analysis.pixels, safeRadius);
    inpaintedCrop = filled.canvas;
    engine = filled.engine;
    log(engine === "nearest" ? "Filling from nearest pixels" : "Filling with texture and blend mix");
  } else {
    inpaintedCrop = tryRestoreWithOpenCv(imageCrop, maskCrop, safeRadius, algorithm);
    engine = inpaintedCrop ? "opencv" : "fallback";
    if (!inpaintedCrop) {
      log("OpenCV inpaint unavailable; using local engine");
      inpaintedCrop = restoreImageLocal(imageCrop, maskCrop, safeRadius, algorithm);
    }
  }

  const fullInpainted = createCanvas(imageCanvas.width, imageCanvas.height);
  const fullCtx = getContext2d(fullInpainted) as CanvasRenderingContext2D;
  fullCtx.putImageData(original, 0, 0);
  fullCtx.drawImage(inpaintedCrop, crop.x, crop.y);
  const inpaintedData = fullCtx.getImageData(0, 0, imageCanvas.width, imageCanvas.height);

  log("Compositing masked pixels:");
  const composited = compositeMaskedPixels(original, inpaintedData, mask);
  log("Preserving original pixels:");

  let outsideChanged = verifyOutsideMaskUnchanged(original, composited, mask);
  if (outsideChanged > 0) {
    console.warn("[EraseMark] WARNING:", "Pixels outside mask were modified.", outsideChanged);
    forceOriginalOutsideMask(original, composited, mask);
    outsideChanged = verifyOutsideMaskUnchanged(original, composited, mask);
  }

  const output = createCanvas(imageCanvas.width, imageCanvas.height);
  (getContext2d(output) as CanvasRenderingContext2D).putImageData(composited, 0, 0);
  const totalChanged = countChangedPixels(original, composited);
  log("Final image generated:", `${output.width} x ${output.height}`);

  return { canvas: output, engine, analysis, outsideChanged, totalChanged };
}
