export function friendlyError(error: unknown, fallback = "Something went wrong. Please try again."): string {
  if (!error) return fallback;
  if (typeof error === "string") return error;

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes("cors") || lower.includes("blocked access")) {
    return "Chrome blocked access to this image. Please download/upload the image manually.";
  }
  if (lower.includes("unsupported") || lower.includes("format")) {
    return "That image format is not supported. Please use PNG, JPG, or WEBP.";
  }
  if (lower.includes("opencv")) {
    return "The restoration engine failed to load. Reload the editor and try again.";
  }
  if (lower.includes("memory") || lower.includes("allocation") || lower.includes("too large to process")) {
    return "This image is too large to process in the browser. Try a smaller image.";
  }
  if (lower.includes("too large") || lower.includes("unwanted watermark")) {
    return "Selected area is too large.\nPlease select only the unwanted watermark.";
  }
  if (lower.includes("download")) {
    return "Download failed. Please try again.";
  }
  if (lower.includes("load") || lower.includes("decode")) {
    return "The image could not be loaded. It may be invalid or corrupted.";
  }

  return message || fallback;
}
