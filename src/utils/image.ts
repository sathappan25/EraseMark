import { LARGE_IMAGE_PIXELS, SUPPORTED_EXTENSIONS, SUPPORTED_TYPES } from "../types";

export function isSupportedImage(file: Pick<File, "name" | "type">): boolean {
  const type = (file.type || "").toLowerCase();
  const name = file.name.toLowerCase();
  if (SUPPORTED_TYPES.includes(type)) return true;
  return SUPPORTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export async function blobToImageBitmap(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob);
  } catch (error) {
    console.error("[EraseMark ERROR] DECODE_IMAGE", error);
    throw new Error("Could not decode this image format.");
  }
}

export async function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The image could not be loaded. It may be invalid or corrupted."));
    image.src = src;
  });
}

export function imageSizeWarning(width: number, height: number): string | null {
  const pixels = width * height;
  if (pixels >= LARGE_IMAGE_PIXELS || width > 8192 || height > 8192) {
    return "This image is large and may require additional processing time.";
  }
  return null;
}

export async function createThumbnailDataUrl(
  source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  maxSize = 160,
): Promise<string> {
  const width = "width" in source ? source.width : 0;
  const height = "height" in source ? source.height : 0;
  if (!width || !height) return "";

  const scale = Math.min(1, maxSize / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create thumbnail.");
  ctx.drawImage(source as CanvasImageSource, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.72);
}

export async function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type = "image/png",
  quality?: number,
): Promise<Blob> {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type, quality });
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new Error("Could not encode the image."));
        else resolve(blob);
      },
      type,
      quality,
    );
  });
}

export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => requestAnimationFrame(finish));
    }
    setTimeout(finish, 0);
  });
}

export function extensionFromMime(mime: string): "png" | "jpg" | "webp" {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return "png";
}
