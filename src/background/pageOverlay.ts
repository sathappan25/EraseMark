import { applyOverlayState, type OverlayState } from "../content/statusOverlay";
import { getReadableError } from "../utils/readableError";

export { getReadableError };

function log(...args: unknown[]): void {
  console.log("[EraseMark]", ...args);
}

function logError(...args: unknown[]): void {
  console.error("[EraseMark]", ...args);
}

const STAGE_PROGRESS: Record<string, number> = {
  START: 0,
  FETCH_IMAGE: 10,
  DECODE_IMAGE: 25,
  INITIALIZE_PROCESSOR: 40,
  DETECT_OVERLAY: 60,
  INPAINT: 75,
  CREATE_RESULT_BLOB: 90,
  RETURN_RESULT: 95,
  DOWNLOAD: 97,
};

function progressFor(stage?: string, message?: string): number {
  if (stage && stage in STAGE_PROGRESS) return STAGE_PROGRESS[stage];
  if (/download/i.test(message || "")) return 97;
  if (/prepar/i.test(message || "")) return 90;
  if (/clean/i.test(message || "")) return 75;
  if (/analy/i.test(message || "")) return 40;
  if (/fetch/i.test(message || "")) return 10;
  return 0;
}

export async function showPageOverlay(tabId: number, state: OverlayState): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: applyOverlayState,
      args: [state],
    });
    log("Loading overlay injected:", state.message);
  } catch (error) {
    logError("Could not inject page overlay:", error);
    throw new Error("Could not show status on this page. Try a regular website tab.");
  }
}

export async function showRestoreLoading(
  tabId: number,
  message = "Starting...",
  stage = "START",
): Promise<void> {
  await showPageOverlay(tabId, {
    mode: "loading",
    message,
    stage,
    progress: progressFor(stage, message),
  });
}

export async function updateRestoreOverlay(
  tabId: number,
  message: string,
  stage?: string,
): Promise<void> {
  await showPageOverlay(tabId, {
    mode: "loading",
    message,
    stage,
    progress: progressFor(stage, message),
  });
}

export async function showRestoreSuccess(tabId: number): Promise<void> {
  await showPageOverlay(tabId, {
    mode: "success",
    message: "Image cleaned",
    detail: "Download completed",
    progress: 100,
  });
}

export async function showRestoreError(tabId: number, detail: string, stage?: string): Promise<void> {
  const engineFailure = /opencv|processing engine|initialize/i.test(detail);
  await showPageOverlay(tabId, {
    mode: "error",
    message: "Image cleaning failed",
    detail: engineFailure ? "Image processing engine could not be initialized." : detail,
    stage,
    showManual: true,
  });
}

