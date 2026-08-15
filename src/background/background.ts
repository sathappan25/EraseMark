import { DEFAULT_SETTINGS, type ImageSource, type RuntimeMessage } from "../types";
import { saveImageBlob, setPendingEditorState } from "../utils/storage";
import { processImage } from "./restoreAndDownload";
import {
  handleOffscreenProgress,
  handleRestoreResultMessage,
  handleRestoreTimeoutAlarm,
  recoverStaleRestore,
} from "./offscreenManager";
import { showRestoreLoading, showRestoreError, getReadableError } from "./pageOverlay";
import { RestoreStageError } from "../utils/timeout";

const CONTENT_SCRIPT = "content/imageSelector.js";
const MENU_PARENT_ID = "image-restore-root";
const MENU_ITEM_ID = "restore-image";
const CHUNK_BUFFERS = new Map<
  string,
  { chunks: ArrayBuffer[]; received: number; mime: string; name: string; source: ImageSource }
>();

function log(...args: unknown[]): void {
  console.log("[EraseMark]", ...args);
}

function logError(...args: unknown[]): void {
  console.error("[EraseMark ERROR]", ...args);
}

async function ensureContextMenus(): Promise<void> {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_PARENT_ID,
    title: "EraseMark",
    contexts: ["image"],
  });
  chrome.contextMenus.create({
    id: MENU_ITEM_ID,
    parentId: MENU_PARENT_ID,
    title: "Clean This Image",
    contexts: ["image"],
  });
  log("Context menus ready");
}

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await ensureContextMenus();
    const existing = await chrome.storage.local.get("settings");
    if (!existing.settings) {
      await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    }
    await recoverTimedOutRestore();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureContextMenus();
  void recoverTimedOutRestore();
});

async function recoverTimedOutRestore(): Promise<void> {
  try {
    const stale = await recoverStaleRestore();
    if (stale?.tabId != null) {
        await showRestoreError(
          stale.tabId,
          "EraseMark timed out.\nTry Manual Restore.",
          "OVERALL",
        );
    }
  } catch (error) {
    logError("Timeout recovery failed:", error);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  void (async () => {
    try {
      const timedOut = await handleRestoreTimeoutAlarm(alarm.name);
      if (timedOut?.tabId != null) {
        await showRestoreError(
          timedOut.tabId,
          "EraseMark timed out.\nTry Manual Restore.",
          "OVERALL",
        );
      }
    } catch (error) {
      logError("Alarm timeout failed:", error);
    }
  })();
});

async function openEditor(query = ""): Promise<void> {
  const url = chrome.runtime.getURL(`editor.html${query}`);
  await chrome.tabs.create({ url });
}

async function ensureContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_SCRIPT],
  });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "PING" });
      return;
    } catch (error) {
      console.error("[EraseMark] Waiting for content script:", error);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function storeCapturedImage(
  buffer: ArrayBuffer,
  mime: string,
  name: string,
  source: ImageSource,
): Promise<string> {
  const blob = new Blob([buffer], { type: mime || "image/png" });
  const record = await saveImageBlob(blob, { name, source, type: mime || blob.type });
  await setPendingEditorState({ imageId: record.id });
  return record.id;
}

async function openCapturedImage(
  buffer: ArrayBuffer,
  mime: string,
  name: string,
  source: ImageSource,
): Promise<void> {
  const id = await storeCapturedImage(buffer, mime, name, source);
  await openEditor(`?image=${encodeURIComponent(id)}`);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ITEM_ID) return;

  log("Context menu clicked");
  log("Image URL:", info.srcUrl);

  const tabId = tab?.id;
  void (async () => {
    try {
      if (!info.srcUrl) {
        throw new Error("No image URL was found.");
      }

      if (tabId != null) {
        await showRestoreLoading(tabId, "Starting...");
      }

      await processImage(info.srcUrl, tabId);
    } catch (error) {
      logError("Restore failed:", error);
      if (tabId != null) {
        try {
          const stage = error instanceof RestoreStageError ? error.stage : undefined;
          await showRestoreError(tabId, getReadableError(error), stage);
        } catch (overlayError) {
          logError("Could not show error overlay:", overlayError);
        }
      }
    }
  })();
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage | { type: "PING" }, _sender, sendResponse) => {
  if (message.type === "PING" || message.type === "OFFSCREEN_PING") {
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "PROGRESS") {
    handleOffscreenProgress(message);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "RESTORE_RESULT") {
    handleRestoreResultMessage(message);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "RESTORE_SUCCESS" || message.type === "SUCCESS") {
    handleRestoreResultMessage({
      requestId: message.requestId,
      success: true,
      mimeType: message.mimeType,
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "RESTORE_ERROR" || message.type === "ERROR") {
    handleRestoreResultMessage({
      requestId: message.requestId,
      success: false,
      error: message.error,
      stage: message.stage,
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "START_SELECTION") {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No active tab." });
        return;
      }
      try {
        await ensureContentScript(tab.id);
        await chrome.tabs.sendMessage(tab.id, { type: "START_SELECTION" } satisfies RuntimeMessage);
        sendResponse({ ok: true });
      } catch (error) {
        console.error("[EraseMark ERROR]", error);
        sendResponse({
          ok: false,
          error: "EraseMark cannot run on this page. Try a regular website tab.",
        });
      }
    })();
    return true;
  }

  if (message.type === "IMAGE_CAPTURED") {
    void openCapturedImage(message.buffer, message.mime, message.name, message.source)
      .then(() => sendResponse({ ok: true }))
      .catch(async (error: unknown) => {
        console.error("[EraseMark ERROR]", error);
        await setPendingEditorState({ error: "unknown" });
        await openEditor("?error=unknown");
        sendResponse({ ok: false });
      });
    return true;
  }

  if (message.type === "IMAGE_CHUNK") {
    const existing = CHUNK_BUFFERS.get(message.transferId) ?? {
      chunks: new Array<ArrayBuffer>(message.total),
      received: 0,
      mime: message.mime,
      name: message.name,
      source: message.source,
    };
    existing.chunks[message.index] = message.bytes;
    existing.received += 1;
    CHUNK_BUFFERS.set(message.transferId, existing);

    if (existing.received >= message.total) {
      CHUNK_BUFFERS.delete(message.transferId);
      const chunks = existing.chunks.filter((chunk): chunk is ArrayBuffer => Boolean(chunk));
      if (chunks.length !== message.total) {
        sendResponse({ ok: false });
        return false;
      }
      const totalSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const combined = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
      }
      void openCapturedImage(combined.buffer, existing.mime, existing.name, existing.source);
    }

    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "IMAGE_CAPTURE_FAILED") {
    void (async () => {
      await setPendingEditorState({ error: message.reason });
      await openEditor(`?error=${encodeURIComponent(message.reason)}`);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === "OPEN_EDITOR") {
    void (async () => {
      try {
        if (message.imageId) {
          await setPendingEditorState({ imageId: message.imageId });
          await openEditor(`?image=${encodeURIComponent(message.imageId)}`);
        } else if (message.error) {
          await setPendingEditorState({ error: message.error });
          await openEditor(`?error=${encodeURIComponent(message.error)}`);
        } else {
          await openEditor();
        }
        sendResponse({ ok: true });
      } catch (error) {
        console.error("[EraseMark ERROR]", error);
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  return false;
});
