const CORNER_FRACTION = 0.26;
/** Corners are examined near native resolution; only very large ones are reduced. */
const MAX_WORK_SIZE = 720;
/** Mark radii searched, in working pixels. Row-wise sums keep even the large ones cheap. */
const SCALES = [4, 5, 6, 7, 9, 11, 13, 16, 19, 23, 28, 34, 40, 48];
const MIN_SCORE = 32;
const MIN_INK_LUMA = 200;
const MAX_INK_CHROMA = 34;

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WorkImage {
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  /** Row-wise prefix sums, one row of width + 1 entries per image row. */
  gray: Float64Array;
  graySquares: Float64Array;
  chroma: Float64Array;
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Half width of a four-point sparkle at a given row offset. The exponent gives the concave arms of
 * the star marks that AI image tools stamp into a corner.
 */
function starHalfWidth(dy: number, radius: number): number {
  const ny = Math.abs(dy) / radius;
  if (ny > 1) return -1;
  const remaining = 1 - Math.pow(ny, 0.55);
  if (remaining <= 0) return 0;
  return radius * Math.pow(remaining, 1 / 0.55);
}

function buildWorkImage(image: ImageData, region: Region): WorkImage {
  const scale = Math.min(1, MAX_WORK_SIZE / Math.max(region.width, region.height));
  const width = Math.max(8, Math.round(region.width * scale));
  const height = Math.max(8, Math.round(region.height * scale));
  const stride = width + 1;
  const gray = new Float64Array(stride * height);
  const graySquares = new Float64Array(stride * height);
  const chroma = new Float64Array(stride * height);
  const stepX = region.width / width;
  const stepY = region.height / height;

  for (let y = 0; y < height; y += 1) {
    const sy0 = region.y + Math.floor(y * stepY);
    const sy1 = Math.min(region.y + region.height, sy0 + Math.max(1, Math.floor(stepY)));
    const rowStart = y * stride;
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
      if (n) {
        r /= n;
        g /= n;
        b /= n;
      }
      const luma = luminance(r, g, b);
      gray[rowStart + x + 1] = gray[rowStart + x] + luma;
      graySquares[rowStart + x + 1] = graySquares[rowStart + x] + luma * luma;
      chroma[rowStart + x + 1] = chroma[rowStart + x] + (Math.max(r, g, b) - Math.min(r, g, b));
    }
  }

  return {
    width,
    height,
    scaleX: region.width / width,
    scaleY: region.height / height,
    gray,
    graySquares,
    chroma,
  };
}

function rowSum(prefix: Float64Array, stride: number, y: number, x0: number, x1: number): number {
  if (x1 < x0) return 0;
  const rowStart = y * stride;
  return prefix[rowStart + x1 + 1] - prefix[rowStart + x0];
}

interface RadiusShape {
  radius: number;
  /** Star half width per row offset, indexed by dy + radius. */
  halfWidths: Int32Array;
  starCount: number;
  boxRadius: number;
  boxCount: number;
  ringCount: number;
  wedgeRadius: number;
  wedgeCount: number;
  quadrantCounts: number[];
}

