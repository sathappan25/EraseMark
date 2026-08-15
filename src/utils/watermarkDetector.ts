export const AUTO_RESTORE_CONFIDENCE_THRESHOLD = 0.62;

export type OverlayDetectionReason = "low-confidence" | "too-large" | "empty";

export interface OverlayDetectionResult {
  detected: boolean;
  confidence: number;
  mask: ImageData | null;
  reason?: OverlayDetectionReason;
}

const ANALYSIS_MAX = 640;
const MAX_MASK_COVERAGE = 0.06;
const MIN_MASK_PIXELS = 24;
const FULL_DILATE_RADIUS = 3;
const TEXTURE_CANDIDATE_LIMIT = 12;

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max <= 1) return 0;
  return (max - min) / max;
}

function downscale(source: ImageData, width: number, height: number): ImageData {
  if (width === source.width && height === source.height) return source;
  const out = new ImageData(width, height);
  const ratioX = source.width / width;
  const ratioY = source.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * ratioY);
    const y1 = Math.min(source.height, Math.max(y0 + 1, Math.floor((y + 1) * ratioY)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * ratioX);
      const x1 = Math.min(source.width, Math.max(x0 + 1, Math.floor((x + 1) * ratioX)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const p = (sy * source.width + sx) * 4;
          r += source.data[p];
          g += source.data[p + 1];
          b += source.data[p + 2];
          a += source.data[p + 3];
          n += 1;
        }
      }
      const dp = (y * width + x) * 4;
      out.data[dp] = r / n;
      out.data[dp + 1] = g / n;
      out.data[dp + 2] = b / n;
      out.data[dp + 3] = a / n;
    }
  }
  return out;
}

function boxBlur(input: Float32Array, width: number, height: number, radius: number): Float32Array {
  const tmp = new Float32Array(input.length);
  const out = new Float32Array(input.length);
  const size = radius * 2 + 1;

  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) {
      sum += input[y * width + Math.min(width - 1, Math.max(0, x))];
    }
    for (let x = 0; x < width; x += 1) {
      tmp[y * width + x] = sum / size;
      const leave = input[y * width + Math.min(width - 1, Math.max(0, x - radius))];
      const enter = input[y * width + Math.min(width - 1, x + radius + 1)];
      sum += enter - leave;
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) {
      sum += tmp[Math.min(height - 1, Math.max(0, y)) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum / size;
      const leave = tmp[Math.min(height - 1, Math.max(0, y - radius)) * width + x];
      const enter = tmp[Math.min(height - 1, y + radius + 1) * width + x];
      sum += enter - leave;
    }
  }

  return out;
}

interface Component {
  id: number;
  pixels: number[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function connectedComponents(mask: Uint8Array, width: number, height: number): Component[] {
  const labels = new Int32Array(width * height);
  labels.fill(-1);
  const components: Component[] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start] !== -1) continue;
    const id = components.length;
    const pixels: number[] = [];
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    stack.push(start);
    labels[start] = id;

    while (stack.length) {
      const i = stack.pop()!;
      pixels.push(i);
      const x = i % width;
      const y = (i / width) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      const neighbors = [i - 1, i + 1, i - width, i + width];
      for (const n of neighbors) {
        if (n < 0 || n >= mask.length || !mask[n] || labels[n] !== -1) continue;
        const nx = n % width;
        const ny = (n / width) | 0;
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        labels[n] = id;
        stack.push(n);
      }
    }

    components.push({ id, pixels, minX, minY, maxX, maxY });
  }

  return components;
}

const CORNER_MARGIN = 0.17;
const STRIP_MARGIN = 0.1;

/** Watermarks sit in a corner box or in a thin top/bottom band. Nothing else is scanned. */
function inSearchZone(x: number, y: number, width: number, height: number): boolean {
  const inCornerX = x <= width * CORNER_MARGIN || x >= width * (1 - CORNER_MARGIN);
  const inCornerY = y <= height * CORNER_MARGIN || y >= height * (1 - CORNER_MARGIN);
  if (inCornerX && inCornerY) return true;
  return y <= height * STRIP_MARGIN || y >= height * (1 - STRIP_MARGIN);
}

