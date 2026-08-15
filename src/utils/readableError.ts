import { RestoreStageError } from "./timeout";

export function getReadableError(error: unknown): string {
  if (error instanceof RestoreStageError) {
    if (/timeout|too long|OVERALL|timed out/i.test(error.message) || error.stage === "OVERALL") {
      return "EraseMark timed out.\nTry Manual Restore.";
    }
    if (/opencv|processing engine|initialize/i.test(error.message) || error.stage === "INITIALIZE_PROCESSOR") {
      return "Image processing engine could not be initialized.";
    }
    return error.message;
  }

  const message = error instanceof Error ? error.message : String(error || "Image processing failed.");
  if (/timeout|too long|OVERALL|timed out/i.test(message)) {
    return "EraseMark timed out.\nTry Manual Restore.";
  }
  if (/opencv|processing engine|initialize/i.test(message)) {
    return "Image processing engine could not be initialized.";
  }
  if (/too large|unwanted watermark/i.test(message)) {
    return "Selected area is too large.\nPlease select only the unwanted watermark.";
  }
  if (/confident|could not be confidently/i.test(message)) {
    return "Watermark could not be confidently identified.\nYou can use Manual Restore to select the area yourself.";
  }
  if (/watermark area selected|editable area/i.test(message)) {
    return "No watermark area selected.\nYou can use Manual Restore to select the area yourself.";
  }
  if (/not precise enough/i.test(message)) {
    return "Automatic cleanup was not precise enough.\nUse Manual Restore to select the exact area.";
  }
  if (/cannot be accessed|could not access|cors|fetch|blocked|Failed to fetch|network/i.test(message)) {
    return "Could not access this image because the website blocked image access.\nTry downloading the image first and using Manual Restore.";
  }
  if (/decode/i.test(message)) {
    return "Could not decode this image format.";
  }
  return message;
}
