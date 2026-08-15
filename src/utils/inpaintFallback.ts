function maskBounds(mask: Uint8Array, width: number, height: number): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] <= 16) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

function extractRegion(
  source: ImageData,
  maskGray: Uint8Array,
  pad: number,
): {
  region: ImageData;
  regionMask: Uint8Array;
  minX: number;
  minY: number;
} | null {
  const bounds = maskBounds(maskGray, source.width, source.height);
  if (!bounds) return null;
  const minX = Math.max(0, bounds.minX - pad);
  const minY = Math.max(0, bounds.minY - pad);
  const maxX = Math.min(source.width - 1, bounds.maxX + pad);
  const maxY = Math.min(source.height - 1, bounds.maxY + pad);
  const rw = maxX - minX + 1;
  const rh = maxY - minY + 1;
  const region = new ImageData(rw, rh);
  const regionMask = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y += 1) {
    for (let x = 0; x < rw; x += 1) {
      const si = (minY + y) * source.width + (minX + x);
      const di = y * rw + x;
      const sp = si * 4;
      const dp = di * 4;
      region.data[dp] = source.data[sp];
      region.data[dp + 1] = source.data[sp + 1];
      region.data[dp + 2] = source.data[sp + 2];
      region.data[dp + 3] = source.data[sp + 3];
      regionMask[di] = maskGray[si];
    }
  }
  return { region, regionMask, minX, minY };
}

function writeMaskedRegion(
  target: ImageData,
  region: ImageData,
  regionMask: Uint8Array,
  minX: number,
  minY: number,
): void {
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) {
      const mi = y * region.width + x;
      if (regionMask[mi] <= 16) continue;
      const si = mi * 4;
      const di = ((minY + y) * target.width + (minX + x)) * 4;
      target.data[di] = region.data[si];
      target.data[di + 1] = region.data[si + 1];
      target.data[di + 2] = region.data[si + 2];
      target.data[di + 3] = region.data[si + 3];
    }
  }
}

function distanceToKnown(mask: Uint8Array, width: number, height: number): Float32Array {
  const dist = new Float32Array(width * height);
  dist.fill(1e9);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!mask[i]) {
        dist[i] = 0;
        continue;
      }
      if (x > 0) dist[i] = Math.min(dist[i], dist[i - 1] + 1);
      if (y > 0) dist[i] = Math.min(dist[i], dist[i - width] + 1);
      if (x > 0 && y > 0) dist[i] = Math.min(dist[i], dist[i - width - 1] + 1.414);
      if (x + 1 < width && y > 0) dist[i] = Math.min(dist[i], dist[i - width + 1] + 1.414);
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      if (!mask[i]) continue;
      if (x + 1 < width) dist[i] = Math.min(dist[i], dist[i + 1] + 1);
      if (y + 1 < height) dist[i] = Math.min(dist[i], dist[i + width] + 1);
      if (x + 1 < width && y + 1 < height) dist[i] = Math.min(dist[i], dist[i + width + 1] + 1.414);
      if (x > 0 && y + 1 < height) dist[i] = Math.min(dist[i], dist[i + width - 1] + 1.414);
    }
  }

  return dist;
}

function inpaintTeleaJsCore(source: ImageData, maskGray: Uint8Array, radius: number): ImageData {
  const width = source.width;
  const height = source.height;
  const data = new Uint8ClampedArray(source.data);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i += 1) mask[i] = maskGray[i] > 16 ? 1 : 0;

  const dist = distanceToKnown(mask, width, height);
  const pixels: Array<{ index: number; distance: number }> = [];
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) pixels.push({ index: i, distance: dist[i] });
  }
  pixels.sort((a, b) => a.distance - b.distance);

  const r = Math.max(1, Math.round(radius));
  const r2 = r * r;

  for (const pixel of pixels) {
    const x = pixel.index % width;
    const y = (pixel.index / width) | 0;
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 0;
    let weightSum = 0;

    for (let dy = -r; dy <= r; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -r; dx <= r; dx += 1) {
        const d2 = dx * dx + dy * dy;
        if (d2 === 0 || d2 > r2) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const ni = ny * width + nx;
        if (mask[ni]) continue;
        const distTerm = 1 / (1 + Math.sqrt(d2));
        const level = 1 / (1 + Math.abs(dist[ni] - dist[pixel.index]));
        const weight = distTerm * level;
        const p = ni * 4;
        red += data[p] * weight;
        green += data[p + 1] * weight;
        blue += data[p + 2] * weight;
        alpha += data[p + 3] * weight;
        weightSum += weight;
      }
    }

    const p = pixel.index * 4;
    if (weightSum > 0) {
      data[p] = red / weightSum;
      data[p + 1] = green / weightSum;
      data[p + 2] = blue / weightSum;
      data[p + 3] = alpha / weightSum;
    }
    mask[pixel.index] = 0;
  }

  return new ImageData(data, width, height);
}

export function inpaintTeleaJs(source: ImageData, maskGray: Uint8Array, radius: number): ImageData {
  const extracted = extractRegion(source, maskGray, Math.max(2, Math.round(radius) + 2));
  if (!extracted) {
    return new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
  }
  const restoredRegion = inpaintTeleaJsCore(extracted.region, extracted.regionMask, radius);
  const output = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
  writeMaskedRegion(output, restoredRegion, extracted.regionMask, extracted.minX, extracted.minY);
  return output;
}

export function inpaintNsJs(source: ImageData, maskGray: Uint8Array, radius: number): ImageData {
  const extracted = extractRegion(source, maskGray, Math.max(2, Math.round(radius) + 2));
  if (!extracted) {
    return new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
  }

  const width = extracted.region.width;
  const height = extracted.region.height;
  const current = new Uint8ClampedArray(extracted.region.data);
  const next = new Uint8ClampedArray(extracted.region.data);
  const mask = new Uint8Array(width * height);
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = extracted.regionMask[i] > 16 ? 1 : 0;
    if (mask[i]) count += 1;
  }

  const iterations = Math.min(80, Math.max(16, Math.round(Math.sqrt(count) * Math.max(1, radius / 4))));
  for (let iter = 0; iter < iterations; iter += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        if (!mask[i]) continue;
        let red = 0;
        let green = 0;
        let blue = 0;
        let alpha = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const p = (ny * width + nx) * 4;
            red += current[p];
            green += current[p + 1];
            blue += current[p + 2];
            alpha += current[p + 3];
            n += 1;
          }
        }
        if (!n) continue;
        const p = i * 4;
        next[p] = red / n;
        next[p + 1] = green / n;
        next[p + 2] = blue / n;
        next[p + 3] = alpha / n;
      }
    }
    current.set(next);
  }

  const restoredRegion = new ImageData(current, width, height);
  const output = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
  writeMaskedRegion(output, restoredRegion, extracted.regionMask, extracted.minX, extracted.minY);
  return output;
}