interface Zone {
  corner: boolean;
  strip: boolean;
  /** Distance from the nearest image corner, normalised by the shorter image side. */
  cornerDistance: number;
}

function locateComponent(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  width: number,
  height: number,
): Zone {
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const dx = Math.min(cx, width - 1 - cx);
  const dy = Math.min(cy, height - 1 - cy);
  const shortSide = Math.max(1, Math.min(width, height));
  return {
    corner: dx <= width * CORNER_MARGIN && dy <= height * CORNER_MARGIN,
    strip: dy <= height * STRIP_MARGIN,
    cornerDistance: Math.hypot(dx, dy) / shortSide,
  };
}

interface ComponentStats {
  /** Approximate stroke thickness: thin glyph strokes stay near 1-2 pixels. */
  strokeWidth: number;
  avgChroma: number;
  /** Share of pixels that deviate from the local background in the same direction. */
  polarity: number;
  avgContrast: number;
  contrastDeviation: number;
  /** Edge crispness measured on the outline only: painted overlays cut hard, haze fades. */
  crispness: number;
  /** Spread of raw brightness inside the shape; overlays are printed in one flat tone. */
  toneDeviation: number;
  /** Share of the bounding box the shape occupies. */
  fill: number;
  /** Colour variation strictly inside the shape; an opaque overlay is one flat colour. */
  interiorDeviation: number;
  /** Variation of the push away from the background; a translucent overlay keeps one opacity. */
  residualDeviation: number;
  /**
   * Overlays are flat either in absolute colour (opaque marks) or in how far they lift the
   * background (translucent marks). Photo detail is flat in neither.
   */
  flatness: number;
  /** Mean luminance of the mark. */
  avgTone: number;
  /** How close the mark is to pure white or pure black (classic watermark ink). */
  inkNeutrality: number;
}

interface ChannelField {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

function componentStats(
  component: Component,
  gray: Float32Array,
  detail: Float32Array,
  blur: Float32Array,
  chroma: Float32Array,
  channels: ChannelField,
  channelBlur: ChannelField,
  width: number,
  height: number,
): ComponentStats {
  const size = component.pixels.length;
  const member = new Set(component.pixels);
  let perimeter = 0;
  let chromaSum = 0;
  let brighter = 0;
  let contrastSum = 0;
  let contrastSquares = 0;
  let boundaryDetailSum = 0;
  let toneSum = 0;
  let toneSquares = 0;
  let residualSum = 0;
  let residualSquares = 0;
  let interiorCount = 0;
  const interiorSum = [0, 0, 0];
  const interiorSquares = [0, 0, 0];

  for (const i of component.pixels) {
    const x = i % width;
    const y = (i / width) | 0;
    const openBoundary =
      x === 0 ||
      y === 0 ||
      x === width - 1 ||
      y === height - 1 ||
      !member.has(i - 1) ||
      !member.has(i + 1) ||
      !member.has(i - width) ||
      !member.has(i + width);
    if (openBoundary) {
      perimeter += 1;
      boundaryDetailSum += Math.abs(gray[i] - detail[i]);
    } else {
      interiorCount += 1;
      const values = [channels.r[i], channels.g[i], channels.b[i]];
      for (let c = 0; c < 3; c += 1) {
        interiorSum[c] += values[c];
        interiorSquares[c] += values[c] * values[c];
      }
    }
    chromaSum += chroma[i];
    const diff = gray[i] - blur[i];
    if (diff > 0) brighter += 1;
    const absDiff = Math.abs(diff);
    contrastSum += absDiff;
    contrastSquares += absDiff * absDiff;
    toneSum += gray[i];
    toneSquares += gray[i] * gray[i];

    const residualR = channels.r[i] - channelBlur.r[i];
    const residualG = channels.g[i] - channelBlur.g[i];
    const residualB = channels.b[i] - channelBlur.b[i];
    const residualMean = (residualR + residualG + residualB) / 3;
    residualSum += residualMean;
    residualSquares += residualMean * residualMean;
  }

  const avgContrast = contrastSum / size;
  const contrastVariance = Math.max(0, contrastSquares / size - avgContrast * avgContrast);
  const avgTone = toneSum / size;
  const toneVariance = Math.max(0, toneSquares / size - avgTone * avgTone);
  const brightShare = brighter / size;
  const bboxArea = (component.maxX - component.minX + 1) * (component.maxY - component.minY + 1);
  const residualMean = residualSum / size;
  const residualVariance = Math.max(0, residualSquares / size - residualMean * residualMean);
  const residualDeviation = Math.sqrt(residualVariance);

  let interiorDeviation = Number.POSITIVE_INFINITY;
  if (interiorCount >= 4) {
    let worst = 0;
    for (let c = 0; c < 3; c += 1) {
      const mean = interiorSum[c] / interiorCount;
      const variance = Math.max(0, interiorSquares[c] / interiorCount - mean * mean);
      worst = Math.max(worst, Math.sqrt(variance));
    }
    interiorDeviation = worst;
  }

  return {
    strokeWidth: (2 * size) / Math.max(1, perimeter),
    avgChroma: chromaSum / size,
    polarity: Math.max(brightShare, 1 - brightShare),
    avgContrast,
    contrastDeviation: Math.sqrt(contrastVariance),
    crispness: boundaryDetailSum / Math.max(1, perimeter) / Math.max(1, avgContrast),
    toneDeviation: Math.sqrt(toneVariance),
    fill: size / Math.max(1, bboxArea),
    interiorDeviation,
    residualDeviation,
    flatness: Math.min(interiorDeviation, residualDeviation),
    avgTone,
    inkNeutrality:
      Math.max(
        Math.min(1, Math.max(0, (avgTone - 185) / 55)),
        Math.min(1, Math.max(0, (55 - avgTone) / 55)),
      ) * Math.min(1, Math.max(0, 1 - chromaSum / size / 40)),
  };
}

function countBinary(mask: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) count += 1;
  }
  return count;
}

