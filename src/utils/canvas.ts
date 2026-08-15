export function getContext2d(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options?: CanvasRenderingContext2DSettings,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", options ?? { willReadFrequently: true });
  if (!ctx) throw new Error("Could not create a drawing surface.");
  return ctx;
}

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function createOffscreen(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  return createCanvas(width, height);
}

export function clearCanvas(canvas: HTMLCanvasElement, fill?: string): void {
  const ctx = getContext2d(canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

export function pointerToCanvasPoint(
  event: Pick<PointerEvent, "clientX" | "clientY">,
  canvas: HTMLCanvasElement,
): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function drawImageCover(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
}

export function copyCanvas(source: HTMLCanvasElement, target: HTMLCanvasElement): void {
  target.width = source.width;
  target.height = source.height;
  const ctx = getContext2d(target);
  ctx.drawImage(source, 0, 0);
}

export function maskHasSelection(canvas: HTMLCanvasElement, threshold = 16): boolean {
  const ctx = getContext2d(canvas) as CanvasRenderingContext2D;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < data.length; i += 16) {
    if (data[i] > threshold) return true;
  }
  return false;
}

export function snapshotMaskChannel(canvas: HTMLCanvasElement): Uint8Array {
  const ctx = getContext2d(canvas) as CanvasRenderingContext2D;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const out = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = data[p];
  }
  return out;
}

export function restoreMaskChannel(canvas: HTMLCanvasElement, snapshot: Uint8Array): void {
  const ctx = getContext2d(canvas) as CanvasRenderingContext2D;
  const imageData = ctx.createImageData(canvas.width, canvas.height);
  for (let i = 0, p = 0; i < snapshot.length; i++, p += 4) {
    const value = snapshot[i];
    imageData.data[p] = value;
    imageData.data[p + 1] = value;
    imageData.data[p + 2] = value;
    imageData.data[p + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
}

export function paintOverlayFromMask(
  maskCanvas: HTMLCanvasElement,
  overlayCanvas: HTMLCanvasElement,
): void {
  const maskCtx = getContext2d(maskCanvas) as CanvasRenderingContext2D;
  const overlayCtx = getContext2d(overlayCanvas) as CanvasRenderingContext2D;
  const src = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  const dst = overlayCtx.createImageData(overlayCanvas.width, overlayCanvas.height);
  for (let i = 0; i < src.data.length; i += 4) {
    if (src.data[i] > 16) {
      dst.data[i] = 225;
      dst.data[i + 1] = 29;
      dst.data[i + 2] = 72;
      dst.data[i + 3] = 118;
    }
  }
  overlayCtx.putImageData(dst, 0, 0);
}
