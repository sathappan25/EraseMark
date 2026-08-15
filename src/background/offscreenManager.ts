import { RestoreStageError } from "../utils/timeout";

const OFFSCREEN_URL = "offscreen/offscreen.html";
const PING_TIMEOUT_MS = 12_000;
const IDLE_CLOSE_MS = 60_000;
const OVERALL_TIMEOUT_MS = 45_000;

export interface RestoreResult {
  requestId: string;
  success: boolean;
  buffer?: ArrayBuffer;
  storeId?: string;
  dataUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  error?: string;
  stage?: string;
}

type PendingHandler = {
  tabId?: number;
  resolve: (value: RestoreResult) => void;
  reject: (error: Error) => void;
  onProgress?: (message: string, stage?: string) => void;
};

const pending = new Map<string, PendingHandler>();
const handledResults = new Set<string>();
let creating: Promise<void> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function log(...args: unknown[]): void {
  console.log("[EraseMark]", ...args);
}

function logError(...args: unknown[]): void {
  console.error("[EraseMark ERROR]", ...args);
}

async function hasOffscreenDocument(): Promise<boolean> {
  if (chrome.offscreen.hasDocument) {
    return chrome.offscreen.hasDocument();
  }
  const contexts = await chrome.runtime.getContexts?.({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  return Boolean(contexts?.length);
}

async function waitForOffscreenReady(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < PING_TIMEOUT_MS) {
    try {
      const ping = await chrome.runtime.sendMessage({ type: "OFFSCREEN_PING" });
      if (ping?.ok) {
        log("Offscreen document ready");
        return;
      }
    } catch (error) {
      console.error("[EraseMark] Offscreen ping waiting:", error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Offscreen document failed to start.");
}

export async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) {
    try {
      const ping = await chrome.runtime.sendMessage({ type: "OFFSCREEN_PING" });
      if (ping?.ok) {
        log("Offscreen document ready");
        return;
      }
    } catch (error) {
      log("Existing offscreen document did not respond; recreating", error);
    }
  }

  if (creating) {
    await creating;
    return;
  }

  creating = (async () => {
    if (await hasOffscreenDocument()) {
      try {
        await chrome.offscreen.closeDocument();
      } catch (error) {
        console.error("[EraseMark] Offscreen close race:", error);
      }
    }
    log("Creating offscreen document");
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: "Process images locally and generate restored image downloads.",
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!/already exists|duplicate/i.test(text)) {
        throw error instanceof Error ? error : new Error(text);
      }
      log("Offscreen document already exists");
    }
    await waitForOffscreenReady();
  })();

  try {
    await creating;
  } finally {
    creating = null;
  }
}

export function handleOffscreenProgress(message: {
  requestId: string;
  message: string;
  stage?: string;
}): boolean {
  pending.get(message.requestId)?.onProgress?.(message.message, message.stage);
  return true;
}

export function consumeRestoreResult(message: RestoreResult): RestoreResult | null {
  if (!message?.requestId || handledResults.has(message.requestId)) return null;
  handledResults.add(message.requestId);
  return message;
}

export function handleRestoreResultMessage(message: RestoreResult): boolean {
  const result = consumeRestoreResult(message);
  if (!result) return false;

  log("Result received from offscreen");
  if (result.storeId) log("Result storeId:", result.storeId);
  if (result.buffer) log("Result size:", result.buffer.byteLength, "bytes");

  const handler = pending.get(result.requestId);
  pending.delete(result.requestId);
  void chrome.alarms.clear(`ir-timeout-${result.requestId}`);
  void chrome.storage.session.remove("pendingRestore");

  if (!handler) return true;

  if (result.dataUrl) log("Result dataUrl length:", result.dataUrl.length);
  const hasPayload =
    Boolean(result.dataUrl) ||
    Boolean(result.storeId) ||
    Boolean(result.buffer && result.buffer.byteLength > 0);
  if (result.success && hasPayload) {
    handler.resolve(result);
  } else if (result.success) {
    handler.reject(
      new RestoreStageError(
        "RETURN_RESULT",
        "Restored image did not arrive in the background worker.",
      ),
    );
  } else {
    handler.reject(
      new RestoreStageError(
        result.stage || "RETURN_RESULT",
        result.error || "Image processing failed.",
      ),
    );
  }
  return true;
}