function buildShape(radius: number): RadiusShape | null {
  const halfWidths = new Int32Array(radius * 2 + 1);
  let starCount = 0;
  for (let dy = -radius; dy <= radius; dy += 1) {
    const hw = Math.max(0, Math.round(starHalfWidth(dy, radius)));
    halfWidths[dy + radius] = hw;
    starCount += hw * 2 + 1;
  }

  const boxRadius = radius + 2;
  const boxCount = (boxRadius * 2 + 1) * (boxRadius * 2 + 1);
  const ringCount = boxCount - starCount;

  const wedgeRadius = Math.floor(radius * 0.8);
  let wedgeStarCount = 0;
  for (let dy = -wedgeRadius; dy <= wedgeRadius; dy += 1) {
    const hw = Math.min(halfWidths[dy + radius], wedgeRadius);
    wedgeStarCount += hw * 2 + 1;
  }
  const wedgeCount = (wedgeRadius * 2 + 1) * (wedgeRadius * 2 + 1) - wedgeStarCount;

  const quadrantCounts = [0, 0, 0, 0];
  for (let dy = -radius; dy <= radius; dy += 1) {
    const hw = halfWidths[dy + radius];
    const vertical = dy >= 0 ? 2 : 0;
    quadrantCounts[vertical] += hw;
    quadrantCounts[vertical + 1] += hw + 1;
  }

  if (starCount < 8 || ringCount < 8 || wedgeCount < 4) return null;
  if (quadrantCounts.some((count) => count < 2)) return null;
  return {
    radius,
    halfWidths,
    starCount,
    boxRadius,
    boxCount,
    ringCount,
    wedgeRadius,
    wedgeCount,
    quadrantCounts,
  };
}

interface Candidate {
  cx: number;
  cy: number;
  radius: number;
  score: number;
}

export interface SparkleMetrics {
  inside: number;
  chroma: number;
  outside: number;
  score: number;
  weakestQuadrant: number;
  wedgeLift: number;
  insideDeviation: number;
  ringDeviation: number;
  adjusted: number;
}

function measure(
  work: WorkImage,
  shape: RadiusShape,
  cx: number,
  cy: number,
): SparkleMetrics | null {
  const stride = work.width + 1;
  const radius = shape.radius;
  const box = shape.boxRadius;
  if (cx < box || cy < box || cx >= work.width - box || cy >= work.height - box) return null;

  let starSum = 0;
  let starSquares = 0;
  let starChroma = 0;
  let wedgeStarSum = 0;
  const quadrantSums = [0, 0, 0, 0];

  for (let dy = -radius; dy <= radius; dy += 1) {
    const hw = shape.halfWidths[dy + radius];
    const y = cy + dy;
    const left = cx - hw;
    const right = cx + hw;
    const rowTotal = rowSum(work.gray, stride, y, left, right);
    starSum += rowTotal;
    starSquares += rowSum(work.graySquares, stride, y, left, right);
    starChroma += rowSum(work.chroma, stride, y, left, right);

    const vertical = dy >= 0 ? 2 : 0;
    const leftPart = rowSum(work.gray, stride, y, left, cx - 1);
    quadrantSums[vertical] += leftPart;
    quadrantSums[vertical + 1] += rowTotal - leftPart;

    if (Math.abs(dy) <= shape.wedgeRadius) {
      const clipped = Math.min(hw, shape.wedgeRadius);
      wedgeStarSum += rowSum(work.gray, stride, y, cx - clipped, cx + clipped);
    }
  }

  let boxSum = 0;
  let boxSquares = 0;
  for (let dy = -box; dy <= box; dy += 1) {
    boxSum += rowSum(work.gray, stride, cy + dy, cx - box, cx + box);
    boxSquares += rowSum(work.graySquares, stride, cy + dy, cx - box, cx + box);
  }

  let wedgeBoxSum = 0;
  for (let dy = -shape.wedgeRadius; dy <= shape.wedgeRadius; dy += 1) {
    wedgeBoxSum += rowSum(work.gray, stride, cy + dy, cx - shape.wedgeRadius, cx + shape.wedgeRadius);
  }

  const inside = starSum / shape.starCount;
  const outside = (boxSum - starSum) / shape.ringCount;
  const score = inside - outside;
  let weakestQuadrant = Infinity;
  for (let q = 0; q < 4; q += 1) {
    weakestQuadrant = Math.min(weakestQuadrant, quadrantSums[q] / shape.quadrantCounts[q] - outside);
  }
  const insideDeviation = Math.sqrt(Math.max(0, starSquares / shape.starCount - inside * inside));
  const ringDeviation = Math.sqrt(
    Math.max(0, (boxSquares - starSquares) / shape.ringCount - outside * outside),
  );

  return {
    inside,
    chroma: starChroma / shape.starCount,
    outside,
    score,
    weakestQuadrant,
    wedgeLift: (wedgeBoxSum - wedgeStarSum) / shape.wedgeCount - outside,
    insideDeviation,
    ringDeviation,
    adjusted: score - insideDeviation * 0.45,
  };
}

