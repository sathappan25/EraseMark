const MASK_ON = 16;

/**
 * Fill each masked pixel from the nearest unmasked neighbour. For small watermark glyphs this
 * keeps surrounding texture (grass, fabric, sky grain) instead of averaging it into a smudge.
 */
export function nearestNeighborFill(source: ImageData, maskGray: Uint8Array): ImageData {
  const { width, height } = source;
  const data = new Uint8ClampedArray(source.data);
  const known = new Uint8Array(width * height);
  const targets: number[] = [];

  for (let i = 0; i < known.length; i += 1) {
    if (maskGray[i] > MASK_ON) targets.push(i);
    else known[i] = 1;
  }
  if (targets.length === 0) return new ImageData(data, width, height);

  // Multi-source distance transform: nearest known pixel for every target.
  const sourceOf = new Int32Array(width * height);
  sourceOf.fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < known.length; i += 1) {
    if (!known[i]) continue;
    sourceOf[i] = i;
    const x = i % width;
    const y = (i / width) | 0;
    const neighbors = [i - 1, i + 1, i - width, i + width];
    for (const n of neighbors) {
      if (n < 0 || n >= known.length || known[n]) continue;
      const nx = n % width;
      const ny = (n / width) | 0;
      if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
      if (sourceOf[n] === -1) {
        sourceOf[n] = i;
        queue.push(n);
      }
    }
  }

  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const x = i % width;
    const y = (i / width) | 0;
    const origin = sourceOf[i];
    const neighbors = [i - 1, i + 1, i - width, i + width];
    for (const n of neighbors) {
      if (n < 0 || n >= known.length || known[n] || sourceOf[n] !== -1) continue;
      const nx = n % width;
      const ny = (n / width) | 0;
      if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
      sourceOf[n] = origin;
      queue.push(n);
    }
  }

  for (const i of targets) {
    const origin = sourceOf[i];
    if (origin < 0) continue;
    const sp = origin * 4;
    const dp = i * 4;
    data[dp] = data[sp];
    data[dp + 1] = data[sp + 1];
    data[dp + 2] = data[sp + 2];
    data[dp + 3] = 255;
  }

  return new ImageData(data, width, height);
}
