export const MASK_THRESHOLD = 16;
export const MAX_AUTO_MASK_PERCENT = 15;
export const MAX_AUTO_BBOX_PERCENT = 25;
/** Padding around the mask; gives the filler nearby intact pixels to copy from. */
export const CROP_PADDING = 16;
export const INNER_FEATHER_PX = 0;

export interface MaskBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MaskAnalysis {
  pixels: number;
  total: number;
  percentage: number;
  bbox: MaskBounds | null;
  bboxPercentage: number;
}

export function analyzeMask(mask: ImageData, threshold = MASK_THRESHOLD): MaskAnalysis {
  const total = Math.max(1, mask.width * mask.height);
  let pixels = 0;
  let minX = mask.width;
  let minY = mask.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      const i = (y * mask.width + x) * 4;
      if (mask.data[i] <= threshold) continue;
      pixels += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (pixels === 0 || maxX < 0) {
    return { pixels: 0, total, percentage: 0, bbox: null, bboxPercentage: 0 };
  }

  const bbox: MaskBounds = {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
  return {
    pixels,
    total,
    percentage: (pixels / total) * 100,
    bbox,
    bboxPercentage: ((bbox.width * bbox.height) / total) * 100,
  };
}

export function analyzeMaskCanvas(canvas: HTMLCanvasElement, threshold = MASK_THRESHOLD): MaskAnalysis {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { pixels: 0, total: 1, percentage: 0, bbox: null, bboxPercentage: 0 };
  return analyzeMask(ctx.getImageData(0, 0, canvas.width, canvas.height), threshold);
}

export function verifyOutsideMaskUnchanged(
  original: ImageData,
  processed: ImageData,
  mask: ImageData,
  threshold = MASK_THRESHOLD,
): number {
  let changed = 0;
  const n = Math.min(original.data.length, processed.data.length, mask.data.length);
  for (let i = 0; i < n; i += 4) {
    if (mask.data[i] > threshold) continue;
    if (
      original.data[i] !== processed.data[i] ||
      original.data[i + 1] !== processed.data[i + 1] ||
      original.data[i + 2] !== processed.data[i + 2] ||
      original.data[i + 3] !== processed.data[i + 3]
    ) {
      changed += 1;
    }
  }
  return changed;
}

export function countChangedPixels(before: ImageData, after: ImageData): number {
  let changed = 0;
  const n = Math.min(before.data.length, after.data.length);
  for (let i = 0; i < n; i += 4) {
    if (
      before.data[i] !== after.data[i] ||
      before.data[i + 1] !== after.data[i + 1] ||
      before.data[i + 2] !== after.data[i + 2]
    ) {
      changed += 1;
    }
  }
  return changed;
}

export function compositeMaskedPixels(
  original: ImageData,
  inpainted: ImageData,
  mask: ImageData,
  threshold = MASK_THRESHOLD,
): ImageData {
  const out = new ImageData(new Uint8ClampedArray(original.data), original.width, original.height);
  const width = original.width;
  const height = original.height;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (mask.data[i] <= threshold) continue;

      let edge = false;
      if (INNER_FEATHER_PX > 0) {
        if (x > 0 && mask.data[i - 4] <= threshold) edge = true;
        else if (x + 1 < width && mask.data[i + 4] <= threshold) edge = true;
        else if (y > 0 && mask.data[i - width * 4] <= threshold) edge = true;
        else if (y + 1 < height && mask.data[i + width * 4] <= threshold) edge = true;
      }

      if (edge) {
        out.data[i] = Math.round((original.data[i] + inpainted.data[i]) / 2);
        out.data[i + 1] = Math.round((original.data[i + 1] + inpainted.data[i + 1]) / 2);
        out.data[i + 2] = Math.round((original.data[i + 2] + inpainted.data[i + 2]) / 2);
        out.data[i + 3] = Math.round((original.data[i + 3] + inpainted.data[i + 3]) / 2);
      } else {
        out.data[i] = inpainted.data[i];
        out.data[i + 1] = inpainted.data[i + 1];
        out.data[i + 2] = inpainted.data[i + 2];
        out.data[i + 3] = inpainted.data[i + 3];
      }
    }
  }

  return out;
}

export function forceOriginalOutsideMask(
  original: ImageData,
  processed: ImageData,
  mask: ImageData,
  threshold = MASK_THRESHOLD,
): void {
  const n = Math.min(original.data.length, processed.data.length, mask.data.length);
  for (let i = 0; i < n; i += 4) {
    if (mask.data[i] > threshold) continue;
    processed.data[i] = original.data[i];
    processed.data[i + 1] = original.data[i + 1];
    processed.data[i + 2] = original.data[i + 2];
    processed.data[i + 3] = original.data[i + 3];
  }
}

export function paddedCropRect(
  bbox: MaskBounds,
  imageWidth: number,
  imageHeight: number,
  padding = CROP_PADDING,
): MaskBounds {
  const x = Math.max(0, bbox.x - padding);
  const y = Math.max(0, bbox.y - padding);
  const right = Math.min(imageWidth, bbox.x + bbox.width + padding);
  const bottom = Math.min(imageHeight, bbox.y + bbox.height + padding);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}