/**
 * Correlates a sparkle profile against a corner. A hit must light up all four arms, leave the
 * concave gaps between them at background level, and stand out well above the local texture swing,
 * which is what separates a stamped mark from a bright flower or highlight.
 */
/** Applies the acceptance gates to measured metrics. */
export function passesSparkleGates(metrics: SparkleMetrics): boolean {
  if (metrics.inside < MIN_INK_LUMA) return false;
  if (metrics.chroma > MAX_INK_CHROMA) return false;
  if (metrics.score < MIN_SCORE) return false;
  // All four arms must be lit, and the concave gaps between them must stay near the background.
  // Flowers and foliage highlights rarely satisfy both at once.
  if (metrics.weakestQuadrant < metrics.score * 0.65) return false;
  if (metrics.wedgeLift > metrics.score * 0.35) return false;
  if (metrics.adjusted < MIN_SCORE) return false;
  // Flat white ink is the hallmark of a stamped mark; anything grainier has to beat the local
  // texture swing by a clear margin so natural highlights stay rejected.
  const flatInk = metrics.insideDeviation < 8 && metrics.inside >= 230;
  return metrics.adjusted >= metrics.ringDeviation * (flatInk ? 0.85 : 1.35);
}

function bestSparkleInRegion(work: WorkImage): Candidate | null {
  let best: Candidate | null = null;

  for (const radius of SCALES) {
    const shape = buildShape(radius);
    if (!shape) continue;
    const box = shape.boxRadius;
    if (box * 2 + 1 >= Math.min(work.width, work.height)) continue;

    const stride = work.width + 1;
    const centreHalfWidth = shape.halfWidths[radius];
    for (let cy = box; cy < work.height - box; cy += 1) {
      for (let cx = box; cx < work.width - box; cx += 1) {
        // Cheap rejection: the mark's widest row runs through its centre, so if that row is not
        // bright there is no point measuring the whole shape.
        const centreRow =
          rowSum(work.gray, stride, cy, cx - centreHalfWidth, cx + centreHalfWidth) /
          (centreHalfWidth * 2 + 1);
        if (centreRow < MIN_INK_LUMA - 12) continue;

        const metrics = measure(work, shape, cx, cy);
        if (!metrics || !passesSparkleGates(metrics)) continue;
        if (!best || metrics.adjusted > best.score) {
          best = { cx, cy, radius, score: metrics.adjusted };
        }
      }
    }
  }

  return best ? growToMarkEdge(work, best) : null;
}

/**
 * The highest scoring radius often sits inside the mark rather than on its edge. Widening while the
 * ink stays bright makes sure the whole mark ends up in the mask.
 */
function growToMarkEdge(work: WorkImage, candidate: Candidate): Candidate {
  let grown = candidate;
  for (const radius of SCALES) {
    if (radius <= grown.radius) continue;
    const shape = buildShape(radius);
    if (!shape) continue;
    const metrics = measure(work, shape, candidate.cx, candidate.cy);
    if (!metrics) continue;
    if (metrics.inside < MIN_INK_LUMA - 20) break;
    if (metrics.score < MIN_SCORE) break;
    if (metrics.weakestQuadrant < metrics.score * 0.4) break;
    grown = { ...grown, radius };
  }
  return grown;
}