function componentsNear(best: Component, others: Component[], width: number, height: number): Component[] {
  const bestZone = locateComponent(best.minX, best.minY, best.maxX, best.maxY, width, height);
  const padX = bestZone.strip
    ? Math.max(14, Math.min(48, width * 0.08))
    : Math.max(6, Math.min(18, width * 0.028));
  const padY = bestZone.strip
    ? Math.max(4, Math.min(12, height * 0.03))
    : Math.max(5, Math.min(14, height * 0.03));
  const cx = (best.minX + best.maxX) / 2;
  const cy = (best.minY + best.maxY) / 2;
  return others.filter((component) => {
    const ocx = (component.minX + component.maxX) / 2;
    const ocy = (component.minY + component.maxY) / 2;
    return Math.abs(ocx - cx) <= padX && Math.abs(ocy - cy) <= padY;
  });
}

function dilateRadius(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return new Uint8Array(mask);
  const out = new Uint8Array(mask);
  const r2 = radius * radius;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (dx * dx + dy * dy > r2) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          out[ny * width + nx] = 1;
        }
      }
    }
  }
  return out;
}

function upscaleBinary(
  mask: Uint8Array,
  srcW: number,
  srcH: number,
  destW: number,
  destH: number,
): Uint8Array {
  const out = new Uint8Array(destW * destH);
  for (let y = 0; y < destH; y += 1) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / destH));
    for (let x = 0; x < destW; x += 1) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / destW));
      out[y * destW + x] = mask[sy * srcW + sx];
    }
  }
  return out;
}

function binaryToMaskImage(mask: Uint8Array, width: number, height: number): ImageData {
  const image = new ImageData(width, height);
  for (let i = 0; i < mask.length; i += 1) {
    const p = i * 4;
    const value = mask[i] ? 255 : 0;
    image.data[p] = value;
    image.data[p + 1] = value;
    image.data[p + 2] = value;
    image.data[p + 3] = 255;
  }
  return image;
}

interface ScoredCandidate {
  component: Component;
  score: number;
  stats: ComponentStats;
  zone: Zone;
}

