import { sendToOffscreen } from "./offscreenManager";
import { downloadInServiceWorker } from "./swDownload";
import { formatQuickRestoreFilename } from "../utils/filename";
import { RestoreStageError } from "../utils/timeout";
import { showRestoreLoading, showRestoreSuccess } from "./pageOverlay";

const activeRequests = new Map<string, Promise<void>>();
const CONTENT_SCRIPT = "content/imageSelector.js";

function log(...args: unknown[]): void {
  console.log("[EraseMark]", ...args);
}

function logError(stage: string, error: unknown): void {
  console.error("[EraseMark ERROR]", stage, error);
}

async function updateOverlay(
  tabId: number | undefined,
  message: string,
  stage?: string,
): Promise<void> {
  if (tabId == null) return;
  try {
    await showRestoreLoading(tabId, message, stage);
  } catch (error) {
    logError("OVERLAY", error);
  }
}

async function ensureContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_SCRIPT],
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "PING" });
      return;
    } catch (error) {
      console.error("[EraseMark] Waiting for content script:", error);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
}

async function captureFromTab(
  tabId: number,
  imageUrl: string,
): Promise<{ buffer: ArrayBuffer; mimeType: string } | null> {
  try {
    await ensureContentScript(tabId);
    const result = (await chrome.tabs.sendMessage(tabId, {
      type: "CAPTURE_URL",
      url: imageUrl,
    })) as { ok?: boolean; buffer?: ArrayBuffer; mime?: string } | undefined;
    if (!result?.ok || !result.buffer) return null;
    log("Captured image from active tab", result.buffer.byteLength, "bytes");
    return { buffer: result.buffer, mimeType: result.mime || "image/png" };
  } catch (error) {
    logError("FETCH_IMAGE", error);
    return null;
  }
}

async function restoreOnce(
  imageUrl: string,
  tabId?: number,
  buffer?: ArrayBuffer,
  mimeType?: string,
): Promise<void> {
  const result = await sendToOffscreen(imageUrl, {
    tabId,
    buffer,
    mimeType,
    timeoutMs: 45_000,
    onProgress: (message, stage) => {
      void updateOverlay(tabId, message, stage);
    },
  });
  if (!result.success) {
    throw new RestoreStageError(
      result.stage || "RETURN_RESULT",
      result.error || "Offscreen restore returned no image.",
    );
  }
  if (!result.dataUrl) {
    throw new RestoreStageError("DOWNLOAD", "Restored image did not arrive for download.");
  }
  log("Downloading processed image");
  void updateOverlay(tabId, "Downloading...", "DOWNLOAD");
  await downloadInServiceWorker(result.dataUrl, formatQuickRestoreFilename(), tabId);
  log("SUCCESS ✓");
}

async function runProcessImage(imageUrl: string, tabId?: number): Promise<void> {
  void updateOverlay(tabId, "Fetching image...", "FETCH_IMAGE");
  try {
    await restoreOnce(imageUrl, tabId);
  } catch (error) {
    const stage = error instanceof RestoreStageError ? error.stage : "FETCH_IMAGE";
    logError(stage, error);

    const message = error instanceof Error ? error.message : String(error);
    const accessFailure =
      stage === "FETCH_IMAGE" &&
      /could not access|cors|fetch|Failed to fetch|network|HTTP \d+/i.test(message);
    if (tabId != null && accessFailure) {
      void updateOverlay(tabId, "Fetching image...", "FETCH_IMAGE");
      const captured = await captureFromTab(tabId, imageUrl);
      if (captured) {
        log("Retrying restore with tab-captured image");
        await restoreOnce(imageUrl, tabId, captured.buffer, captured.mimeType);
        return;
      }
    }

    throw error instanceof RestoreStageError
      ? error
      : new RestoreStageError(stage, message);
  }
}

export async function processImage(imageUrl: string, tabId?: number): Promise<void> {
  if (!imageUrl) {
    throw new RestoreStageError("FETCH_IMAGE", "No image URL was found.");
  }

  if (activeRequests.has(imageUrl)) {
    throw new RestoreStageError("START", "This image is already being processed.");
  }

  const work = runProcessImage(imageUrl, tabId).finally(() => {
    activeRequests.delete(imageUrl);
  });
  activeRequests.set(imageUrl, work);
  await work;

  if (tabId != null) {
    try {
      await showRestoreSuccess(tabId);
    } catch (error) {
      logError("SUCCESS", error);
    }
  }
}

export const restoreAndDownload = processImage;