export async function sendToOffscreen(
  imageUrl: string,
  options: {
    timeoutMs?: number;
    tabId?: number;
    buffer?: ArrayBuffer;
    mimeType?: string;
    onProgress?: (message: string, stage?: string) => void;
  } = {},
): Promise<RestoreResult> {
  await ensureOffscreenDocument();
  scheduleIdleClose();

  const requestId = crypto.randomUUID();
  const timeoutMs = options.timeoutMs ?? OVERALL_TIMEOUT_MS;
  log("START");
  log("Sending restore request", requestId);

  await chrome.storage.session.set({
    pendingRestore: { requestId, tabId: options.tabId, startedAt: Date.now() },
  });
  await chrome.alarms.create(`ir-timeout-${requestId}`, { delayInMinutes: Math.max(0.5, timeoutMs / 60_000) });

  return new Promise<RestoreResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(requestId)) return;
      pending.delete(requestId);
      handledResults.add(requestId);
      void chrome.alarms.clear(`ir-timeout-${requestId}`);
      void chrome.storage.session.remove("pendingRestore");
      reject(new RestoreStageError("OVERALL", "EraseMark timed out. Try Manual Restore."));
    }, timeoutMs);

    pending.set(requestId, {
      tabId: options.tabId,
      onProgress: options.onProgress,
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });

    const payload = {
      type: "RESTORE_IMAGE" as const,
      imageUrl,
      requestId,
      buffer: options.buffer,
      mimeType: options.mimeType,
    };

    const sendViaMessage = (): void => {
      chrome.runtime
        .sendMessage(payload)
        .then((response) => {
          if (response?.type === "RESTORE_RESULT") {
            handleRestoreResultMessage(response);
          }
        })
        .catch((error: unknown) => {
          logError("sendMessage to offscreen failed:", error);
          handleRestoreResultMessage({
            requestId,
            success: false,
            stage: "RETURN_RESULT",
            error: error instanceof Error ? error.message : "Could not reach the restore engine.",
          });
        });
    };

    try {
      const port = chrome.runtime.connect({ name: "image-restore" });
      port.onMessage.addListener((message: RestoreResult & { type?: string; message?: string; stage?: string }) => {
        if (message?.requestId && message.requestId !== requestId) return;
        if (message?.type === "PROGRESS") {
          options.onProgress?.(message.message || "", message.stage);
          return;
        }
        if (message?.type === "RESTORE_RESULT") {
          handleRestoreResultMessage(message);
          try {
            port.disconnect();
          } catch {
            /* already closed */
          }
        }
      });
      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError?.message;
        if (err && !handledResults.has(requestId) && pending.has(requestId)) {
          logError("Offscreen port disconnected:", err);
          if (/Receiving end does not exist/i.test(err)) sendViaMessage();
        }
      });
      port.postMessage(payload);
    } catch (error) {
      logError("Port connect failed:", error);
      sendViaMessage();
    }
  });
}

export async function closeOffscreenDocumentIfSafe(): Promise<void> {
  if (pending.size > 0 || creating) return;
  if (!(await hasOffscreenDocument())) return;
  try {
    log("Closing idle offscreen document");
    await chrome.offscreen.closeDocument();
  } catch (error) {
    logError("Could not close offscreen document:", error);
  }
}

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void closeOffscreenDocumentIfSafe();
  }, IDLE_CLOSE_MS);
}

export async function handleRestoreTimeoutAlarm(alarmName: string): Promise<{ tabId?: number; requestId: string } | null> {
  if (!alarmName.startsWith("ir-timeout-")) return null;
  const requestId = alarmName.slice("ir-timeout-".length);
  if (handledResults.has(requestId)) return null;
  handledResults.add(requestId);
  const handler = pending.get(requestId);
  pending.delete(requestId);
  const stored = await chrome.storage.session.get("pendingRestore");
  const tabId = handler?.tabId ?? stored.pendingRestore?.tabId;
  await chrome.storage.session.remove("pendingRestore");
  handler?.reject(new RestoreStageError("OVERALL", "EraseMark timed out. Try Manual Restore."));
  return { tabId, requestId };
}

export async function recoverStaleRestore(): Promise<{ tabId?: number } | null> {
  const stored = await chrome.storage.session.get("pendingRestore");
  const pendingRestore = stored.pendingRestore as { requestId: string; tabId?: number; startedAt: number } | undefined;
  if (!pendingRestore) return null;
  if (Date.now() - pendingRestore.startedAt < OVERALL_TIMEOUT_MS) return null;
  if (handledResults.has(pendingRestore.requestId)) {
    await chrome.storage.session.remove("pendingRestore");
    return null;
  }
  handledResults.add(pendingRestore.requestId);
  pending.delete(pendingRestore.requestId);
  await chrome.storage.session.remove("pendingRestore");
  return { tabId: pendingRestore.tabId };
}
