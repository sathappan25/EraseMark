import { useRef, useState } from "react";
import { isSupportedImage } from "../utils/image";

interface ImageDropzoneProps {
  onFile: (file: File) => void;
  compact?: boolean;
}

export default function ImageDropzone({ onFile, compact = false }: ImageDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    if (!isSupportedImage(file)) {
      setError("That image format is not supported. Please use PNG, JPG, or WEBP.");
      return;
    }
    setError(null);
    onFile(file);
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          handleFile(event.dataTransfer.files[0]);
        }}
        className={`w-full rounded-2xl border border-dashed px-4 text-left transition ${
          compact ? "py-4" : "py-8"
        } ${
          dragOver
            ? "border-brand-600 bg-brand-50 dark:bg-slate-800"
            : "border-slate-300 bg-slate-50 hover:bg-white dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
        }`}
      >
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">Upload Image</p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          PNG, JPG, or WEBP. Drag a file here or click to browse.
        </p>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        className="hidden"
        onChange={(event) => {
          handleFile(event.target.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
    </div>
  );
}
