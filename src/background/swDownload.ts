import { RestoreStageError } from "../utils/timeout";

function log(...args: unknown[]): void {
  console.log("[EraseMark]", ...args);
}

function logError(...args: unknown[]): void {
  console.error("[EraseMark ERROR]", ...args);
}

async function downloadViaPage(tabId: number, dataUrl: string, filename: string): Promise<void> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (href: string, name: string) => {
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = name;
      anchor.rel = "noopener";
      document.documentElement.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return true;
    },
    args: [dataUrl, filename],
  });
  if (!injection?.result) {
    throw new Error("Could not start the download in the page.");
  }
}

export async function downloadInServiceWorker(
  dataUrl: string,
  filename: string,
  tabId?: number,
): Promise<void> {
  if (!dataUrl.startsWith("data:")) {
    throw new RestoreStageError("DOWNLOAD", "Restored image is empty.");
  }

  if (typeof chrome.downloads?.download === "function") {
    try {
      const downloadId = await chrome.downloads.download({
        url: dataUrl,
        filename,
        saveAs: false,
      });
      if (downloadId != null) {
        log("DOWNLOAD ✓", downloadId);
        return;
      }
    } catch (error) {
      logError("DOWNLOAD chrome.downloads failed:", error);
    }
  }

  if (tabId != null) {
    await downloadViaPage(tabId, dataUrl, filename);
    log("DOWNLOAD ✓ (page)");
    return;
  }

  throw new RestoreStageError("DOWNLOAD", "Downloads API is not available.");
}
