import { initializeOpenCV as loadOpenCvRuntime } from "../utils/inpaint";

let ready: Promise<boolean> | null = null;

export function initializeOpenCV(): Promise<boolean> {
  if (ready) return ready;
  ready = loadOpenCvRuntime().then((ok) => {
    const runtime =
      (globalThis as unknown as { cv?: { Mat?: unknown; inpaint?: unknown } }).cv ??
      (window as unknown as { cv?: { Mat?: unknown; inpaint?: unknown } }).cv;
    if (!ok || typeof runtime?.Mat !== "function" || typeof runtime?.inpaint !== "function") {
      console.error("[EraseMark ERROR] INITIALIZE_PROCESSOR", "OpenCV runtime missing inpaint()");
      return false;
    }
    return true;
  });
  return ready;
}
