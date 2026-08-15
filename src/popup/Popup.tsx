import { useEffect, useState } from "react";
import Button from "../components/Button";
import ImageDropzone from "../components/ImageDropzone";
import Logo from "../components/Logo";
import type { RecentImagePreview } from "../types";
import { blobToImageBitmap, createThumbnailDataUrl } from "../utils/image";
import { friendlyError } from "../utils/errors";
import { addRecentImage, getRecentImages, saveImageBlob } from "../utils/storage";
import "./popup.css";

export default function Popup() {
  const [recent, setRecent] = useState<RecentImagePreview[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getRecentImages().then(setRecent);
  }, []);

  const openEditor = async (imageId?: string, errorCode?: string) => {
    const query = imageId ? `?image=${encodeURIComponent(imageId)}` : errorCode ? `?error=${errorCode}` : "";
    await chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html${query}`) });
    window.close();
  };

  const handleFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const record = await saveImageBlob(file, { name: file.name, source: "upload", type: file.type });
      try {
        const bitmap = await blobToImageBitmap(file);
        const thumbnail = await createThumbnailDataUrl(bitmap);
        await addRecentImage({
          id: record.id,
          name: file.name,
          thumbnail,
          createdAt: Date.now(),
          width: bitmap.width,
          height: bitmap.height,
        });
        bitmap.close?.();
      } catch {
        // Thumbnail generation is optional.
      }
      await openEditor(record.id);
    } catch (err) {
      setError(friendlyError(err, "The image could not be loaded. It may be invalid or corrupted."));
      setBusy(false);
    }
  };

  const selectFromPage = async () => {
    setError(null);
    setBusy(true);
    try {
      const response = await chrome.runtime.sendMessage({ type: "START_SELECTION" });
      if (!response?.ok) {
        setError(response?.error || "EraseMark cannot access this page. Try a regular website tab.");
        setBusy(false);
        return;
      }
      window.close();
    } catch {
      setError("EraseMark cannot run on this page. Try a regular website tab.");
      setBusy(false);
    }
  };

  return (
    <div className="min-h-[580px] bg-slate-50 p-4 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Logo size={36} />
          <div>
            <h1 className="text-base font-semibold">EraseMark</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">Local image cleanup editor</p>
          </div>
        </div>
        <Button
          variant="ghost"
          className="px-2"
          title="Settings"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          ⚙
        </Button>
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-card dark:bg-slate-900">
        <h2 className="text-sm font-semibold">Quick Restore</h2>
        <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
          Right-click any image you are authorized to edit and choose EraseMark → Clean This Image.
        </p>
      </div>

      <div className="mt-4 rounded-2xl bg-white p-4 shadow-card dark:bg-slate-900">
        <h2 className="text-sm font-semibold">Manual Restore</h2>
        <p className="mt-1 mb-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
          Open the editor to manually select an area.
        </p>
        <ImageDropzone onFile={(file) => void handleFile(file)} compact />
        <Button className="mt-3 w-full" onClick={() => void selectFromPage()} disabled={busy}>
          Select from current page
        </Button>
        <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
          Use only on images you own or have permission to edit. Images are processed locally in your browser whenever possible.
        </p>
      </div>

      <div className="mt-4 rounded-2xl bg-white p-4 shadow-card dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Recent image</h2>
          {recent[0] ? (
            <button
              type="button"
              className="text-xs text-brand-600 hover:underline"
              onClick={() => void openEditor(recent[0].id)}
            >
              Open
            </button>
          ) : null}
        </div>
        {recent[0] ? (
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-xl bg-slate-50 p-2 text-left hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700"
            onClick={() => void openEditor(recent[0].id)}
          >
            <img src={recent[0].thumbnail} alt="" className="h-14 w-14 rounded-lg object-cover" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{recent[0].name}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {recent[0].width} × {recent[0].height}
              </p>
            </div>
          </button>
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">No recent images yet.</p>
        )}
      </div>

      {error ? (
        <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">
          {error}
        </p>
      ) : null}

      <section className="mt-4 rounded-2xl bg-white p-4 shadow-card dark:bg-slate-900">
        <h2 className="text-sm font-semibold">Privacy</h2>
        <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
          Images are processed locally in your browser whenever possible. Images are not uploaded to a
          server by this extension.
        </p>
      </section>
    </div>
  );
}
