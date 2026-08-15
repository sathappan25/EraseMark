const NOTIFICATION_ID = "image-restore-status";

function logError(...args: unknown[]): void {
  console.error("[EraseMark]", ...args);
}

async function showNotification(message: string): Promise<void> {
  const iconUrl = chrome.runtime.getURL("icon128.png");
  try {
    await chrome.notifications.create(NOTIFICATION_ID, {
      type: "basic",
      iconUrl,
      title: "EraseMark",
      message,
    });
  } catch (error) {
    logError("Notification failed:", error);
    try {
      await chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon48.png"),
        title: "EraseMark",
        message,
      });
    } catch (retryError) {
      logError("Notification retry failed:", retryError);
    }
  }
}

export async function notify(message: string): Promise<void> {
  await showNotification(message);
}

export async function notifyError(message: string): Promise<void> {
  await showNotification(message);
}

export async function notifySuccess(message: string): Promise<void> {
  await showNotification(message);
}
