export type ThemeSetting = "system" | "light" | "dark";
export type OutputFormat = "png" | "jpeg";
export type InpaintAlgorithm = "TELEA" | "NS";
export type EditorTool = "brush" | "eraser" | "pan";
export type ImageSource = "upload" | "page" | "context-menu" | "recent";

export interface AppSettings {
  theme: ThemeSetting;
  defaultBrushSize: 10 | 20 | 30 | 50 | 100;
  defaultInpaintRadius: 3 | 5;
  defaultOutput: OutputFormat;
  inpaintAlgorithm: InpaintAlgorithm;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  defaultBrushSize: 30,
  defaultInpaintRadius: 3,
  defaultOutput: "png",
  inpaintAlgorithm: "TELEA",
};

export interface StoredImageMeta {
  id: string;
  name: string;
  type: string;
  width: number;
  height: number;
  createdAt: number;
  source: ImageSource;
}

export interface RecentImagePreview {
  id: string;
  name: string;
  thumbnail: string;
  createdAt: number;
  width: number;
  height: number;
}

export type RuntimeMessage =
  | { type: "START_SELECTION" }
  | { type: "CAPTURE_URL"; url: string }
  | { type: "SELECTION_CANCELLED" }
  | {
      type: "IMAGE_CAPTURED";
      mime: string;
      name: string;
      buffer: ArrayBuffer;
      source: ImageSource;
    }
  | {
      type: "IMAGE_CHUNK";
      transferId: string;
      index: number;
      total: number;
      mime: string;
      name: string;
      source: ImageSource;
      bytes: ArrayBuffer;
    }
  | { type: "IMAGE_CAPTURE_FAILED"; reason: "cors" | "invalid" | "unknown"; detail?: string }
  | { type: "OPEN_EDITOR"; imageId?: string; error?: string }
  | { type: "OFFSCREEN_PING" }
  | { type: "OFFSCREEN_RESTORE"; buffer: ArrayBuffer; mime: string }
  | { type: "QUICK_RESTORE_PROGRESS"; stage: string }
  | { type: "RESTORE_IMAGE"; imageUrl: string; requestId: string; buffer?: ArrayBuffer; mimeType?: string }
  | { type: "RESTORE_SUCCESS"; requestId: string; blobData?: string; mimeType?: string }
  | { type: "RESTORE_ERROR"; requestId: string; error: string; stage?: string }
  | { type: "PROGRESS"; requestId: string; message: string; stage?: string }
  | { type: "SUCCESS"; requestId: string; blobData?: string; mimeType?: string }
  | { type: "ERROR"; requestId: string; error: string; stage?: string }
  | {
      type: "RESTORE_RESULT";
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
  | {
      type: "DOWNLOAD_RESTORED";
      requestId: string;
      filename: string;
      buffer?: ArrayBuffer;
      storeId?: string;
      mimeType?: string;
    }
  | {
      type: "DOWNLOAD_RESULT";
      requestId: string;
      success: boolean;
      downloadId?: number;
      error?: string;
    };

export const LARGE_IMAGE_PIXELS = 16_000_000;
export const EXTREME_IMAGE_PIXELS = 40_000_000;
export const MAX_RECENT_IMAGES = 8;
export const MAX_MASK_HISTORY = 20;
export const SUPPORTED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
export const SUPPORTED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];