interface CandidateScan {
  width: number;
  height: number;
  total: number;
  scored: ScoredCandidate[];
  /** Every component that passed the hard gates, even below the confidence threshold. */
  eligible: ScoredCandidate[];
  /** Raw candidate pixels used for strip-band expansion of text-like marks. */
  candidate: Uint8Array;
  gray: Float32Array;
}

function scanCandidates(image: ImageData, threshold: number): CandidateScan {
  const scale = Math.min(1, ANALYSIS_MAX / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const analysis = downscale(image, width, height);
  const total = width * height;

  const gray = new Float32Array(total);
  const sat = new Float32Array(total);
  const chroma = new Float32Array(total);
  const channels: ChannelField = {
    r: new Float32Array(total),
    g: new Float32Array(total),
    b: new Float32Array(total),
  };
  for (let i = 0, p = 0; i < total; i += 1, p += 4) {
    const r = analysis.data[p];
    const g = analysis.data[p + 1];
    const b = analysis.data[p + 2];
    gray[i] = luminance(r, g, b);
    sat[i] = saturation(r, g, b);
    chroma[i] = Math.max(r, g, b) - Math.min(r, g, b);
    channels.r[i] = r;
    channels.g[i] = g;
    channels.b[i] = b;
  }

  const detail = boxBlur(gray, width, height, 2);
  const blur = boxBlur(gray, width, height, 6);
  const channelBlur: ChannelField = {
    r: boxBlur(channels.r, width, height, 6),
    g: boxBlur(channels.g, width, height, 6),
    b: boxBlur(channels.b, width, height, 6),
  };

  const candidate = new Uint8Array(total);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!inSearchZone(x, y, width, height)) continue;
      const i = y * width + x;
      const absDiff = Math.abs(gray[i] - blur[i]);
      // Overlays are painted on: they stand out from the local background and wash out its colour.
      const overlayLike = absDiff >= 16 && absDiff <= 150 && sat[i] <= 0.45 && chroma[i] <= 42;
      if (overlayLike) {
        candidate[i] = 1;
      }
    }
  }

  const components = connectedComponents(candidate, width, height);
  const eligible: ScoredCandidate[] = [];
  const scored: ScoredCandidate[] = [];

  for (const component of components) {
    const size = component.pixels.length;
    const frac = size / total;
    const bw = component.maxX - component.minX + 1;
    const bh = component.maxY - component.minY + 1;
    const zone = locateComponent(component.minX, component.minY, component.maxX, component.maxY, width, height);
    const minSize = zone.strip ? 8 : 12;
    if (size < minSize || frac > 0.02) continue;

    if ((bw * bh) / total > 0.06 || bh > height * 0.18 || bw > width * 0.45) continue;

    const stats = componentStats(
      component,
      gray,
      detail,
      blur,
      chroma,
      channels,
      channelBlur,
      width,
      height,
    );
    const aspect = bw / Math.max(1, bh);

    // Overlays are crisp, compact, near-neutral marks printed in one flat tone.
    if (stats.strokeWidth > 6) continue;
    if (stats.avgChroma > 24) continue;
    if (stats.polarity < 0.85) continue;
    if (stats.avgContrast < 18) continue;
    if (stats.crispness < 0.34) continue;
    if (stats.toneDeviation > 34) continue;
    if (stats.fill < 0.15) continue;
    // Classic watermarks are white or black ink — reject pastel photo detail.
    if (stats.inkNeutrality < 0.25 && stats.flatness > 18) continue;
    if (!zone.corner && !(zone.strip && aspect >= 2.2)) continue;
    // Stay close to the image border; mid-frame "corner margin" hits are usually sky/road texture.
    if (zone.cornerDistance > 0.18 && !(zone.strip && aspect >= 2.5)) continue;

    let score = 0.18;
    if (zone.corner) score += 0.14;
    if (zone.cornerDistance <= 0.06) score += 0.14;
    else if (zone.cornerDistance <= 0.1) score += 0.07;
    if (zone.strip && aspect >= 2.2) score += 0.1;
    if (stats.inkNeutrality >= 0.5) score += 0.18;
    else if (stats.inkNeutrality >= 0.28) score += 0.1;
    if (stats.avgChroma <= 10) score += 0.08;
    else if (stats.avgChroma <= 16) score += 0.04;
    if (stats.crispness >= 0.75) score += 0.1;
    else if (stats.crispness >= 0.55) score += 0.05;
    if (stats.flatness <= 10) score += 0.1;
    else if (stats.flatness <= 16) score += 0.05;
    if (stats.avgContrast >= 36) score += 0.08;
    else if (stats.avgContrast >= 26) score += 0.04;
    if (frac <= 0.004) score += 0.04;
    if (stats.fill >= 0.35) score += 0.04;
    score = Math.min(0.98, score);

    const entry = { component, score, stats, zone };
    eligible.push(entry);
    if (score >= threshold) scored.push(entry);
  }

  scored.sort((a, b) => b.score - a.score);
  eligible.sort((a, b) => b.score - a.score);
  return { width, height, total, scored, eligible, candidate, gray };
}

