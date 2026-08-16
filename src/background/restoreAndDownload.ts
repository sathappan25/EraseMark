import { sendToOffscreen } from "./offscreenManager";
import { downloadInServiceWorker } from "./swDownload";
import { formatQuickRestoreFilename } from "../utils/filename";
import { RestoreStageError } from "../utils/timeout";
import { showRestoreLoading, showRestoreSuccess } from "./pageOverlay";
import { saveImageBlob, setPendingEditorState } from "../utils/storage";

const activeRequests = new Map<string, Promise<void>>();
const CONTENT_SCRIPT = "content/imageSelector.js";

function log(...args: unknown[]): void {
  console.log("[EraseMark]", ...args);
}

function logError(stage: string, error: unknown): void {
  console.error("[EraseMark ERROR]", stage, error);
}

function needsManualRestore(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /could not be confidently identified|too large|No watermark area selected|not precise enough/i.test(
    message,
  );
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

async function openManualRestore(
  imageUrl: string,
  tabId: number | undefined,
  buffer?: ArrayBuffer,
  mimeType?: string,
): Promise<void> {
  let bytes = buffer;
  let mime = mimeType || "image/png";
  if (!bytes && tabId != null) {
    const captured = await captureFromTab(tabId, imageUrl);
    if (captured) {
      bytes = captured.buffer;
      mime = captured.mimeType;
    }
  }
  if (!bytes) {
    try {
      const response = await fetch(imageUrl);
      if (response.ok) {
        bytes = await response.arrayBuffer();
        mime = response.headers.get("content-type") || mime;
      }
    } catch (error) {
      logError("MANUAL_FETCH", error);
    }
  }
  if (!bytes) {
    throw new RestoreStageError(
      "DETECT_OVERLAY",
      "Watermark could not be confidently identified.\nOpen Manual Restore and select the area yourself.",
    );
  }

  const blob = new Blob([bytes], { type: mime });
  const record = await saveImageBlob(blob, {
    name: "erasemark-source",
    source: "context-menu",
    type: mime,
  });
  await setPendingEditorState({ imageId: record.id });
  const editorUrl = chrome.runtime.getURL(`editor.html?image=${encodeURIComponent(record.id)}`);
  await chrome.tabs.create({ url: editorUrl });
  log("Opened Manual Restore with captured image", record.id);
}

async function runProcessImage(
  imageUrl: string,
  tabId?: number,
): Promise<"done" | "manual"> {
  void updateOverlay(tabId, "Fetching image...", "FETCH_IMAGE");
  try {
    await restoreOnce(imageUrl, tabId);
    return "done";
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
        try {
          await restoreOnce(imageUrl, tabId, captured.buffer, captured.mimeType);
          return "done";
        } catch (retryError) {
          if (needsManualRestore(retryError)) {
            void updateOverlay(tabId, "Opening Manual Restore...", "DETECT_OVERLAY");
            await openManualRestore(imageUrl, tabId, captured.buffer, captured.mimeType);
            return "manual";
          }
          throw retryError instanceof RestoreStageError
            ? retryError
            : new RestoreStageError(stage, message);
        }
      }
    }

    if (needsManualRestore(error)) {
      void updateOverlay(tabId, "Opening Manual Restore...", "DETECT_OVERLAY");
      await openManualRestore(imageUrl, tabId);
      return "manual";
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

  let openedManual = false;
  const work = runProcessImage(imageUrl, tabId)
    .then((result) => {
      openedManual = result === "manual";
    })
    .finally(() => {
      activeRequests.delete(imageUrl);
    });
  activeRequests.set(imageUrl, work);
  await work;

  if (openedManual || tabId == null) return;
  try {
    await showRestoreSuccess(tabId);
  } catch (error) {
    logError("SUCCESS", error);
  }
}

export const restoreAndDownload = processImage;
