import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { MAX_MASK_HISTORY } from "../types";
import {
  clearCanvas,
  getContext2d,
  maskHasSelection,
  paintOverlayFromMask,
  restoreMaskChannel,
  snapshotMaskChannel,
} from "../utils/canvas";

export interface MaskCanvasHandle {
  beginStroke: (x: number, y: number, tool: "brush" | "eraser", size: number) => void;
  continueStroke: (x: number, y: number) => void;
  endStroke: () => void;
  undo: () => boolean;
  redo: () => boolean;
  clear: () => void;
  selectAll: () => void;
  hasMask: () => boolean;
  getMaskCanvas: () => HTMLCanvasElement | null;
  reset: (width: number, height: number) => void;
}

interface MaskCanvasProps {
  width: number;
  height: number;
  visible?: boolean;
  onHistoryChange?: (state: { canUndo: boolean; canRedo: boolean }) => void;
}

function maxHistoryForSize(width: number, height: number): number {
  const pixels = width * height;
  if (pixels > 20_000_000) return 4;
  if (pixels > 8_000_000) return 8;
  return MAX_MASK_HISTORY;
}

function drawStamp(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  composite?: GlobalCompositeOperation,
) {
  ctx.save();
  if (composite) ctx.globalCompositeOperation = composite;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

const MaskCanvas = forwardRef<MaskCanvasHandle, MaskCanvasProps>(function MaskCanvas(
  { width, height, visible = true, onHistoryChange },
  ref,
) {
  const maskRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<Uint8Array[]>([]);
  const redoRef = useRef<Uint8Array[]>([]);
  const strokeRef = useRef<{
    tool: "brush" | "eraser";
    size: number;
    lastX: number;
    lastY: number;
    started: boolean;
  } | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const publishHistory = () => {
    const nextCanUndo = historyRef.current.length > 0;
    const nextCanRedo = redoRef.current.length > 0;
    setCanUndo(nextCanUndo);
    setCanRedo(nextCanRedo);
    onHistoryChange?.({ canUndo: nextCanUndo, canRedo: nextCanRedo });
  };

  const snapshot = () => {
    const mask = maskRef.current;
    if (!mask) return;
    historyRef.current.push(snapshotMaskChannel(mask));
    const limit = maxHistoryForSize(mask.width, mask.height);
    if (historyRef.current.length > limit) historyRef.current.shift();
    redoRef.current = [];
    publishHistory();
  };

  const applySnapshot = (data: Uint8Array) => {
    const mask = maskRef.current;
    const overlay = overlayRef.current;
    if (!mask || !overlay) return;
    restoreMaskChannel(mask, data);
    paintOverlayFromMask(mask, overlay);
  };

  useEffect(() => {
    const mask = maskRef.current;
    const overlay = overlayRef.current;
    if (!mask || !overlay || !width || !height) return;
    mask.width = width;
    mask.height = height;
    overlay.width = width;
    overlay.height = height;
    clearCanvas(mask, "#000000");
    clearCanvas(overlay);
    historyRef.current = [];
    redoRef.current = [];
    publishHistory();
  }, [width, height]);

  useImperativeHandle(ref, () => ({
    beginStroke(x, y, tool, size) {
      const mask = maskRef.current;
      const overlay = overlayRef.current;
      if (!mask || !overlay) return;
      snapshot();
      strokeRef.current = { tool, size, lastX: x, lastY: y, started: true };
      const maskCtx = getContext2d(mask) as CanvasRenderingContext2D;
      const overlayCtx = getContext2d(overlay) as CanvasRenderingContext2D;
      if (tool === "brush") {
        drawStamp(maskCtx, x, y, size, "#ffffff");
        drawStamp(overlayCtx, x, y, size, "rgba(225, 29, 72, 0.45)");
      } else {
        drawStamp(maskCtx, x, y, size, "#000000");
        drawStamp(overlayCtx, x, y, size, "rgba(0,0,0,1)", "destination-out");
      }
    },
    continueStroke(x, y) {
      const stroke = strokeRef.current;
      const mask = maskRef.current;
      const overlay = overlayRef.current;
      if (!stroke || !mask || !overlay) return;
      const dist = Math.hypot(x - stroke.lastX, y - stroke.lastY);
      const steps = Math.max(1, Math.ceil(dist / Math.max(1, stroke.size / 4)));
      const maskCtx = getContext2d(mask) as CanvasRenderingContext2D;
      const overlayCtx = getContext2d(overlay) as CanvasRenderingContext2D;
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const px = stroke.lastX + (x - stroke.lastX) * t;
        const py = stroke.lastY + (y - stroke.lastY) * t;
        if (stroke.tool === "brush") {
          drawStamp(maskCtx, px, py, stroke.size, "#ffffff");
          drawStamp(overlayCtx, px, py, stroke.size, "rgba(225, 29, 72, 0.45)");
        } else {
          drawStamp(maskCtx, px, py, stroke.size, "#000000");
          drawStamp(overlayCtx, px, py, stroke.size, "rgba(0,0,0,1)", "destination-out");
        }
      }
      stroke.lastX = x;
      stroke.lastY = y;
    },
    endStroke() {
      strokeRef.current = null;
    },
    undo() {
      const mask = maskRef.current;
      if (!mask || historyRef.current.length === 0) return false;
      redoRef.current.push(snapshotMaskChannel(mask));
      const prev = historyRef.current.pop();
      if (prev) applySnapshot(prev);
      publishHistory();
      return true;
    },
    redo() {
      const mask = maskRef.current;
      if (!mask || redoRef.current.length === 0) return false;
      historyRef.current.push(snapshotMaskChannel(mask));
      const next = redoRef.current.pop();
      if (next) applySnapshot(next);
      publishHistory();
      return true;
    },
    clear() {
      const mask = maskRef.current;
      const overlay = overlayRef.current;
      if (!mask || !overlay) return;
      snapshot();
      clearCanvas(mask, "#000000");
      clearCanvas(overlay);
    },
    selectAll() {
      const mask = maskRef.current;
      const overlay = overlayRef.current;
      if (!mask || !overlay) return;
      snapshot();
      clearCanvas(mask, "#ffffff");
      const overlayCtx = getContext2d(overlay) as CanvasRenderingContext2D;
      overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
      overlayCtx.fillStyle = "rgba(225, 29, 72, 0.45)";
      overlayCtx.fillRect(0, 0, overlay.width, overlay.height);
    },
    hasMask() {
      const mask = maskRef.current;
      return mask ? maskHasSelection(mask) : false;
    },
    getMaskCanvas() {
      return maskRef.current;
    },
    reset(nextWidth, nextHeight) {
      const mask = maskRef.current;
      const overlay = overlayRef.current;
      if (!mask || !overlay) return;
      mask.width = nextWidth;
      mask.height = nextHeight;
      overlay.width = nextWidth;
      overlay.height = nextHeight;
      clearCanvas(mask, "#000000");
      clearCanvas(overlay);
      historyRef.current = [];
      redoRef.current = [];
      publishHistory();
    },
  }));

  return (
    <>
      <canvas ref={maskRef} className="hidden" width={width} height={height} />
      <canvas
        ref={overlayRef}
        width={width}
        height={height}
        className="pointer-events-none absolute left-0 top-0"
        style={{ width, height, display: visible ? "block" : "none" }}
      />
      <span className="hidden" data-can-undo={canUndo} data-can-redo={canRedo} />
    </>
  );
});

export default MaskCanvas;
