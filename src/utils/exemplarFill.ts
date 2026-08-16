import { nearestNeighborFill } from "./nearestNeighborFill";

const PATCH_RADIUS = 2;
const SEARCH_RADIUS = 22;
const MASK_ON = 16;
/** Pixels this close to the mark are skipped as sources: they often carry the mark's soft fringe. */
const SOURCE_MARGIN = 2;
/** Hard cap so a large or awkward mask can never stall the processing pipeline. */
const TIME_BUDGET_MS = 1200;

/**
 * Exemplar (patch-based) fill. Masked pixels are filled by copying the best matching intact patch
 * from nearby, so textures keep their structure instead of blurring into a smudge.
 *
 * Pixels are filled outside-in using a single distance-ordered pass, which keeps the work
 * proportional to the mask area rather than its square.
 */
export function exemplarFill(
  source: ImageData,
  maskGray: Uint8Array,
  patchRadius = PATCH_RADIUS,
  searchRadius = SEARCH_RADIUS,
): ImageData {
  const { width, height } = source;
  const data = new Uint8ClampedArray(source.data);
  const known = new Uint8Array(width * height);
  const distance = new Int32Array(width * height);
  distance.fill(-1);

  const queue: number[] = [];
  let masked = 0;
  for (let i = 0; i < known.length; i += 1) {
    if (maskGray[i] > MASK_ON) {
      masked += 1;
    } else {
      known[i] = 1;
      distance[i] = 0;
      queue.push(i);
    }
  }
  if (masked === 0) return new ImageData(data, width, height);
  if (queue.length === 0) return new ImageData(data, width, height);

  // Breadth-first sweep from the intact area gives an outside-in fill order.
  const order: number[] = [];
  for (let head = 0; head < queue.length; head += 1) {
    const i = queue[head];
    const x = i % width;
    const y = (i / width) | 0;
    const neighbors = [i - 1, i + 1, i - width, i + width];
    for (const n of neighbors) {
      if (n < 0 || n >= distance.length || distance[n] !== -1) continue;
      const nx = n % width;
      const ny = (n / width) | 0;
      if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
      distance[n] = distance[i] + 1;
      queue.push(n);
      order.push(n);
    }
  }

  // Only untouched pixels a little away from the mark may be copied, so the mark's own soft fringe
  // and already filled pixels cannot seed the result.
  const eligible = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!known[i]) continue;
      let nearMark = false;
      for (let dy = -SOURCE_MARGIN; dy <= SOURCE_MARGIN && !nearMark; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -SOURCE_MARGIN; dx <= SOURCE_MARGIN; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (!known[ny * width + nx]) {
            nearMark = true;
            break;
          }
        }
      }
      eligible[i] = nearMark ? 0 : 1;
    }
  }

  const patchCost = (
    targetX: number,
    targetY: number,
    sourceX: number,
    sourceY: number,
    limit: number,
  ): number => {
    let cost = 0;
    let overlap = 0;
    for (let dy = -patchRadius; dy <= patchRadius; dy += 1) {
      const ty = targetY + dy;
      const sy = sourceY + dy;
      if (ty < 0 || ty >= height || sy < 0 || sy >= height) return Number.POSITIVE_INFINITY;
      for (let dx = -patchRadius; dx <= patchRadius; dx += 1) {
        const tx = targetX + dx;
        const sx = sourceX + dx;
        if (tx < 0 || tx >= width || sx < 0 || sx >= width) return Number.POSITIVE_INFINITY;
        const si = sy * width + sx;
        if (!eligible[si]) return Number.POSITIVE_INFINITY;
        const ti = ty * width + tx;
        if (!known[ti]) continue;
        overlap += 1;
        const tp = ti * 4;
        const sp = si * 4;
        const dr = data[tp] - data[sp];
        const dg = data[tp + 1] - data[sp + 1];
        const db = data[tp + 2] - data[sp + 2];
        cost += dr * dr + dg * dg + db * db;
        if (cost >= limit) return cost;
      }
    }
    if (overlap < 3) return Number.POSITIVE_INFINITY;
    // Strong preference for close patches: colour must come from the immediate neighbourhood.
    const dx = sourceX - targetX;
    const dy = sourceY - targetY;
    return cost / overlap + (dx * dx + dy * dy) * 6;
  };

  const findSource = (targetX: number, targetY: number): { x: number; y: number } | null => {
    let bestX = -1;
    let bestY = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    const minY = Math.max(patchRadius, targetY - searchRadius);
    const maxY = Math.min(height - 1 - patchRadius, targetY + searchRadius);
    const minX = Math.max(patchRadius, targetX - searchRadius);
    const maxX = Math.min(width - 1 - patchRadius, targetX + searchRadius);

    for (let sy = minY; sy <= maxY; sy += 2) {
      for (let sx = minX; sx <= maxX; sx += 2) {
        const cost = patchCost(targetX, targetY, sx, sy, bestCost);
        if (cost < bestCost) {
          bestCost = cost;
          bestX = sx;
          bestY = sy;
        }
      }
    }
    if (bestX < 0) return null;

    for (let sy = Math.max(patchRadius, bestY - 1); sy <= Math.min(height - 1 - patchRadius, bestY + 1); sy += 1) {
      for (let sx = Math.max(patchRadius, bestX - 1); sx <= Math.min(width - 1 - patchRadius, bestX + 1); sx += 1) {
        const cost = patchCost(targetX, targetY, sx, sy, bestCost);
        if (cost < bestCost) {
          bestCost = cost;
          bestX = sx;
          bestY = sy;
        }
      }
    }
    return { x: bestX, y: bestY };
  };

  const startedAt = Date.now();
  let filled = 0;
  for (const target of order) {
    if (known[target]) continue;
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;

    const tx = target % width;
    const ty = (target / width) | 0;
    const match = findSource(tx, ty);
    if (!match) continue;

    for (let dy = -patchRadius; dy <= patchRadius; dy += 1) {
      const py = ty + dy;
      const sy = match.y + dy;
      if (py < 0 || py >= height) continue;
      for (let dx = -patchRadius; dx <= patchRadius; dx += 1) {
        const px = tx + dx;
        const sx = match.x + dx;
        if (px < 0 || px >= width) continue;
        const pi = py * width + px;
        if (known[pi]) continue;
        const sp = (sy * width + sx) * 4;
        const dp = pi * 4;
        data[dp] = data[sp];
        data[dp + 1] = data[sp + 1];
        data[dp + 2] = data[sp + 2];
        data[dp + 3] = 255;
        known[pi] = 1;
        filled += 1;
      }
    }
  }

  if (filled < masked) {
    // Anything left (time budget or no usable patch) is closed with the nearest intact pixel.
    const remaining = new Uint8Array(width * height);
    let hasRemaining = false;
    for (let i = 0; i < known.length; i += 1) {
      if (known[i]) continue;
      remaining[i] = 255;
      hasRemaining = true;
    }
    if (hasRemaining) {
      return nearestNeighborFill(new ImageData(data, width, height), remaining);
    }
  }

  return new ImageData(data, width, height);
}
