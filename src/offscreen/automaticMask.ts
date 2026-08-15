import {
  AUTO_RESTORE_CONFIDENCE_THRESHOLD,
  detectUnwantedOverlay,
  type OverlayDetectionResult,
} from "../utils/watermarkDetector";

export function detectOverlay(imageData: ImageData): OverlayDetectionResult {
  return detectUnwantedOverlay(imageData, AUTO_RESTORE_CONFIDENCE_THRESHOLD);
}

export function createTestMask(width: number, height: number): ImageData {
  const mask = new ImageData(width, height);
  const mw = Math.min(64, Math.max(24, Math.floor(width * 0.06)));
  const mh = Math.min(32, Math.max(16, Math.floor(height * 0.04)));
  const x0 = Math.max(0, width - mw - Math.max(8, Math.floor(width * 0.02)));
  const y0 = Math.max(0, height - mh - Math.max(8, Math.floor(height * 0.02)));
  for (let y = y0; y < y0 + mh && y < height; y += 1) {
    for (let x = x0; x < x0 + mw && x < width; x += 1) {
      const i = (y * width + x) * 4;
      mask.data[i] = 255;
      mask.data[i + 1] = 255;
      mask.data[i + 2] = 255;
      mask.data[i + 3] = 255;
    }
  }
  return mask;
}
