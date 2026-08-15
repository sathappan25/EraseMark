import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

interface BeforeAfterProps {
  before: HTMLCanvasElement;
  after: HTMLCanvasElement;
  width: number;
  height: number;
}

export default function BeforeAfter({ before, after, width, height }: BeforeAfterProps) {
  const [position, setPosition] = useState(50);
  const frameRef = useRef<HTMLDivElement>(null);
  const beforeRef = useRef<HTMLCanvasElement>(null);
  const afterRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const beforeCanvas = beforeRef.current;
    const afterCanvas = afterRef.current;
    if (!beforeCanvas || !afterCanvas) return;
    beforeCanvas.width = width;
    beforeCanvas.height = height;
    afterCanvas.width = width;
    afterCanvas.height = height;
    beforeCanvas.getContext("2d")?.drawImage(before, 0, 0);
    afterCanvas.getContext("2d")?.drawImage(after, 0, 0);
  }, [after, before, height, width]);

  const updateFromEvent = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = ((event.clientX - rect.left) / rect.width) * 100;
    setPosition(Math.min(100, Math.max(0, next)));
  };

  return (
    <div
      ref={frameRef}
      className="relative overflow-hidden"
      style={{ width, height, touchAction: "none" }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        updateFromEvent(event);
      }}
      onPointerMove={(event) => {
        if (event.buttons === 0) return;
        updateFromEvent(event);
      }}
    >
      <canvas ref={beforeRef} className="absolute left-0 top-0 block" style={{ width, height }} />
      <canvas
        ref={afterRef}
        className="absolute left-0 top-0 block"
        style={{ width, height, clipPath: `inset(0 ${100 - position}% 0 0)` }}
      />
      <div className="absolute inset-y-0 z-10 w-0.5 bg-white shadow" style={{ left: `${position}%` }}>
        <div className="absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white text-[10px] font-semibold text-slate-700 shadow">
          ⟷
        </div>
      </div>
      <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-white">
        Before
      </div>
      <div className="pointer-events-none absolute right-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-white">
        After
      </div>
    </div>
  );
}
