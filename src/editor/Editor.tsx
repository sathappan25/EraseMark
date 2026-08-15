import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BrushControl from "../components/BrushControl";
import Button from "../components/Button";
import ImageDropzone from "../components/ImageDropzone";
import Logo from "../components/Logo";
import Progress from "../components/Progress";
import Toolbar from "../components/Toolbar";
import type { EditorTool, InpaintAlgorithm, OutputFormat } from "../types";
import { clamp, createCanvas, getContext2d } from "../utils/canvas";
import { downloadRestoredImage } from "../utils/download";
import { friendlyError } from "../utils/errors";
import {
  blobToImageBitmap,
  createThumbnailDataUrl,
  imageSizeWarning,
  isSupportedImage,
  yieldToMain,
} from "../utils/image";
import { initializeOpenCV } from "../utils/inpaint";
import { restoreConservatively } from "../utils/conservativeInpaint";
import { MAX_AUTO_BBOX_PERCENT, MAX_AUTO_MASK_PERCENT, analyzeMaskCanvas } from "../utils/maskStats";
import {
  addRecentImage,
  consumePendingEditorState,
  getImageRecord,
  loadSettings,
  saveImageBlob,
} from "../utils/storage";
import CanvasEditor, { type EditorView } from "./CanvasEditor";
import type { MaskCanvasHandle } from "./MaskCanvas";
import "./editor.css";

type ProgressLabel =
  | "Preparing image..."
  | "Creating mask..."
  | "Cleaning image..."
  | "Generating preview..."
  | "Loading image engine...";

