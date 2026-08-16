const CORNER_FRACTION = 0.26;
/** Corners are examined near native resolution; only very large ones are reduced. */
const MAX_WORK_SIZE = 360;
/** Mark radii searched, in working pixels. Row-wise sums keep even the large ones cheap. */
const SCALES = [5, 7, 9, 11, 14, 18, 23, 29, 36, 46];
/** Minimum colour distance between the mark and its surroundings. */
const MIN_SCORE = 34;
/** Ink is expected to be near uniform; above this the interior is too varied to be a stamp. */
const MAX_INK_DEVIATION = 12;

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
  red: Float64Array;
  green: Float64Array;
  blue: Float64Array;
  gray: Float64Array;
  graySquares: Float64Array;
}

/** Mean colour of a measured region. */
interface Tone {
  r: number;
  g: number;
  b: number;
}

function toneDistance(a: Tone, b: Tone): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db) / Math.SQRT2;
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
  const red = new Float64Array(stride * height);
  const green = new Float64Array(stride * height);
  const blue = new Float64Array(stride * height);
  const gray = new Float64Array(stride * height);
  const graySquares = new Float64Array(stride * height);
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
      red[rowStart + x + 1] = red[rowStart + x] + r;
      green[rowStart + x + 1] = green[rowStart + x] + g;
      blue[rowStart + x + 1] = blue[rowStart + x] + b;
      gray[rowStart + x + 1] = gray[rowStart + x] + luma;
      graySquares[rowStart + x + 1] = graySquares[rowStart + x] + luma * luma;
    }
  }

  return {
    width,
    height,
    scaleX: region.width / width,
    scaleY: region.height / height,
    red,
    green,
    blue,
    gray,
    graySquares,
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
  /** Half width of the inner star, used to measure outline marks as a shell. */
  innerHalfWidths: Int32Array;
  innerRadius: number;
  starCount: number;
  innerCount: number;
  boxRadius: number;
  boxCount: number;
  ringCount: number;
  wedgeRadius: number;
  wedgeCount: number;
  quadrantCounts: number[];
  innerQuadrantCounts: number[];
}