/** Reports the metrics at a known mark centre, so a missed mark can be traced to a single gate. */
export function debugSparkleAt(
  image: ImageData,
  pointX: number,
  pointY: number,
): Array<{ radius: number; metrics: SparkleMetrics; passes: boolean }> {
  const boxW = Math.max(48, Math.round(image.width * CORNER_FRACTION));
  const boxH = Math.max(48, Math.round(image.height * CORNER_FRACTION));
  const region: Region = {
    x: pointX > image.width / 2 ? image.width - boxW : 0,
    y: pointY > image.height / 2 ? image.height - boxH : 0,
    width: boxW,
    height: boxH,
  };
  const work = buildWorkImage(image, region);
  const cx = Math.round((pointX - region.x) / work.scaleX);
  const cy = Math.round((pointY - region.y) / work.scaleY);

  const out: Array<{ radius: number; metrics: SparkleMetrics; passes: boolean }> = [];
  for (const radius of SCALES) {
    const shape = buildShape(radius);
    if (!shape) continue;
    const metrics = measure(work, shape, cx, cy);
    if (!metrics) continue;
    out.push({ radius, metrics, passes: passesSparkleGates(metrics) });
  }
  return out;
}

/** Finds every location in the corner that currently passes the sparkle gates. */
export function debugSparkleHits(
  image: ImageData,
  corner: "br" | "bl" | "tr" | "tl" = "br",
): Array<{ x: number; y: number; radius: number; score: number }> {
  const boxW = Math.max(48, Math.round(image.width * CORNER_FRACTION));
  const boxH = Math.max(48, Math.round(image.height * CORNER_FRACTION));
  const region: Region = {
    x: corner === "br" || corner === "tr" ? image.width - boxW : 0,
    y: corner === "br" || corner === "bl" ? image.height - boxH : 0,
    width: boxW,
    height: boxH,
  };
  const work = buildWorkImage(image, region);
  const hits: Array<{ x: number; y: number; radius: number; score: number }> = [];
  for (const radius of SCALES) {
    const shape = buildShape(radius);
    if (!shape) continue;
    const box = shape.boxRadius;
    if (box * 2 + 1 >= Math.min(work.width, work.height)) continue;
    for (let cy = box; cy < work.height - box; cy += 1) {
      for (let cx = box; cx < work.width - box; cx += 1) {
        const metrics = measure(work, shape, cx, cy);
        if (!metrics || !passesSparkleGates(metrics)) continue;
        hits.push({
          x: Math.round(region.x + (cx + 0.5) * work.scaleX),
          y: Math.round(region.y + (cy + 0.5) * work.scaleY),
          radius,
          score: metrics.adjusted,
        });
      }
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, 20);
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
  const grownRadius = bestCandidate.radius + 2.4;
  const radiusX = grownRadius * bestWork.scaleX;
  const radiusY = grownRadius * bestWork.scaleY;

  const mask = new ImageData(image.width, image.height);
  for (let i = 0; i < image.width * image.height; i += 1) {
    mask.data[i * 4 + 3] = 255;
  }

  let covered = 0;
  const minX = Math.max(0, Math.floor(centerX - radiusX - 2));
  const maxX = Math.min(image.width - 1, Math.ceil(centerX + radiusX + 2));
  const minY = Math.max(0, Math.floor(centerY - radiusY - 2));
  const maxY = Math.min(image.height - 1, Math.ceil(centerY + radiusY + 2));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dy = ((y - centerY) / radiusY) * grownRadius;
      const dx = ((x - centerX) / radiusX) * grownRadius;
      if (Math.abs(dx) > starHalfWidth(dy, grownRadius)) continue;
      const p = (y * image.width + x) * 4;
      mask.data[p] = 255;
      mask.data[p + 1] = 255;
      mask.data[p + 2] = 255;
      covered += 1;
    }
  }

  if (covered < 16) return null;
  if (covered / (image.width * image.height) > 0.05) return null;
  // Stamped marks are small; anything spanning a large part of the frame is scenery, not a mark.
  const maxSpan = Math.max(72, Math.min(image.width, image.height) * 0.18);
  if (maxX - minX > maxSpan || maxY - minY > maxSpan) return null;

  const confidence = Math.min(0.97, 0.6 + Math.min(0.3, (bestCandidate.score - MIN_SCORE) / 120));
  return { mask, confidence };
}