export default function Editor() {
  const [tool, setTool] = useState<EditorTool>("brush");
  const [brushSize, setBrushSize] = useState(30);
  const [radius, setRadius] = useState<3 | 5>(3);
  const [algorithm, setAlgorithm] = useState<InpaintAlgorithm>("TELEA");
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(24);
  const [panY, setPanY] = useState(24);
  const [view, setView] = useState<EditorView>("edit");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressLabel | null>(null);
  const [engineNote, setEngineNote] = useState<string | null>(null);
  const [imageName, setImageName] = useState("Untitled image");
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hasRestored, setHasRestored] = useState(false);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [spacePan, setSpacePan] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [largeMaskPrompt, setLargeMaskPrompt] = useState(false);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("png");
  const [jpegQuality, setJpegQuality] = useState(0.92);

  const originalRef = useRef<HTMLCanvasElement | null>(null);
  const restoredRef = useRef<HTMLCanvasElement | null>(null);
  const maskRef = useRef<MaskCanvasHandle | null>(null);
  const viewportSize = useRef({ width: 0, height: 0 });

  const loaded = size.width > 0 && size.height > 0;

  const indicator = useMemo(() => {
    if (view === "original") return "Original";
    if (view === "mask") return "Mask Preview";
    if (view === "restored" || view === "compare") return hasRestored ? "Cleaned" : "Original";
    return "Editing";
  }, [view, hasRestored]);

  const fitToScreen = useCallback(
    (width = size.width, height = size.height) => {
      const vw = viewportSize.current.width || window.innerWidth;
      const vh = viewportSize.current.height || window.innerHeight - 220;
      if (!width || !height) return;
      const nextZoom = clamp(Math.min((vw - 48) / width, (vh - 48) / height), 0.25, 4);
      setZoom(nextZoom);
      setPanX((vw - width * nextZoom) / 2);
      setPanY((vh - height * nextZoom) / 2);
    },
    [size.height, size.width],
  );

  const loadBlob = useCallback(
    async (blob: Blob, name: string) => {
      setProgress("Preparing image...");
      setError(null);
      setHasRestored(false);
      setView("edit");
      restoredRef.current = null;
      try {
        if (!isSupportedImage({ name, type: blob.type })) {
          throw new Error("That image format is not supported. Please use PNG, JPG, or WEBP.");
        }
        await yieldToMain();
        const bitmap = await blobToImageBitmap(blob);
        const canvas = createCanvas(bitmap.width, bitmap.height);
        getContext2d(canvas).drawImage(bitmap, 0, 0);
        originalRef.current = canvas;
        setSize({ width: bitmap.width, height: bitmap.height });
        setImageName(name);
        setWarning(imageSizeWarning(bitmap.width, bitmap.height));
        setProgress("Creating mask...");
        await yieldToMain();
        maskRef.current?.reset(bitmap.width, bitmap.height);
        setProgress(null);
        requestAnimationFrame(() => fitToScreen(bitmap.width, bitmap.height));
        bitmap.close?.();
      } catch (err) {
        setProgress(null);
        setError(friendlyError(err));
      }
    },
    [fitToScreen],
  );

  useEffect(() => {
    void loadSettings().then((loadedSettings) => {
      setBrushSize(loadedSettings.defaultBrushSize);
      setRadius(loadedSettings.defaultInpaintRadius === 5 ? 5 : 3);
      setAlgorithm(loadedSettings.inpaintAlgorithm);
      setOutputFormat(loadedSettings.defaultOutput);
    });
    void initializeOpenCV().then((ok) => {
      if (!ok) {
        setEngineNote("Using the built-in restoration engine because OpenCV.js did not finish loading.");
      }
    });
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const imageId = params.get("image");
    const errorCode = params.get("error");

    void (async () => {
      const pending = await consumePendingEditorState();
      const id = imageId || pending?.imageId;
      const err = errorCode || pending?.error;
      if (err === "cors") {
        setError("Chrome blocked access to this image. Please download/upload the image manually.");
        return;
      }
      if (err === "invalid") {
        setError("That image could not be used. Please upload a PNG, JPG, or WEBP file.");
        return;
      }
      if (!id) return;
      setProgress("Preparing image...");
      const record = await getImageRecord(id);
      if (!record) {
        setProgress(null);
        setError("The selected image is no longer available. Please upload it again.");
        return;
      }
      await loadBlob(record.blob, record.name);
    })();
  }, [loadBlob]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        event.preventDefault();
        setSpacePan(true);
      }
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) maskRef.current?.redo();
        else maskRef.current?.undo();
      }
      if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        maskRef.current?.redo();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpacePan(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const handleUpload = async (file: File) => {
    const record = await saveImageBlob(file, { name: file.name, source: "upload", type: file.type });
    try {
      const bitmap = await blobToImageBitmap(file);
      const thumbnail = await createThumbnailDataUrl(bitmap, 160);
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
      // Recent preview is optional.
    }
    await loadBlob(file, file.name);
  };

  const setZoomCentered = (nextZoom: number) => {
    const vw = viewportSize.current.width || window.innerWidth;
    const vh = viewportSize.current.height || window.innerHeight - 220;
    const cx = vw / 2;
    const cy = vh / 2;
    const imageX = (cx - panX) / Math.max(0.01, zoom);
    const imageY = (cy - panY) / Math.max(0.01, zoom);
    setZoom(nextZoom);
    setPanX(cx - imageX * nextZoom);
    setPanY(cy - imageY * nextZoom);
  };

  const handleRestore = async (ignoreLargeMask = false) => {
    if (!originalRef.current) return;
    const maskCanvas = maskRef.current?.getMaskCanvas();
    if (!maskCanvas || !maskRef.current?.hasMask()) {
      setError("No watermark area selected.");
      return;
    }
    const analysis = analyzeMaskCanvas(maskCanvas);
    if (analysis.pixels === 0) {
      setError("No watermark area selected.");
      return;
    }
    if (
      !ignoreLargeMask &&
      (analysis.percentage > MAX_AUTO_MASK_PERCENT || analysis.bboxPercentage > MAX_AUTO_BBOX_PERCENT)
    ) {
      setLargeMaskPrompt(true);
      return;
    }
    setLargeMaskPrompt(false);
    setError(null);
    setProgress("Cleaning image...");
    await yieldToMain();
    try {
      await initializeOpenCV().catch(() => false);
      const result = restoreConservatively(originalRef.current, maskCanvas, radius, algorithm);
      setProgress("Generating preview...");
      await yieldToMain();
      restoredRef.current = result.canvas;
      setHasRestored(true);
      setView("compare");
      setEngineNote(
        result.engine === "opencv" || result.engine === "nearest" || result.engine === "exemplar"
          ? null
          : "Cleaned with the built-in engine because OpenCV.js was unavailable.",
      );
    } catch (err) {
      setError(friendlyError(err, "The restoration engine failed to load. Reload the editor and try again."));
    } finally {
      setProgress(null);
    }
  };

  const handleDownload = async () => {
    const source = restoredRef.current;
    if (!source) {
      setError("Restore the image before downloading.");
      return;
    }
    try {
      await downloadRestoredImage(source, outputFormat, jpegQuality);
      setDownloadOpen(false);
    } catch (err) {
      setError(friendlyError(err, "Download failed. Please try again."));
    }
  };

  return (
    <div className="relative flex h-screen flex-col bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={() => window.close()} title="Back">
            ← Back
          </Button>
          <Logo size={28} />
          <div>
            <h1 className="text-sm font-semibold">EraseMark</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">{imageName}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {indicator}
          </span>
          <Button variant="primary" onClick={() => setDownloadOpen(true)} disabled={!hasRestored}>
            Download
          </Button>
        </div>
      </header>

      <main
        className="relative min-h-0 flex-1"
        ref={(node) => {
          if (!node) return;
          viewportSize.current = { width: node.clientWidth, height: node.clientHeight };
        }}
      >
        {loaded && originalRef.current ? (
          <CanvasEditor
            width={size.width}
            height={size.height}
            imageCanvas={originalRef.current}
            restoredCanvas={restoredRef.current}
            maskRef={maskRef}
            tool={tool}
            brushSize={brushSize}
            zoom={zoom}
            panX={panX}
            panY={panY}
            view={view}
            spacePan={spacePan}
            onPanChange={(x, y) => {
              setPanX(x);
              setPanY(y);
            }}
            onZoomChange={(nextZoom, x, y) => {
              setZoom(nextZoom);
              setPanX(x);
              setPanY(y);
            }}
            onHistoryChange={setHistory}
          />
        ) : (
          <div className="mx-auto flex h-full max-w-xl items-center p-6">
            <div className="w-full rounded-2xl bg-white p-6 shadow-card dark:bg-slate-900">
              <h2 className="text-lg font-semibold">Open an image</h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Upload an image you own or are authorized to edit. Then paint the unwanted overlay and restore it locally.
              </p>
              <div className="mt-4">
                <ImageDropzone onFile={(file) => void handleUpload(file)} />
              </div>
            </div>
          </div>
        )}
        {progress ? <Progress label={progress} /> : null}
      </main>

      <section className="border-t border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        {warning ? (
          <p className="mb-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
            {warning}
          </p>
        ) : null}
        {engineNote ? (
          <p className="mb-2 rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {engineNote}
          </p>
        ) : null}
        {error ? (
          <p className="mb-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/50 dark:text-rose-200">
            {error}
          </p>
        ) : null}

        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <BrushControl value={brushSize} onChange={setBrushSize} />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-slate-500">Inpainting Radius</span>
            {([3, 5] as const).map((value) => (
              <Button
                key={value}
                variant={radius === value ? "primary" : "secondary"}
                onClick={() => setRadius(value)}
              >
                {value}
              </Button>
            ))}
            <select
              value={algorithm}
              onChange={(event) => setAlgorithm(event.target.value as InpaintAlgorithm)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
            >
              <option value="TELEA">Telea</option>
              <option value="NS">Navier-Stokes</option>
            </select>
          </div>
        </div>

        <Toolbar
          tool={tool}
          onToolChange={(next) => {
            setTool(next);
            if (next === "brush" || next === "eraser") setView("edit");
          }}
          canUndo={history.canUndo}
          canRedo={history.canRedo}
          onUndo={() => maskRef.current?.undo()}
          onRedo={() => maskRef.current?.redo()}
          onClear={() => maskRef.current?.clear()}
          onSelectAll={() => maskRef.current?.selectAll()}
          onRestore={() => void handleRestore()}
          extra={
            <div className="flex flex-wrap gap-2">
              <Button variant={view === "mask" ? "primary" : "secondary"} onClick={() => setView("mask")}>
                Mask Preview
              </Button>
              <Button variant={view === "original" ? "primary" : "secondary"} onClick={() => setView("original")}>
                Show Original
              </Button>
              <Button
                variant={view === "restored" ? "primary" : "secondary"}
                onClick={() => setView("restored")}
                disabled={!hasRestored}
              >
                Show Restored
              </Button>
              <Button
                variant={view === "compare" ? "primary" : "secondary"}
                onClick={() => setView("compare")}
                disabled={!hasRestored}
              >
                Before / After
              </Button>
            </div>
          }
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={() => setZoom((value) => clamp(value / 1.15, 0.25, 4))}>Zoom −</Button>
          <span className="min-w-14 text-center text-sm font-medium">{Math.round(zoom * 100)}%</span>
          <Button onClick={() => setZoom((value) => clamp(value * 1.15, 0.25, 4))}>Zoom +</Button>
          <Button variant={Math.abs(zoom - 2) < 0.05 ? "primary" : "secondary"} onClick={() => setZoomCentered(2)}>
            200%
          </Button>
          <Button variant={Math.abs(zoom - 4) < 0.05 ? "primary" : "secondary"} onClick={() => setZoomCentered(4)}>
            400%
          </Button>
          <Button onClick={() => fitToScreen()}>Fit</Button>
          <Button
            onClick={() => {
              setZoom(1);
              setPanX(24);
              setPanY(24);
            }}
          >
            Reset
          </Button>
          <p className="ml-auto text-xs text-slate-500 dark:text-slate-400">
            Paint only regions you are allowed to edit. Processing stays on this device.
          </p>
        </div>
      </section>

      {largeMaskPrompt ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-card dark:bg-slate-900">
            <h2 className="text-base font-semibold">Large selection</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              Your selected area is large. Cleaning it may affect image details.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={() => setLargeMaskPrompt(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => void handleRestore(true)}>
                Continue
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {downloadOpen ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-card dark:bg-slate-900">
            <h2 className="text-base font-semibold">Download restored image</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Choose a format, then download explicitly. Nothing is uploaded.
            </p>
            <div className="mt-4 flex gap-2">
              <Button variant={outputFormat === "png" ? "primary" : "secondary"} onClick={() => setOutputFormat("png")}>
                PNG
              </Button>
              <Button
                variant={outputFormat === "jpeg" ? "primary" : "secondary"}
                onClick={() => setOutputFormat("jpeg")}
              >
                JPEG
              </Button>
            </div>
            {outputFormat === "jpeg" ? (
              <label className="mt-4 block text-sm text-slate-600 dark:text-slate-300">
                Quality {Math.round(jpegQuality * 100)}%
                <input
                  type="range"
                  min={0.6}
                  max={1}
                  step={0.01}
                  value={jpegQuality}
                  onChange={(event) => setJpegQuality(Number(event.target.value))}
                  className="mt-2 w-full accent-brand-600"
                />
              </label>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={() => setDownloadOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => void handleDownload()}>
                Download Restored Image
              </Button>
            </div>
          </div>
        </div>
      ) : null}

    </div>
  );
}
