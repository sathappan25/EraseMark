import type { InpaintAlgorithm } from "../types";
import { createCanvas, getContext2d } from "./canvas";
import { inpaintNsJs, inpaintTeleaJs } from "./inpaintFallback";
import { yieldToMain } from "./image";

let opencvPromise: Promise<boolean> | null = null;
let cvRuntime: OpenCVRuntime | null = null;

function readGlobalCv(): unknown {
  return (globalThis as unknown as { cv?: unknown }).cv;
}

function isOpenCvRuntime(value: unknown): value is OpenCVRuntime {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OpenCVRuntime>;
  return typeof candidate.Mat === "function" && typeof candidate.inpaint === "function";
}

function getCv(): OpenCVRuntime {
  if (isOpenCvRuntime(cvRuntime)) return cvRuntime;
  const globalCv = readGlobalCv();
  if (isOpenCvRuntime(globalCv)) {
    cvRuntime = globalCv;
    return globalCv;
  }
  throw new Error("OpenCV is not ready.");
}

async function adoptOpenCv(candidate: unknown): Promise<boolean> {
  let value = candidate;
  if (value && typeof (value as Promise<unknown>).then === "function") {
    try {
      value = await value;
    } catch (error) {
      console.error("[EraseMark ERROR] INITIALIZE_PROCESSOR", error);
      return false;
    }
  }
  if (isOpenCvRuntime(value)) {
    cvRuntime = value;
    (globalThis as unknown as { cv: OpenCVRuntime }).cv = value;
    return true;
  }
  if (value && typeof value === "object") {
    const runtime = value as OpenCVRuntime;
    if (typeof runtime.inpaint === "function" && typeof runtime.Mat === "function") {
      cvRuntime = runtime;
      (globalThis as unknown as { cv: OpenCVRuntime }).cv = runtime;
      return true;
    }
    const previous = runtime.onRuntimeInitialized;
    runtime.onRuntimeInitialized = () => {
      previous?.();
    };
  }
  return false;
}

function ensureOpenCvScript(): void {
  if (document.querySelector("script[src*='opencv.js']")) return;
  const src = chrome?.runtime?.getURL ? chrome.runtime.getURL("opencv.js") : "/opencv.js";
  const script = document.createElement("script");
  script.id = "image-restore-opencv";
  script.src = src;
  script.async = true;
  script.onerror = () => {
    console.error("[EraseMark ERROR] INITIALIZE_PROCESSOR", "Failed to load opencv.js");
  };
  document.head.appendChild(script);
}

