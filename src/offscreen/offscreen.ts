import { TEST_PROCESSING_PIPELINE } from "../config";
import { restoreConservatively } from "../utils/conservativeInpaint";
import { initializeOpenCV } from "./opencv";
import { createTestMask, detectOverlay } from "./automaticMask";
import { createCanvas, getContext2d } from "../utils/canvas";
import { canvasToBlob } from "../utils/image";
import { takeQuickRestoreBlob } from "../utils/storage";
import { RestoreStageError, withTimeout } from "../utils/timeout";
import { decodeImageBlob, fetchAndDecodeImage } from "./imageProcessor";
import { blobToDataUrl } from "./downloadManager";
import { MAX_AUTO_MASK_PERCENT, analyzeMask } from "../utils/maskStats";

const STAGE_TIMEOUTS = {
  FETCH_IMAGE: 10_000,
  DECODE_IMAGE: 10_000,
  INITIALIZE_PROCESSOR: 30_000,
  DETECT_OVERLAY: 10_000,
  INPAINT: 20_000,
  CREATE_RESULT_BLOB: 10_000,
  RETURN_RESULT: 10_000,
} as const;

const OVERALL_TIMEOUT_MS = 45_000;

type RestoreRequest = {
  type: "RESTORE_IMAGE";
  imageUrl: string;
  requestId: string;
  buffer?: ArrayBuffer;
  mimeType?: string;
};

type PingRequest = { type: "OFFSCREEN_PING" };

type ProgressSender = (stage: string, message: string) => void;

function log(...args: unknown[]): void {
  console.log("[EraseMark]", ...args);
}

function logError(stage: string, error: unknown): void {
  console.error("[EraseMark ERROR]", stage, error);
}

function overlayMessage(stage: string): string {
  switch (stage) {
    case "START":
      return "Starting...";
    case "FETCH_IMAGE":
      return "Fetching image...";
    case "DECODE_IMAGE":
    case "INITIALIZE_PROCESSOR":
    case "DETECT_OVERLAY":
      return "Analyzing image...";
    case "INPAINT":
      return "Cleaning image...";
    case "CREATE_RESULT_BLOB":
    case "RETURN_RESULT":
      return "Preparing download...";
    case "DOWNLOAD":
      return "Downloading...";
    default:
      return "Processing image...";
  }
}

async function loadSourceImage(
  imageUrl: string,
  buffer?: ArrayBuffer,
  mimeType?: string,
): Promise<{ blob: Blob; bitmap: ImageBitmap }> {
  try {
    if (buffer && buffer.byteLength > 0) {
      log("FETCH_IMAGE");
      log("Image URL:", imageUrl);
      log("HTTP status:", "buffer");
      const blob = new Blob([buffer], { type: mimeType || "image/png" });
      log("Image bytes:", blob.size);
      const bitmap = await decodeImageBlob(blob);
      log("FETCH_IMAGE ✓");
      return { blob, bitmap };
    }
    if (imageUrl.startsWith("idb:")) {
      log("FETCH_IMAGE", imageUrl);
      const stored = await takeQuickRestoreBlob(imageUrl.slice(4));
      if (!stored) throw new Error("Could not access this image.");
      log("Content-Type:", stored.type || "image/png");
      log("Image bytes:", stored.size);
      const bitmap = await decodeImageBlob(stored);
      log("FETCH_IMAGE ✓");
      return { blob: stored, bitmap };
    }
    return await fetchAndDecodeImage(imageUrl);
  } catch (error) {
    logError("FETCH_IMAGE", error);
    throw error instanceof RestoreStageError
      ? error
      : new RestoreStageError(
          "FETCH_IMAGE",
          error instanceof Error ? error.message : "Could not access this image.",
        );
  }
}

function bitmapToImageData(bitmap: ImageBitmap): { imageData: ImageData; canvas: OffscreenCanvas } {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not create a drawing surface.");
  ctx.drawImage(bitmap, 0, 0);
  return {
    imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
    canvas,
  };
}

