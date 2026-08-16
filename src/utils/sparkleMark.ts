const CORNER_FRACTION = 0.26;
const WORK_SIZE = 160;
const SCALES = [5, 6, 7, 9, 11, 13, 16, 19, 23, 28];
const MIN_SCORE = 26;

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WorkImage {
  gray: Float32Array;
  chroma: Float32Array;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Four-point sparkle profile, matching the star marks AI image tools stamp in a corner. */
function starMembership(dx: number, dy: number, radius: number): boolean {
  const nx = Math.abs(dx) / radius;
  const ny = Math.abs(dy) / radius;
  if (nx > 1 || ny > 1) return false;
  return Math.pow(nx, 0.55) + Math.pow(ny, 0.55) <= 1;
}

function buildWorkImage(image: ImageData, region: Region): WorkImage {
  const scale = Math.min(1, WORK_SIZE / Math.max(region.width, region.height));
  const width = Math.max(8, Math.round(region.width * scale));
  const height = Math.max(8, Math.round(region.height * scale));
  const gray = new Float32Array(width * height);
  const chroma = new Float32Array(width * height);
  const stepX = region.width / width;
  const stepY = region.height / height;

  for (let y = 0; y < height; y += 1) {
    const sy0 = region.y + Math.floor(y * stepY);
    const sy1 = Math.min(region.y + region.height, sy0 + Math.max(1, Math.floor(stepY)));
    for (let x = 0; x < width; x += 1) {
      const sx0 = region.x + Math.floor(x * stepX);
      const sx1 = Math.min(region.x + region.width, sx0 + Math.max(1, Math.floor(stepX)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          const p = (sy * image.width + sx) * 4;
          r += image.data[p];
          g += image.data[p + 1];
          b += image.data[p + 2];
          n += 1;
        }
      }
      if (!n) continue;
      r /= n;
      g /= n;
      b /= n;
      const i = y * width + x;
      gray[i] = luminance(r, g, b);
      chroma[i] = Math.max(r, g, b) - Math.min(r, g, b);
    }
  }

  return { gray, chroma, width, height, scaleX: region.width / width, scaleY: region.height / height };
}

interface Candidate {
  cx: number;
  cy: number;
  radius: number;
  score: number;
  bright: boolean;
}

/**
 * Correlates a sparkle profile against a corner region. Scoring compares the mark interior with the
 * ring just outside it, so a stamped star is found even when the background is bright or busy.
 */
function bestSparkleInRegion(work: WorkImage): Candidate | null {
  let best: Candidate | null = null;

  for (const radius of SCALES) {
    if (radius * 2 + 3 >= Math.min(work.width, work.height)) continue;

    const offsets: number[] = [];
    const ring: number[] = [];
    const wedge: number[] = [];
    const quadrants: number[][] = [[], [], [], []];
    for (let dy = -radius - 2; dy <= radius + 2; dy += 1) {
      for (let dx = -radius - 2; dx <= radius + 2; dx += 1) {
        const offset = dy * work.width + dx;
        if (starMembership(dx, dy, radius)) {
          offsets.push(offset);
          const q = (dx >= 0 ? 1 : 0) + (dy >= 0 ? 2 : 0);
          quadrants[q].push(offset);
          continue;
        }
        if (Math.abs(dx) > radius + 2 || Math.abs(dy) > radius + 2) continue;
        ring.push(offset);
        // Diagonal gaps between the arms: on a real star these stay close to the background.
        if (Math.abs(dx) <= radius * 0.8 && Math.abs(dy) <= radius * 0.8) wedge.push(offset);
      }
    }
    if (offsets.length < 8 || ring.length < 8 || wedge.length < 4) continue;
    if (quadrants.some((q) => q.length < 2)) continue;

    const step = radius >= 13 ? 2 : 1;
    for (let cy = radius + 2; cy < work.height - radius - 2; cy += step) {
      for (let cx = radius + 2; cx < work.width - radius - 2; cx += step) {
        const center = cy * work.width + cx;

        let inside = 0;
        let insideChroma = 0;
        for (const offset of offsets) {
          inside += work.gray[center + offset];
          insideChroma += work.chroma[center + offset];
        }
        inside /= offsets.length;
        insideChroma /= offsets.length;
        if (insideChroma > 34) continue;

        let outside = 0;
        for (const offset of ring) outside += work.gray[center + offset];
        outside /= ring.length;
        let ringVariance = 0;
        for (const offset of ring) {
          const d = work.gray[center + offset] - outside;
          ringVariance += d * d;
        }
        const ringDeviation = Math.sqrt(ringVariance / ring.length);

        const contrast = inside - outside;
        // Only bright ink: stamped corner marks are white or light, while dark matches in real photos
        // are almost always shadows or foliage.
        if (inside < 185) continue;
        const bright = true;
        const score = contrast;
        if (score < MIN_SCORE) continue;

        // A stamped star lights up all four arms, so no quadrant may fall back to background level.
        let weakestQuadrant = Infinity;
        for (const quadrant of quadrants) {
          let mean = 0;
          for (const offset of quadrant) mean += work.gray[center + offset];
          mean /= quadrant.length;
          const strength = bright ? mean - outside : outside - mean;
          weakestQuadrant = Math.min(weakestQuadrant, strength);
        }
        if (weakestQuadrant < score * 0.5) continue;

        // The concave gaps between arms must stay near the background, which rules out round blobs.
        let wedgeMean = 0;
        for (const offset of wedge) wedgeMean += work.gray[center + offset];
        wedgeMean /= wedge.length;
        const wedgeStrength = bright ? wedgeMean - outside : outside - wedgeMean;
        if (wedgeStrength > score * 0.55) continue;

        // Reward flat ink: the interior of a stamped mark barely varies.
        let variance = 0;
        for (const offset of offsets) {
          const d = work.gray[center + offset] - inside;
          variance += d * d;
        }
        const deviation = Math.sqrt(variance / offsets.length);
        const adjusted = score - deviation * 0.45;
        if (adjusted < MIN_SCORE) continue;
        // In busy surroundings a mark must stand out well above the local texture swing, otherwise
        // bright flowers or highlights would qualify.
        if (adjusted < ringDeviation * 1.4) continue;

        if (!best || adjusted > best.score) {
          best = { cx, cy, radius, score: adjusted, bright };
        }
      }
    }
  }

  return best;
}

export interface SparkleMatch {
  mask: ImageData;
  confidence: number;
}

/** Looks for a stamped sparkle mark in each corner and returns a tight mask for the best hit. */
export function findSparkleMark(image: ImageData): SparkleMatch | null {
  const boxW = Math.max(48, Math.round(image.width * CORNER_FRACTION));
  const boxH = Math.max(48, Math.round(image.height * CORNER_FRACTION));
  const regions: Region[] = [
    { x: image.width - boxW, y: image.height - boxH, width: boxW, height: boxH },
    { x: 0, y: image.height - boxH, width: boxW, height: boxH },
    { x: image.width - boxW, y: 0, width: boxW, height: boxH },
    { x: 0, y: 0, width: boxW, height: boxH },
  ];

  let bestRegion: Region | null = null;
  let bestWork: WorkImage | null = null;
  let bestCandidate: Candidate | null = null;

  for (const region of regions) {
    if (region.width < 24 || region.height < 24) continue;
    const work = buildWorkImage(image, region);
    const candidate = bestSparkleInRegion(work);
    if (!candidate) continue;
    if (!bestCandidate || candidate.score > bestCandidate.score) {
      bestCandidate = candidate;
      bestWork = work;
      bestRegion = region;
    }
  }

  if (!bestCandidate || !bestWork || !bestRegion) return null;

  const centerX = bestRegion.x + (bestCandidate.cx + 0.5) * bestWork.scaleX;
  const centerY = bestRegion.y + (bestCandidate.cy + 0.5) * bestWork.scaleY;
  // Soft marks fade out past their core, so the mask is grown a little to swallow the fringe.
  const radiusX = (bestCandidate.radius + 2.4) * bestWork.scaleX;
  const radiusY = (bestCandidate.radius + 2.4) * bestWork.scaleY;

  const mask = new ImageData(image.width, image.height);
  let covered = 0;
  const minX = Math.max(0, Math.floor(centerX - radiusX - 2));
  const maxX = Math.min(image.width - 1, Math.ceil(centerX + radiusX + 2));
  const minY = Math.max(0, Math.floor(centerY - radiusY - 2));
  const maxY = Math.min(image.height - 1, Math.ceil(centerY + radiusY + 2));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = ((x - centerX) / radiusX) * bestCandidate.radius;
      const dy = ((y - centerY) / radiusY) * bestCandidate.radius;
      if (!starMembership(dx, dy, bestCandidate.radius + 1.6)) continue;
      const p = (y * image.width + x) * 4;
      mask.data[p] = 255;
      mask.data[p + 1] = 255;
      mask.data[p + 2] = 255;
      mask.data[p + 3] = 255;
      covered += 1;
    }
  }

  for (let i = 0; i < image.width * image.height; i += 1) {
    mask.data[i * 4 + 3] = 255;
  }

  if (covered < 16) return null;
  const coverage = covered / (image.width * image.height);
  if (coverage > 0.05) return null;
  // Stamped marks are small; anything spanning a large part of the frame is scenery, not a mark.
  const maxSpan = Math.max(24, Math.min(image.width, image.height) * 0.1);
  if (maxX - minX > maxSpan || maxY - minY > maxSpan) return null;

  const confidence = Math.min(0.97, 0.6 + Math.min(0.3, (bestCandidate.score - MIN_SCORE) / 120));
  return { mask, confidence };
}
