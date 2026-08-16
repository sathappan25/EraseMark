import { exemplarFill } from "./exemplarFill";
import { inpaintTeleaJs } from "./inpaintFallback";
import { MASK_THRESHOLD } from "./maskStats";

const WINDOW_RADIUS = 5;
/** Below this local spread the area counts as smooth, above it as textured. */
const SMOOTH_SPREAD = 8;
const TEXTURED_SPREAD = 22;

interface KnownStats {
  count: Float64Array;
  sum: Float64Array;
  sumSquares: Float64Array;
  width: number;
  height: number;
}

function integrals(source: ImageData, known: Uint8Array): KnownStats {
  const width = source.width + 1;
  const height = source.height + 1;
  const count = new Float64Array(width * height);
  const sum = new Float64Array(width * height);
  const sumSquares = new Float64Array(width * height);

  for (let y = 1; y < height; y += 1) {
    for (let x = 1; x < width; x += 1) {
      const i = (y - 1) * source.width + (x - 1);
      const p = i * 4;
      const isKnown = known[i] ? 1 : 0;
      const luma = isKnown
        ? 0.299 * source.data[p] + 0.587 * source.data[p + 1] + 0.114 * source.data[p + 2]
        : 0;
      const here = y * width + x;
      const up = (y - 1) * width + x;
      const left = y * width + (x - 1);
      const upLeft = (y - 1) * width + (x - 1);
      count[here] = isKnown + count[up] + count[left] - count[upLeft];
      sum[here] = luma + sum[up] + sum[left] - sum[upLeft];
      sumSquares[here] = luma * luma + sumSquares[up] + sumSquares[left] - sumSquares[upLeft];
    }
  }

  return { count, sum, sumSquares, width, height };
}

function windowSpread(stats: KnownStats, x: number, y: number, radius: number): number {
  const x0 = Math.max(0, x - radius);
  const y0 = Math.max(0, y - radius);
  const x1 = Math.min(stats.width - 2, x + radius);
  const y1 = Math.min(stats.height - 2, y + radius);
  const a = y0 * stats.width + x0;
  const b = y0 * stats.width + (x1 + 1);
  const c = (y1 + 1) * stats.width + x0;
  const d = (y1 + 1) * stats.width + (x1 + 1);
  const n = stats.count[d] - stats.count[b] - stats.count[c] + stats.count[a];
  if (n < 8) return TEXTURED_SPREAD;
  const total = stats.sum[d] - stats.sum[b] - stats.sum[c] + stats.sum[a];
  const totalSquares = stats.sumSquares[d] - stats.sumSquares[b] - stats.sumSquares[c] + stats.sumSquares[a];
  const mean = total / n;
  return Math.sqrt(Math.max(0, totalSquares / n - mean * mean));
}

/**
 * Fills the mask with copied texture where the surroundings are detailed and with a smooth blend
 * where they are flat, mixing the two per pixel so neither sky banding nor smudged detail appears.
 */
export function hybridFill(source: ImageData, maskGray: Uint8Array, radius: number): ImageData {
  const known = new Uint8Array(source.width * source.height);
  for (let i = 0; i < known.length; i += 1) known[i] = maskGray[i] > MASK_THRESHOLD ? 0 : 1;

  const textured = exemplarFill(source, maskGray);
  const smooth = inpaintTeleaJs(source, maskGray, radius);
  const stats = integrals(source, known);
  const output = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const i = y * source.width + x;
      if (known[i]) continue;
      const spread = windowSpread(stats, x, y, WINDOW_RADIUS);
      const weight = Math.min(
        1,
        Math.max(0, (spread - SMOOTH_SPREAD) / (TEXTURED_SPREAD - SMOOTH_SPREAD)),
      );
      const p = i * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        output.data[p + channel] =
          smooth.data[p + channel] * (1 - weight) + textured.data[p + channel] * weight;
      }
    }
  }

  return output;
}
