import { canvasToBlob } from "./image";
import type { OutputFormat } from "../types";
import { formatRestoreFilename } from "./filename";

export { formatQuickRestoreFilename, formatRestoreFilename } from "./filename";

export async function downloadRestoredImage(
  canvas: HTMLCanvasElement,
  format: OutputFormat,
  quality = 0.92,
): Promise<void> {
  const mime = format === "jpeg" ? "image/jpeg" : "image/png";
  const blob = await canvasToBlob(canvas, mime, format === "jpeg" ? quality : undefined);
  const url = URL.createObjectURL(blob);
  const filename = formatRestoreFilename(new Date(), format);

  try {
    if (chrome?.downloads?.download) {
      await chrome.downloads.download({
        url,
        filename,
        saveAs: true,
      });
    } else {
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
    }
  } catch {
    throw new Error("Download failed. Please try again.");
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