async function restoreFromRequest(
  request: RestoreRequest,
  emit: ProgressSender,
): Promise<{ dataUrl: string; mimeType: string; width: number; height: number }> {
  const { imageUrl } = request;
  log("START");
  emit("START", overlayMessage("START"));

  const startedAt = Date.now();
  const checkOverall = (): void => {
    if (Date.now() - startedAt > OVERALL_TIMEOUT_MS) {
      throw new RestoreStageError("OVERALL", "EraseMark timed out. Try Manual Restore.");
    }
  };

  const opencvPromise = initializeOpenCV().catch((error) => {
    logError("INITIALIZE_PROCESSOR", error);
    return false;
  });

  emit("FETCH_IMAGE", overlayMessage("FETCH_IMAGE"));
  const loaded = await withTimeout(
    loadSourceImage(imageUrl, request.buffer, request.mimeType),
    STAGE_TIMEOUTS.FETCH_IMAGE + STAGE_TIMEOUTS.DECODE_IMAGE,
    "FETCH_IMAGE",
  );
  const { bitmap } = loaded;
  emit("DECODE_IMAGE", overlayMessage("DECODE_IMAGE"));
  const { imageData, canvas } = bitmapToImageData(bitmap);
  checkOverall();

  emit("INITIALIZE_PROCESSOR", overlayMessage("INITIALIZE_PROCESSOR"));
  // Small marks are filled locally, so never block the run waiting for OpenCV to boot.
  let opencvReady = false;
  try {
    opencvReady = await Promise.race([
      opencvPromise,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_500)),
    ]);
  } catch (error) {
    logError("INITIALIZE_PROCESSOR", error);
  }
  if (opencvReady) {
    log("INITIALIZE_OPENCV ✓");
  } else {
    log("Proceeding with the local inpaint engine");
  }
  checkOverall();

  emit("DETECT_OVERLAY", overlayMessage("DETECT_OVERLAY"));
  log("DETECT_OVERLAY");
  let mask: ImageData | null = null;
  if (TEST_PROCESSING_PIPELINE) {
    log("TEST_PROCESSING_PIPELINE enabled: using small test mask");
    mask = createTestMask(imageData.width, imageData.height);
    log("Overlay detection result:", { detected: true, confidence: 1, test: true });
  } else {
    const detection = await withTimeout(
      Promise.resolve().then(() => detectOverlay(imageData)),
      STAGE_TIMEOUTS.DETECT_OVERLAY,
      "DETECT_OVERLAY",
    );
    log("Overlay detection result:", {
      detected: detection.detected,
      confidence: detection.confidence,
      hasMask: Boolean(detection.mask),
    });
    if (!detection.detected || !detection.mask) {
      bitmap.close?.();
      if (detection.reason === "too-large") {
        throw new RestoreStageError(
          "DETECT_OVERLAY",
          "Selected area is too large.\nPlease select only the unwanted watermark.",
        );
      }
      throw new RestoreStageError(
        "DETECT_OVERLAY",
        "Watermark could not be confidently identified.",
      );
    }
    mask = detection.mask;
  }
  log("DETECT_OVERLAY ✓");
  checkOverall();

  const analysis = analyzeMask(mask);
  log("Starting restoration");
  log("Original dimensions:", `${imageData.width} x ${imageData.height}`);
  log("Mask dimensions:", `${mask.width} x ${mask.height}`);
  log("Mask pixels:", analysis.pixels);
  log("Mask percentage:", `${analysis.percentage.toFixed(2)}%`);
  log(
    "Mask bounding box:",
    analysis.bbox
      ? `x=${analysis.bbox.x} y=${analysis.bbox.y} w=${analysis.bbox.width} h=${analysis.bbox.height}`
      : "none",
  );
  if (analysis.pixels === 0) {
    bitmap.close?.();
    throw new RestoreStageError("DETECT_OVERLAY", "No watermark area selected.");
  }
  if (analysis.percentage > MAX_AUTO_MASK_PERCENT) {
    bitmap.close?.();
    throw new RestoreStageError(
      "DETECT_OVERLAY",
      "Selected area is too large.\nPlease select only the unwanted watermark.",
    );
  }

  emit("INPAINT", overlayMessage("INPAINT"));
  log("Running inpainting");
  const imageCanvas = createCanvas(canvas.width, canvas.height);
  const imageCtx = getContext2d(imageCanvas) as CanvasRenderingContext2D;
  imageCtx.putImageData(imageData, 0, 0);
  const maskCanvas = createCanvas(canvas.width, canvas.height);
  const maskCtx = getContext2d(maskCanvas) as CanvasRenderingContext2D;
  maskCtx.putImageData(mask, 0, 0);

  let restoredCanvas: HTMLCanvasElement;
  try {
    restoredCanvas = await withTimeout(
      Promise.resolve().then(() => {
        const result = restoreConservatively(imageCanvas, maskCanvas, 3, "TELEA");
        if (result.outsideChanged > 0) {
          log("WARNING: repaired outside-mask pixels", result.outsideChanged);
        }
        log("Changed pixels:", result.totalChanged);
        log("Inpainting completed");
        return result.canvas;
      }),
      STAGE_TIMEOUTS.INPAINT,
      "INPAINT",
    );
    log("INPAINT ✓");
  } catch (error) {
    bitmap.close?.();
    logError("INPAINT", error);
    throw error instanceof RestoreStageError
      ? error
      : new RestoreStageError("INPAINT", error instanceof Error ? error.message : "Inpainting failed.");
  }
  checkOverall();

  emit("CREATE_RESULT_BLOB", overlayMessage("CREATE_RESULT_BLOB"));
  log("Creating processed PNG");
  const restoredBlob = await withTimeout(
    canvasToBlob(restoredCanvas, "image/png"),
    STAGE_TIMEOUTS.CREATE_RESULT_BLOB,
    "CREATE_RESULT_BLOB",
  );
  if (!restoredBlob.size) {
    bitmap.close?.();
    throw new RestoreStageError("CREATE_RESULT_BLOB", "Result blob was empty.");
  }

  emit("RETURN_RESULT", overlayMessage("RETURN_RESULT"));
  log("RETURN_RESULT");
  emit("DOWNLOAD", overlayMessage("DOWNLOAD"));
  log("Download started:");
  const dataUrl = await withTimeout(blobToDataUrl(restoredBlob), STAGE_TIMEOUTS.RETURN_RESULT, "RETURN_RESULT");
  bitmap.close?.();
  log("CREATE_RESULT ✓");
  log("Output Blob size:", restoredBlob.size);
  return {
    dataUrl,
    mimeType: "image/png",
    width: restoredCanvas.width,
    height: restoredCanvas.height,
  };
}