/** Diagnostics for the offline detector tests in `tools/`. */
export function debugOverlayCandidates(
  image: ImageData,
  threshold = AUTO_RESTORE_CONFIDENCE_THRESHOLD,
): Array<Record<string, number | boolean>> {
  const scan = scanCandidates(image, threshold);
  const scaleX = image.width / scan.width;
  const scaleY = image.height / scan.height;
  return scan.scored.map(({ component, score, stats, zone }) => ({
    score: Number(score.toFixed(3)),
    x: Math.round(component.minX * scaleX),
    y: Math.round(component.minY * scaleY),
    w: Math.round((component.maxX - component.minX + 1) * scaleX),
    h: Math.round((component.maxY - component.minY + 1) * scaleY),
    size: component.pixels.length,
    strokeWidth: Number(stats.strokeWidth.toFixed(2)),
    chroma: Number(stats.avgChroma.toFixed(1)),
    contrast: Number(stats.avgContrast.toFixed(1)),
    crispness: Number(stats.crispness.toFixed(2)),
    tone: Number(stats.avgTone.toFixed(0)),
    ink: Number(stats.inkNeutrality.toFixed(2)),
    flatness: Number(Math.min(999, stats.flatness).toFixed(1)),
    cornerDist: Number(zone.cornerDistance.toFixed(3)),
    corner: zone.corner,
    strip: zone.strip,
  }));
}

