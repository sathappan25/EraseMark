import { useEffect, useRef, type Ref, type RefObject } from "react";
import type { EditorTool } from "../types";
import { clamp, pointerToCanvasPoint } from "../utils/canvas";
import MaskCanvas, { type MaskCanvasHandle } from "./MaskCanvas";
import BeforeAfter from "./BeforeAfter";

export type EditorView = "edit" | "compare" | "original" | "restored" | "mask";

interface CanvasEditorProps {
  width: number;
  height: number;
  imageCanvas: HTMLCanvasElement | null;
  restoredCanvas: HTMLCanvasElement | null;
  maskRef: RefObject<MaskCanvasHandle | null>;
  tool: EditorTool;
  brushSize: number;
  zoom: number;
  panX: number;
  panY: number;
  view: EditorView;
  spacePan?: boolean;
  onPanChange: (panX: number, panY: number) => void;
  onZoomChange: (zoom: number, panX: number, panY: number) => void;
  onHistoryChange?: (state: { canUndo: boolean; canRedo: boolean }) => void;
}

export default function CanvasEditor({
  width,
  height,
  imageCanvas,
  restoredCanvas,
  maskRef,
  tool,
  brushSize,
  zoom,
  panX,
  panY,
  view,
  spacePan = false,
  onPanChange,
  onZoomChange,
  onHistoryChange,
}: CanvasEditorProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const displayRef = useRef<HTMLCanvasElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const painting = useRef(false);
  const panning = useRef(false);
  const lastPan = useRef({ x: 0, y: 0 });
  const pinch = useRef<{ distance: number; zoom: number; panX: number; panY: number } | null>(null);

  useEffect(() => {
    const display = displayRef.current;
    if (!display || !imageCanvas) return;
    display.width = width;
    display.height = height;
    const ctx = display.getContext("2d");
    if (!ctx) return;
    const source =
      (view === "restored" || view === "compare") && restoredCanvas ? restoredCanvas : imageCanvas;
    if (view === "original") {
      ctx.drawImage(imageCanvas, 0, 0);
      return;
    }
    ctx.drawImage(source, 0, 0);
  }, [imageCanvas, restoredCanvas, view, width, height]);

  const isPanMode = tool === "pan" || spacePan;

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    const display = displayRef.current;
    if (!viewport || !display) return;
    viewport.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size === 2) {
      painting.current = false;
      panning.current = false;
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        zoom,
        panX,
        panY,
      };
      return;
    }

    if (event.button === 1 || isPanMode || view !== "edit") {
      panning.current = true;
      lastPan.current = { x: event.clientX, y: event.clientY };
      return;
    }

    const point = pointerToCanvasPoint(event, display);
    if (!point) return;
    painting.current = true;
    maskRef.current?.beginStroke(point.x, point.y, tool === "eraser" ? "eraser" : "brush", brushSize);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointers.current.has(event.pointerId)) {
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    if (pointers.current.size === 2 && pinch.current && viewportRef.current) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const scale = distance / Math.max(1, pinch.current.distance);
      const nextZoom = clamp(pinch.current.zoom * scale, 0.25, 4);
      onZoomChange(nextZoom, pinch.current.panX, pinch.current.panY);
      return;
    }

    if (panning.current) {
      onPanChange(panX + (event.clientX - lastPan.current.x), panY + (event.clientY - lastPan.current.y));
      lastPan.current = { x: event.clientX, y: event.clientY };
      return;
    }

    if (!painting.current || view !== "edit" || !displayRef.current) return;
    const point = pointerToCanvasPoint(event, displayRef.current);
    if (!point) return;
    maskRef.current?.continueStroke(point.x, point.y);
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (painting.current) maskRef.current?.endStroke();
    painting.current = false;
    panning.current = false;
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const imageX = (cursorX - panX) / zoom;
      const imageY = (cursorY - panY) / zoom;
      const factor = event.deltaY > 0 ? 0.9 : 1.1;
      const nextZoom = clamp(zoom * factor, 0.25, 4);
      onZoomChange(nextZoom, cursorX - imageX * nextZoom, cursorY - imageY * nextZoom);
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [zoom, panX, panY, onZoomChange]);

  return (
    <div
      ref={viewportRef}
      className={`checkerboard relative h-full w-full overflow-hidden ${isPanMode ? "cursor-grab" : "cursor-crosshair"}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
    >
      <div
        style={{
          transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
          transformOrigin: "0 0",
          width,
          height,
          position: "relative",
        }}
      >
        {view === "compare" && imageCanvas && restoredCanvas ? (
          <BeforeAfter before={imageCanvas} after={restoredCanvas} width={width} height={height} />
        ) : (
          <canvas
            ref={displayRef}
            width={width}
            height={height}
            className="block"
            style={{ width, height }}
          />
        )}
        <MaskCanvas
          ref={maskRef as Ref<MaskCanvasHandle>}
          width={width}
          height={height}
          visible={view === "edit" || view === "mask"}
          onHistoryChange={onHistoryChange}
        />
      </div>
    </div>
  );
}