type ResultSender = (payload: {
  type: "RESTORE_RESULT";
  requestId: string;
  success: boolean;
  dataUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  error?: string;
  stage?: string;
}) => void;

function handleRestore(request: RestoreRequest, emit: ProgressSender, sendResult: ResultSender): void {
  const { requestId } = request;
  let settled = false;
  const sendOnce: ResultSender = (payload) => {
    if (settled) return;
    settled = true;
    clearTimeout(overallTimer);
    sendResult(payload);
  };
  const overallTimer = setTimeout(() => {
    sendOnce({
      type: "RESTORE_RESULT",
      requestId,
      success: false,
      stage: "OVERALL",
      error: "Processing failed at: OVERALL. Try Manual Restore.",
    });
  }, OVERALL_TIMEOUT_MS);

  void (async () => {
    try {
      const result = await restoreFromRequest(request, emit);
      sendOnce({
        type: "RESTORE_RESULT",
        requestId,
        success: true,
        dataUrl: result.dataUrl,
        mimeType: result.mimeType,
        width: result.width,
        height: result.height,
      });
    } catch (error) {
      const stage = error instanceof RestoreStageError ? error.stage : "INPAINT";
      const text = error instanceof Error ? error.message : "Image processing failed.";
      logError(stage, error);
      sendOnce({
        type: "RESTORE_RESULT",
        requestId,
        success: false,
        stage,
        error: text,
      });
    }
  })();
}

void initializeOpenCV().catch((error) => {
  logError("INITIALIZE_PROCESSOR", error);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "image-restore") return;

  port.onMessage.addListener((message: RestoreRequest | PingRequest) => {
    if (message.type === "OFFSCREEN_PING") {
      port.postMessage({ type: "OFFSCREEN_PONG", ok: true });
      return;
    }
    if (message.type !== "RESTORE_IMAGE") return;

    log("Restore request received", message.requestId);
    handleRestore(
      message,
      (stage, overlay) => {
        try {
          port.postMessage({ type: "PROGRESS", requestId: message.requestId, stage, message: overlay });
        } catch (error) {
          logError("PROGRESS", error);
        }
        void chrome.runtime.sendMessage({
          type: "PROGRESS",
          requestId: message.requestId,
          stage,
          message: overlay,
        });
      },
      (payload) => {
        try {
          port.postMessage(payload);
        } catch (error) {
          logError("RETURN_RESULT", error);
          void chrome.runtime.sendMessage(payload);
        }
      },
    );
  });
});

chrome.runtime.onMessage.addListener((message: RestoreRequest | PingRequest, _sender, sendResponse) => {
  if (message.type === "OFFSCREEN_PING") {
    sendResponse({ ok: true });
    return false;
  }
  if (message.type !== "RESTORE_IMAGE") return false;

  log("Restore request received", message.requestId);
  handleRestore(
    message,
    (stage, overlay) => {
      void chrome.runtime.sendMessage({
        type: "PROGRESS",
        requestId: message.requestId,
        stage,
        message: overlay,
      });
    },
    (payload) => {
      try {
        sendResponse(payload);
      } catch (error) {
        logError("RETURN_RESULT", error);
        void chrome.runtime.sendMessage(payload);
      }
    },
  );
  return true;
});
