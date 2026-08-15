import {
  DEFAULT_SETTINGS,
  MAX_RECENT_IMAGES,
  type AppSettings,
  type ImageSource,
  type RecentImagePreview,
  type StoredImageMeta,
} from "../types";

const DB_NAME = "image-restore-db";
const DB_VERSION = 2;
const IMAGE_STORE = "images";
const QUICK_STORE = "quick-restore";

export interface StoredImageRecord extends StoredImageMeta {
  blob: Blob;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Could not open local image storage."));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IMAGE_STORE)) {
        db.createObjectStore(IMAGE_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(QUICK_STORE)) {
        db.createObjectStore(QUICK_STORE);
      }
    };
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Storage request failed."));
  });
}

export async function saveImageBlob(
  blob: Blob,
  options: {
    name?: string;
    source?: ImageSource;
    width?: number;
    height?: number;
    type?: string;
  } = {},
): Promise<StoredImageRecord> {
  const id = crypto.randomUUID();
  const record: StoredImageRecord = {
    id,
    blob,
    name: options.name || "image",
    type: options.type || blob.type || "image/png",
    width: options.width ?? 0,
    height: options.height ?? 0,
    createdAt: Date.now(),
    source: options.source ?? "upload",
  };

  const db = await openDb();
  try {
    const tx = db.transaction(IMAGE_STORE, "readwrite");
    await idbRequest(tx.objectStore(IMAGE_STORE).put(record));
  } finally {
    db.close();
  }

  return record;
}

export async function getImageRecord(id: string): Promise<StoredImageRecord | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(IMAGE_STORE, "readonly");
    const record = await idbRequest<StoredImageRecord | undefined>(
      tx.objectStore(IMAGE_STORE).get(id),
    );
    return record ?? null;
  } finally {
    db.close();
  }
}

export async function saveQuickRestoreBlob(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(QUICK_STORE, "readwrite");
    await idbRequest(tx.objectStore(QUICK_STORE).put(blob, id));
  } finally {
    db.close();
  }
}

export async function takeQuickRestoreBlob(id: string): Promise<Blob | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(QUICK_STORE, "readwrite");
    const store = tx.objectStore(QUICK_STORE);
    const blob = await idbRequest<Blob | undefined>(store.get(id));
    if (blob) await idbRequest(store.delete(id));
    return blob ?? null;
  } finally {
    db.close();
  }
}

export async function deleteImageRecord(id: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(IMAGE_STORE, "readwrite");
    await idbRequest(tx.objectStore(IMAGE_STORE).delete(id));
  } finally {
    db.close();
  }
}

export async function loadSettings(): Promise<AppSettings> {
  if (!chrome?.storage?.local) return { ...DEFAULT_SETTINGS };
  const result = await chrome.storage.local.get("settings");
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(result.settings as Partial<AppSettings> | undefined),
  };
  if (merged.defaultInpaintRadius !== 3 && merged.defaultInpaintRadius !== 5) {
    merged.defaultInpaintRadius = 3;
  }
  return merged;
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

export async function getRecentImages(): Promise<RecentImagePreview[]> {
  if (!chrome?.storage?.local) return [];
  const result = await chrome.storage.local.get("recentImages");
  return Array.isArray(result.recentImages) ? result.recentImages : [];
}

export async function addRecentImage(preview: RecentImagePreview): Promise<void> {
  const existing = await getRecentImages();
  const next = [preview, ...existing.filter((item) => item.id !== preview.id)].slice(
    0,
    MAX_RECENT_IMAGES,
  );
  await chrome.storage.local.set({ recentImages: next });
}

export async function setPendingEditorState(state: {
  imageId?: string;
  error?: string;
}): Promise<void> {
  await chrome.storage.local.set({ pendingEditor: state });
}

export async function consumePendingEditorState(): Promise<{
  imageId?: string;
  error?: string;
} | null> {
  if (!chrome?.storage?.local) return null;
  const result = await chrome.storage.local.get("pendingEditor");
  if (result.pendingEditor) {
    await chrome.storage.local.remove("pendingEditor");
  }
  return result.pendingEditor ?? null;
}
