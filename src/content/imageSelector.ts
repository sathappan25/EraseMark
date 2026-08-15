import type { ImageSource, RuntimeMessage } from "../types";

const ROOT_ID = "image-restore-selector-root";
const STYLE_ID = "image-restore-selector-style";

declare global {
  interface Window {
    __IMAGE_RESTORE_SELECTOR__?: boolean;
  }
}

function send(message: RuntimeMessage): Promise<void> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, () => resolve());
  });
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      pointer-events: none;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    }
    #${ROOT_ID} .ir-banner {
      pointer-events: auto;
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      background: #0f172a;
      color: #fff;
      border-radius: 999px;
      padding: 10px 16px;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.25);
      display: flex;
      gap: 12px;
      align-items: center;
      font-size: 13px;
    }
    #${ROOT_ID} .ir-banner button {
      border: 0;
      background: #334155;
      color: #fff;
      border-radius: 999px;
      padding: 6px 10px;
      cursor: pointer;
    }
    #${ROOT_ID} .ir-highlight {
      position: absolute;
      border: 2px solid #2563eb;
      background: rgba(37, 99, 235, 0.12);
      border-radius: 8px;
      pointer-events: none;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.7);
    }
  `;
  document.documentElement.appendChild(style);
}

function removeUi(): void {
  document.getElementById(ROOT_ID)?.remove();
}

function isUsableImage(el: Element | null): el is HTMLImageElement {
  if (!(el instanceof HTMLImageElement)) return false;
  const rect = el.getBoundingClientRect();
  return rect.width >= 24 && rect.height >= 24;
}

async function blobFromUrl(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (blob.type && !blob.type.startsWith("image/") && blob.type !== "application/octet-stream") {
      return null;
    }
    return blob;
  } catch (error) {
    console.error("[EraseMark]", error);
    return null;
  }
}

async function blobFromImageElement(image: HTMLImageElement): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(image);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
  } catch (error) {
    console.error("[EraseMark]", error);
    return null;
  }
}

async function captureUrl(
  url: string,
  image?: HTMLImageElement | null,
  source: ImageSource = "page",
): Promise<void> {
  const blob = (await blobFromUrl(url)) ?? (image ? await blobFromImageElement(image) : null);
  if (!blob) {
    await send({ type: "IMAGE_CAPTURE_FAILED", reason: "cors" });
    return;
  }

  const buffer = await blob.arrayBuffer();
  const maxSingle = 6 * 1024 * 1024;
  const mime = blob.type || "image/png";
  const name = "page-image";

  if (buffer.byteLength <= maxSingle) {
    await send({
      type: "IMAGE_CAPTURED",
      buffer,
      mime,
      name,
      source,
    });
    return;
  }

  const chunkSize = 256 * 1024;
  const bytes = new Uint8Array(buffer);
  const total = Math.ceil(bytes.byteLength / chunkSize);
  const transferId = crypto.randomUUID();
  for (let index = 0; index < total; index += 1) {
    const slice = bytes.slice(index * chunkSize, (index + 1) * chunkSize);
    await send({
      type: "IMAGE_CHUNK",
      transferId,
      index,
      total,
      mime,
      name,
      source,
      bytes: slice.buffer,
    });
  }
}

function startSelection(): void {
  ensureStyles();
  removeUi();

  const root = document.createElement("div");
  root.id = ROOT_ID;
  const banner = document.createElement("div");
  banner.className = "ir-banner";
  banner.innerHTML = `<span>Click an image to restore · Esc to cancel</span>`;
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  banner.appendChild(cancel);
  const highlight = document.createElement("div");
  highlight.className = "ir-highlight";
  highlight.style.display = "none";
  root.append(banner, highlight);
  document.documentElement.appendChild(root);

  const stop = () => {
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKey, true);
    removeUi();
  };

  const onMove = (event: MouseEvent) => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!isUsableImage(target)) {
      highlight.style.display = "none";
      return;
    }
    const rect = target.getBoundingClientRect();
    highlight.style.display = "block";
    highlight.style.left = `${rect.left - 4}px`;
    highlight.style.top = `${rect.top - 4}px`;
    highlight.style.width = `${rect.width + 8}px`;
    highlight.style.height = `${rect.height + 8}px`;
  };

  const onClick = (event: MouseEvent) => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!isUsableImage(target)) return;
    event.preventDefault();
    event.stopPropagation();
    stop();
    void captureUrl(target.currentSrc || target.src, target);
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      stop();
      void send({ type: "SELECTION_CANCELLED" });
    }
  };

  cancel.addEventListener("click", (event) => {
    event.preventDefault();
    stop();
  });

  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKey, true);
}

if (!window.__IMAGE_RESTORE_SELECTOR__) {
  window.__IMAGE_RESTORE_SELECTOR__ = true;
  chrome.runtime.onMessage.addListener((message: RuntimeMessage | { type: "PING" }, _sender, sendResponse) => {
    if (message.type === "PING") {
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "START_SELECTION") {
      startSelection();
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "CAPTURE_URL") {
      const image = Array.from(document.images).find(
        (img) => img.currentSrc === message.url || img.src === message.url,
      );
      void (async () => {
        const blob =
          (await blobFromUrl(message.url)) ?? (image ? await blobFromImageElement(image) : null);
        if (!blob) {
          sendResponse({ ok: false, reason: "cors" });
          return;
        }
        sendResponse({
          ok: true,
          mime: blob.type || "image/png",
          buffer: await blob.arrayBuffer(),
        });
      })();
      return true;
    }
    return false;
  });
}