export function detectUnwantedOverlay(
  image: ImageData,
  threshold = AUTO_RESTORE_CONFIDENCE_THRESHOLD,
): OverlayDetectionResult {
  const { width, height, total, scored, eligible, candidate, gray } = scanCandidates(image, threshold);
  if (scored.length === 0) {
    return { detected: false, confidence: 0, mask: null, reason: "empty" };
  }

  const best = scored[0];
  // Busy textures produce many look-alike candidates; only act when one clearly stands out.
  if (scored.length > TEXTURE_CANDIDATE_LIMIT && best.score < 0.85) {
    return { detected: false, confidence: best.score, mask: null, reason: "low-confidence" };
  }

  const clusterPool =
    best.zone.strip || (best.component.maxX - best.component.minX + 1) / Math.max(1, best.component.maxY - best.component.minY + 1) >= 1.6
      ? eligible
      : scored;
  const cluster = componentsNear(
    best.component,
    clusterPool.map((item) => item.component),
    width,
    height,
  );

  const keep = new Uint8Array(total);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let keptPixels = 0;
  for (const component of cluster) {
    minX = Math.min(minX, component.minX);
    minY = Math.min(minY, component.minY);
    maxX = Math.max(maxX, component.maxX);
    maxY = Math.max(maxY, component.maxY);
    for (const i of component.pixels) {
      if (!keep[i]) {
        keep[i] = 1;
        keptPixels += 1;
      }
    }
  }

  // Text watermarks are a row of similar ink glyphs. Expand within a thin horizontal band.
  // Skip compact corner logos/sparkles — those already have a tight component mask.
  const bestBw = best.component.maxX - best.component.minX + 1;
  const bestBh = best.component.maxY - best.component.minY + 1;
  const bestAspect = bestBw / Math.max(1, bestBh);
  const textLike =
    best.zone.strip &&
    best.stats.inkNeutrality >= 0.28 &&
    (!best.zone.corner || bestAspect >= 2.0 || best.zone.cornerDistance > 0.12);
  if (textLike) {
    const beforePixels = keptPixels;
    const beforeMinX = minX;
    const beforeMinY = minY;
    const beforeMaxX = maxX;
    const beforeMaxY = maxY;
    const beforeKeep = new Uint8Array(keep);

    let toneSum = 0;
    for (const i of best.component.pixels) toneSum += gray[i];
    const targetTone = toneSum / Math.max(1, best.component.pixels.length);
    const bestBh = best.component.maxY - best.component.minY + 1;
    const bandPad = Math.max(1, Math.round(bestBh * 0.3));
    const bandMinY = Math.max(0, minY - bandPad);
    const bandMaxY = Math.min(height - 1, maxY + bandPad);
    const towardLeft = (best.component.minX + best.component.maxX) / 2 < width / 2;
    const bandMinX = towardLeft ? Math.max(0, Math.round(width * 0.01)) : Math.max(0, Math.round(minX - width * 0.04));
    const bandMaxX = towardLeft
      ? Math.min(width - 1, Math.round(maxX + width * 0.22))
      : Math.min(width - 1, Math.round(width * 0.99));
    for (let y = bandMinY; y <= bandMaxY; y += 1) {
      for (let x = bandMinX; x <= bandMaxX; x += 1) {
        const i = y * width + x;
        if (!candidate[i] || keep[i]) continue;
        if (Math.abs(gray[i] - targetTone) > 28) continue;
        keep[i] = 1;
        keptPixels += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }

    const expandedBh = maxY - minY + 1;
    const expandedBw = maxX - minX + 1;
    const tooTall = expandedBh > bestBh * 2.2;
    const tooWide = expandedBw > width * 0.42;
    const tooMany = keptPixels > beforePixels * 8 && keptPixels > beforePixels + 120;
    if (tooTall || tooWide || tooMany) {
      keep.set(beforeKeep);
      keptPixels = beforePixels;
      minX = beforeMinX;
      minY = beforeMinY;
      maxX = beforeMaxX;
      maxY = beforeMaxY;
    }
  }

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const bboxFrac = (bw * bh) / total;
  if (bw <= 0 || bh <= 0 || bboxFrac > 0.1) {
    return { detected: false, confidence: best.score, mask: null, reason: "too-large" };
  }
  // Keep the glyph outline; full-resolution dilate below covers anti-aliased edges.
  keptPixels = countBinary(keep);

  let confidence = best.score;
  let coverage = keptPixels / total;
  if (coverage > MAX_MASK_COVERAGE) {
    keep.fill(0);
    for (const i of best.component.pixels) keep[i] = 1;
    keptPixels = countBinary(keep);
    coverage = keptPixels / total;
  }

  if (coverage > MAX_MASK_COVERAGE) {
    return { detected: false, confidence, mask: null, reason: "too-large" };
  }
  if (keptPixels < 4) {
    return { detected: false, confidence, mask: null, reason: "empty" };
  }

  const upscaled = upscaleBinary(keep, width, height, image.width, image.height);
  let fullKeep = dilateRadius(upscaled, image.width, image.height, FULL_DILATE_RADIUS);
  let fullCoverage = countBinary(fullKeep) / Math.max(1, image.width * image.height);
  if (fullCoverage > MAX_MASK_COVERAGE) {
    fullKeep = upscaled;
    fullCoverage = countBinary(fullKeep) / Math.max(1, image.width * image.height);
  }
  if (fullCoverage > MAX_MASK_COVERAGE) {
    return { detected: false, confidence, mask: null, reason: "too-large" };
  }
  if (countBinary(fullKeep) < MIN_MASK_PIXELS) {
    return { detected: false, confidence, mask: null, reason: "empty" };
  }

  return {
    detected: true,
    confidence: Math.min(0.98, confidence),
    mask: binaryToMaskImage(fullKeep, image.width, image.height),
  };
}