export function initializeOpenCV(): Promise<boolean> {
  if (opencvPromise) return opencvPromise;

  opencvPromise = (async () => {
    console.log("[EraseMark] INITIALIZE_PROCESSOR");
    if (isOpenCvRuntime(cvRuntime) || isOpenCvRuntime(readGlobalCv())) {
      console.log("[EraseMark] OpenCV ready");
      return true;
    }

    ensureOpenCvScript();

    const started = Date.now();
    const maxWait = 30_000;
    while (Date.now() - started < maxWait) {
      const globalCv = readGlobalCv();
      if (globalCv) {
        try {
          if (await adoptOpenCv(globalCv)) {
            console.log("[EraseMark] OpenCV ready");
            return true;
          }
        } catch (error) {
          console.error("[EraseMark ERROR] INITIALIZE_PROCESSOR", error);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    console.error("[EraseMark ERROR] INITIALIZE_PROCESSOR", "OpenCV failed to initialize.");
    return false;
  })();

  return opencvPromise;
}

function canvasToGrayMask(maskCanvas: HTMLCanvasElement): Uint8Array {
  const ctx = getContext2d(maskCanvas) as CanvasRenderingContext2D;
  const { data } = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  const mask = new Uint8Array(maskCanvas.width * maskCanvas.height);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    mask[i] = data[p] > 16 ? 255 : 0;
  }
  return mask;
}

function restoreWithFallback(
  imageCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  radius: number,
  algorithm: InpaintAlgorithm,
): HTMLCanvasElement {
  const ctx = getContext2d(imageCanvas) as CanvasRenderingContext2D;
  const source = ctx.getImageData(0, 0, imageCanvas.width, imageCanvas.height);
  const mask = canvasToGrayMask(maskCanvas);
  const restored =
    algorithm === "NS" ? inpaintNsJs(source, mask, radius) : inpaintTeleaJs(source, mask, radius);
  const output = createCanvas(imageCanvas.width, imageCanvas.height);
  const outCtx = getContext2d(output) as CanvasRenderingContext2D;
  outCtx.putImageData(restored, 0, 0);
  return output;
}

function restoreWithOpenCv(
  imageCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  radius: number,
  algorithm: InpaintAlgorithm,
): HTMLCanvasElement {
  const cv = getCv();
  const srcRgba = cv.imread(imageCanvas);
  const maskRgba = cv.imread(maskCanvas);
  const src = new cv.Mat();
  const gray = new cv.Mat();
  const mask = new cv.Mat();
  const dst = new cv.Mat();
  const rgba = new cv.Mat();

  try {
    cv.cvtColor(srcRgba, src, cv.COLOR_RGBA2RGB);
    cv.cvtColor(maskRgba, gray, cv.COLOR_RGBA2GRAY);
    cv.threshold(gray, mask, 16, 255, cv.THRESH_BINARY);
    const nonZero =
      typeof (cv as unknown as { countNonZero?: (mat: OpenCVMat) => number }).countNonZero === "function"
        ? (cv as unknown as { countNonZero: (mat: OpenCVMat) => number }).countNonZero(mask)
        : -1;
    console.log("[EraseMark] Running inpainting");
    console.log("[EraseMark] Mask pixels:", nonZero);
    cv.inpaint(
      src,
      mask,
      dst,
      Math.max(1, radius),
      algorithm === "NS" ? cv.INPAINT_NS : cv.INPAINT_TELEA,
    );
    console.log("[EraseMark] Inpainting completed");
    cv.cvtColor(dst, rgba, cv.COLOR_RGB2RGBA);

    const output = createCanvas(imageCanvas.width, imageCanvas.height);
    cv.imshow(output, rgba);
    return output;
  } finally {
    srcRgba.delete();
    maskRgba.delete();
    src.delete();
    gray.delete();
    mask.delete();
    dst.delete();
    rgba.delete();
  }
}

export function isOpenCvReady(): boolean {
  return isOpenCvRuntime(cvRuntime) || isOpenCvRuntime(readGlobalCv());
}

export function restoreImageLocal(
  imageCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  radius: number,
  algorithm: InpaintAlgorithm = "TELEA",
): HTMLCanvasElement {
  if (imageCanvas.width !== maskCanvas.width || imageCanvas.height !== maskCanvas.height) {
    throw new Error("The mask must match the original image dimensions.");
  }
  return restoreWithFallback(imageCanvas, maskCanvas, radius, algorithm);
}

export function tryRestoreWithOpenCv(
  imageCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  radius: number,
  algorithm: InpaintAlgorithm = "TELEA",
): HTMLCanvasElement | null {
  if (!isOpenCvReady()) return null;
  try {
    return restoreWithOpenCv(imageCanvas, maskCanvas, radius, algorithm);
  } catch (error) {
    console.error("[EraseMark ERROR] INPAINT", error);
    return null;
  }
}

export async function restoreImageStrict(
  imageCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  radius: number,
  algorithm: InpaintAlgorithm = "TELEA",
): Promise<{ canvas: HTMLCanvasElement; engine: "nearest" | "exemplar" | "opencv" | "fallback" }> {
  if (imageCanvas.width !== maskCanvas.width || imageCanvas.height !== maskCanvas.height) {
    throw new Error("The mask must match the original image dimensions.");
  }
  await yieldToMain();
  try {
    await initializeOpenCV();
  } catch (error) {
    console.error("[EraseMark ERROR] INITIALIZE_PROCESSOR", error);
  }
  try {
    const { restoreConservatively } = await import("./conservativeInpaint");
    const result = restoreConservatively(imageCanvas, maskCanvas, radius, algorithm);
    return { canvas: result.canvas, engine: result.engine };
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("memory") || message.includes("allocation")) {
      throw new Error("This image is too large to process in the browser. Try a smaller image.");
    }
    throw error instanceof Error ? error : new Error("Inpainting failed.");
  }
}

export async function restoreImage(
  imageCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  radius: number,
  algorithm: InpaintAlgorithm = "TELEA",
): Promise<{ canvas: HTMLCanvasElement; engine: "nearest" | "exemplar" | "opencv" | "fallback" }> {
  if (imageCanvas.width !== maskCanvas.width || imageCanvas.height !== maskCanvas.height) {
    throw new Error("The mask must match the original image dimensions.");
  }

  await yieldToMain();
  try {
    await initializeOpenCV();
  } catch (error) {
    console.error("[EraseMark ERROR] INITIALIZE_PROCESSOR", error);
  }

  const { restoreConservatively } = await import("./conservativeInpaint");
  const result = restoreConservatively(imageCanvas, maskCanvas, radius, algorithm);
  return { canvas: result.canvas, engine: result.engine };
}