function buildShape(radius: number): RadiusShape | null {
  const halfWidths = new Int32Array(radius * 2 + 1);
  let starCount = 0;
  for (let dy = -radius; dy <= radius; dy += 1) {
    const hw = Math.max(0, Math.round(starHalfWidth(dy, radius)));
    halfWidths[dy + radius] = hw;
    starCount += hw * 2 + 1;
  }

  const innerRadius = Math.floor(radius * 0.55);
  const innerHalfWidths = new Int32Array(radius * 2 + 1);
  let innerCount = 0;
  for (let dy = -radius; dy <= radius; dy += 1) {
    if (Math.abs(dy) > innerRadius || innerRadius < 2) continue;
    const hw = Math.min(
      halfWidths[dy + radius],
      Math.max(0, Math.round(starHalfWidth(dy, innerRadius))),
    );
    innerHalfWidths[dy + radius] = hw;
    innerCount += hw * 2 + 1;
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
  const innerQuadrantCounts = [0, 0, 0, 0];
  for (let dy = -radius; dy <= radius; dy += 1) {
    const hw = halfWidths[dy + radius];
    const vertical = dy >= 0 ? 2 : 0;
    quadrantCounts[vertical] += hw;
    quadrantCounts[vertical + 1] += hw + 1;
    const innerHw = innerHalfWidths[dy + radius];
    if (Math.abs(dy) <= innerRadius) {
      innerQuadrantCounts[vertical] += innerHw;
      innerQuadrantCounts[vertical + 1] += innerHw + 1;
    }
  }

  if (starCount < 8 || ringCount < 8 || wedgeCount < 4) return null;
  if (quadrantCounts.some((count) => count < 2)) return null;
  return {
    radius,
    halfWidths,
    innerHalfWidths,
    innerRadius,
    starCount,
    innerCount,
    boxRadius,
    boxCount,
    ringCount,
    wedgeRadius,
    wedgeCount,
    quadrantCounts,
    innerQuadrantCounts,
  };
}

interface Candidate {
  cx: number;
  cy: number;
  radius: number;
  score: number;
}

export interface SparkleMetrics {
  /** Mean luminance of the ink area, kept for diagnostics. */
  inside: number;
  outside: number;
  /** Colour distance between ink and surroundings. */
  score: number;
  /** How colourful the ink is (max channel minus min channel). */
  inkChroma: number;
  weakestQuadrant: number;
  /** How much the four arms differ from the mark's overall colour. */
  armSpread: number;
  wedgeLift: number;
  insideDeviation: number;
  ringDeviation: number;
  adjusted: number;
  /** True when the reading came from the outline of the star rather than its whole area. */
  outline: boolean;
}

interface RegionSums {
  red: number;
  green: number;
  blue: number;
  gray: number;
  graySquares: number;
  /** Per quadrant red, green and blue sums, four entries of three channels. */
  quadrants: Float64Array;
}

function newRegionSums(): RegionSums {
  return { red: 0, green: 0, blue: 0, gray: 0, graySquares: 0, quadrants: new Float64Array(12) };
}

function toneOf(sums: { red: number; green: number; blue: number }, count: number): Tone {
  return { r: sums.red / count, g: sums.green / count, b: sums.blue / count };
}

function quadrantTone(sums: RegionSums, quadrant: number, count: number): Tone {
  const base = quadrant * 3;
  return {
    r: sums.quadrants[base] / count,
    g: sums.quadrants[base + 1] / count,
    b: sums.quadrants[base + 2] / count,
  };
}

function measureAll(
  work: WorkImage,
  shape: RadiusShape,
  cx: number,
  cy: number,
): SparkleMetrics[] | null {
  const stride = work.width + 1;
  const radius = shape.radius;
  const box = shape.boxRadius;
  if (cx < box || cy < box || cx >= work.width - box || cy >= work.height - box) return null;

  const star = newRegionSums();
  const inner = newRegionSums();
  let wedgeStarRed = 0;
  let wedgeStarGreen = 0;
  let wedgeStarBlue = 0;

  const accumulate = (
    target: RegionSums,
    y: number,
    left: number,
    right: number,
    vertical: number,
  ): void => {
    const rowRed = rowSum(work.red, stride, y, left, right);
    const rowGreen = rowSum(work.green, stride, y, left, right);
    const rowBlue = rowSum(work.blue, stride, y, left, right);
    target.red += rowRed;
    target.green += rowGreen;
    target.blue += rowBlue;
    target.gray += rowSum(work.gray, stride, y, left, right);
    target.graySquares += rowSum(work.graySquares, stride, y, left, right);

    const leftRed = rowSum(work.red, stride, y, left, cx - 1);
    const leftGreen = rowSum(work.green, stride, y, left, cx - 1);
    const leftBlue = rowSum(work.blue, stride, y, left, cx - 1);
    const leftBase = vertical * 3;
    const rightBase = (vertical + 1) * 3;
    target.quadrants[leftBase] += leftRed;
    target.quadrants[leftBase + 1] += leftGreen;
    target.quadrants[leftBase + 2] += leftBlue;
    target.quadrants[rightBase] += rowRed - leftRed;
    target.quadrants[rightBase + 1] += rowGreen - leftGreen;
    target.quadrants[rightBase + 2] += rowBlue - leftBlue;
  };

  for (let dy = -radius; dy <= radius; dy += 1) {
    const y = cy + dy;
    const vertical = dy >= 0 ? 2 : 0;
    const hw = shape.halfWidths[dy + radius];
    accumulate(star, y, cx - hw, cx + hw, vertical);

    if (Math.abs(dy) <= shape.wedgeRadius) {
      const clipped = Math.min(hw, shape.wedgeRadius);
      wedgeStarRed += rowSum(work.red, stride, y, cx - clipped, cx + clipped);
      wedgeStarGreen += rowSum(work.green, stride, y, cx - clipped, cx + clipped);
      wedgeStarBlue += rowSum(work.blue, stride, y, cx - clipped, cx + clipped);
    }

    if (shape.innerCount > 0 && Math.abs(dy) <= shape.innerRadius) {
      const ihw = shape.innerHalfWidths[dy + radius];
      accumulate(inner, y, cx - ihw, cx + ihw, vertical);
    }
  }

  let boxRed = 0;
  let boxGreen = 0;
  let boxBlue = 0;
  let boxGray = 0;
  let boxSquares = 0;
  for (let dy = -box; dy <= box; dy += 1) {
    const y = cy + dy;
    boxRed += rowSum(work.red, stride, y, cx - box, cx + box);
    boxGreen += rowSum(work.green, stride, y, cx - box, cx + box);
    boxBlue += rowSum(work.blue, stride, y, cx - box, cx + box);
    boxGray += rowSum(work.gray, stride, y, cx - box, cx + box);
    boxSquares += rowSum(work.graySquares, stride, y, cx - box, cx + box);
  }

  let wedgeBoxRed = 0;
  let wedgeBoxGreen = 0;
  let wedgeBoxBlue = 0;
  for (let dy = -shape.wedgeRadius; dy <= shape.wedgeRadius; dy += 1) {
    const y = cy + dy;
    const from = cx - shape.wedgeRadius;
    const to = cx + shape.wedgeRadius;
    wedgeBoxRed += rowSum(work.red, stride, y, from, to);
    wedgeBoxGreen += rowSum(work.green, stride, y, from, to);
    wedgeBoxBlue += rowSum(work.blue, stride, y, from, to);
  }

  const ringTone = toneOf(
    { red: boxRed - star.red, green: boxGreen - star.green, blue: boxBlue - star.blue },
    shape.ringCount,
  );
  const outside = (boxGray - star.gray) / shape.ringCount;
  const ringDeviation = Math.sqrt(
    Math.max(0, (boxSquares - star.graySquares) / shape.ringCount - outside * outside),
  );
  const wedgeTone = toneOf(
    {
      red: wedgeBoxRed - wedgeStarRed,
      green: wedgeBoxGreen - wedgeStarGreen,
      blue: wedgeBoxBlue - wedgeStarBlue,
    },
    shape.wedgeCount,
  );

  const readings: SparkleMetrics[] = [];

  const build = (
    sums: RegionSums,
    count: number,
    quadrantCounts: number[],
    outline: boolean,
  ): void => {
    if (count < 8) return;
    const tone = toneOf(sums, count);
    const inside = sums.gray / count;
    const score = toneDistance(tone, ringTone);
    const inkChroma = Math.max(tone.r, tone.g, tone.b) - Math.min(tone.r, tone.g, tone.b);

    // Every arm must differ from the background, and all four must share the mark's own colour.
    let weakestQuadrant = Infinity;
    let armSpread = 0;
    for (let q = 0; q < 4; q += 1) {
      if (quadrantCounts[q] < 2) return;
      const armTone = quadrantTone(sums, q, quadrantCounts[q]);
      weakestQuadrant = Math.min(weakestQuadrant, toneDistance(armTone, ringTone));
      armSpread = Math.max(armSpread, toneDistance(armTone, tone));
    }

    const insideDeviation = Math.sqrt(Math.max(0, sums.graySquares / count - inside * inside));
    readings.push({
      inside,
      outside,
      score,
      inkChroma,
      weakestQuadrant,
      armSpread,
      wedgeLift: toneDistance(wedgeTone, ringTone),
      insideDeviation,
      ringDeviation,
      adjusted: score - insideDeviation * 0.45,
      outline,
    });
  };

  build(star, shape.starCount, shape.quadrantCounts, false);
  const solidPasses = readings.some((reading) => !reading.outline && passesSparkleGates(reading));
  if (!solidPasses && shape.innerCount >= 8) {
    // Outline marks: compare only the star's shell, since their middle shows the background.
    const shellQuadrants = new Float64Array(12);
    for (let i = 0; i < 12; i += 1) shellQuadrants[i] = star.quadrants[i] - inner.quadrants[i];
    const shell: RegionSums = {
      red: star.red - inner.red,
      green: star.green - inner.green,
      blue: star.blue - inner.blue,
      gray: star.gray - inner.gray,
      graySquares: star.graySquares - inner.graySquares,
      quadrants: shellQuadrants,
    };
    const shellCounts = shape.quadrantCounts.map((c, i) => c - shape.innerQuadrantCounts[i]);
    build(shell, shape.starCount - shape.innerCount, shellCounts, true);
  }

  return readings.length ? readings : null;
}

function measure(
  work: WorkImage,
  shape: RadiusShape,
  cx: number,
  cy: number,
): SparkleMetrics | null {
  const readings = measureAll(work, shape, cx, cy);
  if (!readings) return null;
  let best = readings[0];
  for (const reading of readings) {
    if (passesSparkleGates(reading) && !passesSparkleGates(best)) best = reading;
    else if (reading.adjusted > best.adjusted && passesSparkleGates(reading) === passesSparkleGates(best)) {
      best = reading;
    }
  }
  return best;
}

/**
 * Applies the acceptance gates. Scoring is colour based, so white, black and coloured marks are all
 * eligible; what must hold is the star structure and near uniform ink.
 */
export function passesSparkleGates(metrics: SparkleMetrics): boolean {
  if (metrics.score < MIN_SCORE) return false;
  // Soft or semi-transparent stamps blend with the background, so their interiors look less flat.
  // Strong colour separation still keeps natural texture out.
  const maxDeviation = metrics.score >= 100 ? 28 : MAX_INK_DEVIATION;
  if (metrics.insideDeviation > maxDeviation) return false;
  // Stamped marks are bright, dark or distinctly coloured. Mid-tone foliage fails this check.
  const brightInk = metrics.inside >= 185;
  const darkInk = metrics.inside <= 45;
  const colouredInk = metrics.inkChroma >= 45;
  if (!brightInk && !darkInk && !colouredInk) return false;
  // All four arms must stand out from the background, share one ink colour, and leave the concave
  // gaps between them looking like background. Foliage and flowers rarely satisfy all three.
  if (metrics.weakestQuadrant < metrics.score * 0.6) return false;
  if (metrics.armSpread > metrics.score * 0.5) return false;
  if (metrics.wedgeLift > metrics.score * 0.4) return false;
  if (metrics.adjusted < MIN_SCORE) return false;
  // Flat ink is the hallmark of a stamp; anything grainier has to beat the local texture swing by a
  // clear margin so natural highlights stay rejected.
  const flatInk = metrics.insideDeviation < 9;
  return metrics.adjusted >= metrics.ringDeviation * (flatInk ? 1.05 : 1.5);
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
    const centreWidth = centreHalfWidth * 2 + 1;
    // Coarse scan for large radii, then a local refine around any near miss so the exact centre is
    // never skipped.
    const step = radius >= 16 ? 2 : 1;
    for (let cy = box; cy < work.height - box; cy += step) {
      for (let cx = box; cx < work.width - box; cx += step) {
        // Cheap rejection: the mark's widest row must differ from the rows just outside the shape.
        // Variance is not used here because outline marks deliberately leave their centre empty.
        const left = cx - centreHalfWidth;
        const right = cx + centreHalfWidth;
        const centreTone: Tone = {
          r: rowSum(work.red, stride, cy, left, right) / centreWidth,
          g: rowSum(work.green, stride, cy, left, right) / centreWidth,
          b: rowSum(work.blue, stride, cy, left, right) / centreWidth,
        };
        let nearbyDistance = 0;
        for (const offset of [-box, box]) {
          const y = cy + offset;
          const nearby: Tone = {
            r: rowSum(work.red, stride, y, left, right) / centreWidth,
            g: rowSum(work.green, stride, y, left, right) / centreWidth,
            b: rowSum(work.blue, stride, y, left, right) / centreWidth,
          };
          nearbyDistance = Math.max(nearbyDistance, toneDistance(centreTone, nearby));
        }
        if (nearbyDistance < MIN_SCORE * 0.55) continue;

        const metrics = measure(work, shape, cx, cy);
        if (metrics && passesSparkleGates(metrics)) {
          if (!best || metrics.adjusted > best.score) {
            best = { cx, cy, radius, score: metrics.adjusted };
          }
        } else if (step > 1 && metrics && metrics.adjusted >= MIN_SCORE * 0.75) {
          // Coarse sample landed near a mark; check the neighbouring pixels for the exact centre.
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              if (dx === 0 && dy === 0) continue;
              const nx = cx + dx;
              const ny = cy + dy;
              if (nx < box || ny < box || nx >= work.width - box || ny >= work.height - box) continue;
              const refined = measure(work, shape, nx, ny);
              if (!refined || !passesSparkleGates(refined)) continue;
              if (!best || refined.adjusted > best.score) {
                best = { cx: nx, cy: ny, radius, score: refined.adjusted };
              }
            }
          }
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
    if (metrics.score < MIN_SCORE * 0.8) break;
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
