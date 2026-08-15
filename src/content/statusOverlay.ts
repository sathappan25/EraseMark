export type OverlayMode = "loading" | "success" | "error";

export interface OverlayState {
  mode: OverlayMode;
  message: string;
  detail?: string;
  showManual?: boolean;
  progress?: number;
  stage?: string;
}

const OVERLAY_ID = "image-restore-status-overlay";
const STYLE_ID = "image-restore-status-style";

export function applyOverlayState(state: OverlayState): void {
  const overlayId = "image-restore-status-overlay";
  const styleId = "image-restore-status-style";

  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      @keyframes irCheckIn {
        0% { opacity: 0; transform: scale(.65); }
        65% { opacity: 1; transform: scale(1.08); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes irContentIn {
        from { opacity: 0; transform: translateY(5px); }
        to { opacity: 1; transform: translateY(0); }
      }
      #${overlayId} {
        position: fixed !important;
        top: max(16px, env(safe-area-inset-top)) !important;
        right: max(16px, env(safe-area-inset-right)) !important;
        z-index: 2147483647 !important;
        width: min(348px, calc(100vw - 32px));
        box-sizing: border-box;
        padding: 17px 18px;
        border-radius: 16px;
        background: linear-gradient(145deg, rgba(15, 23, 42, .94), rgba(7, 12, 25, .96));
        color: #f8fafc;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
        box-shadow: 0 20px 55px rgba(0, 0, 0, .38), inset 0 1px 0 rgba(255,255,255,.035);
        border: 1px solid rgba(148, 163, 184, .18);
        backdrop-filter: blur(18px) saturate(135%);
        -webkit-backdrop-filter: blur(18px) saturate(135%);
        overflow: hidden;
        transition: border-color .3s ease, box-shadow .3s ease, opacity .25s ease;
      }
      #${overlayId} .ir-title {
        display: flex;
        align-items: center;
        gap: 7px;
        margin: 0 0 14px;
        color: #f8fafc;
        font-size: 13px;
        font-weight: 750;
        letter-spacing: .01em;
      }
      #${overlayId} .ir-brand-mark { color: #818cf8; text-shadow: 0 0 14px rgba(129,140,248,.65); }
      #${overlayId} .ir-heading {
        margin: 0;
        font-size: 15px;
        line-height: 1.35;
        font-weight: 720;
        letter-spacing: -.01em;
      }
      #${overlayId} .ir-progress-meta {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 15px;
        color: #cbd5e1;
        font-size: 12px;
        font-weight: 600;
      }
      #${overlayId} .ir-percent {
        color: #eef2ff;
        font-variant-numeric: tabular-nums;
      }
      #${overlayId} .ir-track {
        position: relative;
        height: 7px;
        margin-top: 8px;
        overflow: hidden;
        border-radius: 999px;
        background: rgba(148,163,184,.16);
        box-shadow: inset 0 1px 2px rgba(0,0,0,.25);
      }
      #${overlayId} .ir-fill {
        height: 100%;
        min-width: 0;
        border-radius: inherit;
        background: linear-gradient(90deg, #6366f1, #818cf8 55%, #a78bfa);
        box-shadow: 0 0 14px rgba(129,140,248,.58);
        transition: width .48s cubic-bezier(.22,.8,.32,1);
      }
      #${overlayId} .ir-detail {
        margin: 10px 0 0;
        font-size: 12px;
        line-height: 1.5;
        color: #94a3b8;
        white-space: pre-wrap;
      }
      #${overlayId} .ir-result {
        display: grid;
        grid-template-columns: 36px 1fr;
        gap: 12px;
        align-items: start;
        animation: irContentIn .32s ease both;
      }
      #${overlayId} .ir-result-icon {
        display: grid;
        place-items: center;
        width: 34px;
        height: 34px;
        border-radius: 50%;
        font-size: 17px;
        font-weight: 800;
        animation: irCheckIn .42s cubic-bezier(.2,.9,.25,1.2) both;
      }
      #${overlayId}[data-mode="success"] .ir-result-icon {
        color: #052e23;
        background: #6ee7b7;
        box-shadow: 0 0 18px rgba(52,211,153,.3);
      }
      #${overlayId}[data-mode="error"] .ir-result-icon {
        color: #450a0a;
        background: #fda4af;
        box-shadow: 0 0 18px rgba(251,113,133,.25);
      }
      #${overlayId} .ir-support {
        margin: 4px 0 0;
        color: #cbd5e1;
        font-size: 12px;
        line-height: 1.5;
      }
      #${overlayId} .ir-secondary {
        margin: 8px 0 0;
        color: #94a3b8;
        font-size: 11.5px;
        font-weight: 600;
      }
      #${overlayId} .ir-btn {
        margin-top: 13px;
        border: 1px solid rgba(129,140,248,.35);
        border-radius: 10px;
        background: rgba(99,102,241,.16);
        color: #e0e7ff;
        font-size: 12px;
        font-weight: 650;
        padding: 8px 11px;
        cursor: pointer;
        transition: background .2s ease, transform .2s ease;
      }
      #${overlayId} .ir-btn:hover { background: rgba(99,102,241,.25); transform: translateY(-1px); }
      #${overlayId}[data-mode="success"] { border-color: rgba(52,211,153,.3); }
      #${overlayId}[data-mode="error"] { border-color: rgba(251,113,133,.3); }
      @media (prefers-reduced-motion: reduce) {
        #${overlayId} *, #${overlayId} { animation: none !important; transition-duration: .01ms !important; }
      }
    `;
    document.documentElement.appendChild(style);
  }

  let root = document.getElementById(overlayId);
  if (!root) {
    root = document.createElement("div");
    root.id = overlayId;
    document.documentElement.appendChild(root);
  }

  const managedRoot = root as HTMLElement & {
    __irHide?: number;
    __irTransition?: number;
  };
  window.clearTimeout(managedRoot.__irHide);
  window.clearTimeout(managedRoot.__irTransition);

  const brand = `<p class="ir-title"><span class="ir-brand-mark">✦</span> EraseMark</p>`;
  const bindManualButton = (): void => {
    const button = root?.querySelector<HTMLButtonElement>(".ir-btn");
    button?.addEventListener("click", () => {
      try {
        chrome.runtime.sendMessage({ type: "OPEN_EDITOR" });
      } catch (error) {
        console.error("[EraseMark]", error);
      }
    });
  };

  const renderResult = (mode: "success" | "error"): void => {
    if (!root) return;
    root.dataset.mode = mode;
    delete root.dataset.progress;
    const success = mode === "success";
    root.innerHTML = `
      ${brand}
      <div class="ir-result">
        <span class="ir-result-icon" aria-hidden="true">${success ? "✓" : "×"}</span>
        <div>
          <p class="ir-heading">${success ? "Image cleaned" : "Image cleaning failed"}</p>
          <p class="ir-support">${
            success
              ? "Your image has been successfully processed."
              : "We couldn't process your image."
          }</p>
          <p class="ir-secondary">${success ? "Download completed" : "Try again"}</p>
          ${!success && state.showManual ? `<button class="ir-btn" type="button">Open Manual Restore</button>` : ""}
        </div>
      </div>
    `;
    bindManualButton();
    managedRoot.__irHide = window.setTimeout(() => root?.remove(), success ? 3000 : 8000);
  };

  if (state.mode === "success") {
    const previous = Number(root.dataset.progress || 0);
    root.dataset.mode = "loading";
    root.dataset.progress = "100";
    root.innerHTML = `
      ${brand}
      <p class="ir-heading">Almost done...</p>
      <div class="ir-progress-meta"><span>Cleaning image</span><span class="ir-percent">100%</span></div>
      <div class="ir-track"><div class="ir-fill" style="width:${Math.min(previous, 99)}%"></div></div>
      <p class="ir-detail">Finalizing cleaned image...</p>
    `;
    requestAnimationFrame(() => {
      const fill = root?.querySelector<HTMLElement>(".ir-fill");
      if (fill) fill.style.width = "100%";
    });
    managedRoot.__irTransition = window.setTimeout(() => renderResult("success"), 420);
    return;
  }

  if (state.mode === "error") {
    renderResult("error");
    return;
  }

  const targetProgress = Math.max(0, Math.min(99, Math.round(state.progress ?? 0)));
  const previousProgress = Math.max(
    0,
    Math.min(targetProgress, Number(root.dataset.progress || targetProgress)),
  );
  root.dataset.mode = "loading";
  root.dataset.progress = String(targetProgress);
  root.innerHTML = `
    ${brand}
    <p class="ir-heading">${targetProgress >= 95 ? "Almost done..." : "Cleaning your image..."}</p>
    <div class="ir-progress-meta">
      <span>Cleaning image</span>
      <span class="ir-percent">${targetProgress}%</span>
    </div>
    <div class="ir-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${targetProgress}">
      <div class="ir-fill" style="width:${previousProgress}%"></div>
    </div>
    <p class="ir-detail">${targetProgress >= 95 ? "Finalizing cleaned image..." : "Processing your image..."}</p>
  `;
  requestAnimationFrame(() => {
    const fill = root?.querySelector<HTMLElement>(".ir-fill");
    if (fill) fill.style.width = `${targetProgress}%`;
  });
}

export function showProcessingOverlay(message = "Starting..."): void {
  applyOverlayState({ mode: "loading", message, progress: 0, stage: "START" });
}

export function updateProcessingOverlay(message: string, progress?: number, stage?: string): void {
  applyOverlayState({ mode: "loading", message, progress, stage });
}

export function showSuccessOverlay(message = "✓ Image cleaned successfully!"): void {
  applyOverlayState({
    mode: "success",
    message,
    detail: "Download completed",
  });
}

export function showErrorOverlay(message: string, detail?: string): void {
  applyOverlayState({
    mode: "error",
    message: "Image cleaning failed",
    detail: detail ? `${message}\n\n${detail}` : message,
    showManual: true,
  });
}

export function removeProcessingOverlay(): void {
  document.getElementById(OVERLAY_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();
}

declare global {
  interface Window {
    __IMAGE_RESTORE_APPLY_OVERLAY__?: typeof applyOverlayState;
  }
}

if (typeof document !== "undefined") {
  window.__IMAGE_RESTORE_APPLY_OVERLAY__ = applyOverlayState;
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "OVERLAY_STATE" && message.state) {
        applyOverlayState(message.state as OverlayState);
        sendResponse({ ok: true });
        return false;
      }
      return false;
    });
  }
}
