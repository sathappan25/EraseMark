import Button from "./Button";

interface BrushControlProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

export default function BrushControl({
  value,
  onChange,
  min = 4,
  max = 160,
  step = 2,
}: BrushControlProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-slate-500 dark:text-slate-400">Brush Size</span>
      <Button variant="icon" onClick={() => onChange(Math.max(min, value - step))} aria-label="Decrease brush size">
        −
      </Button>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-28 accent-brand-600"
      />
      <Button variant="icon" onClick={() => onChange(Math.min(max, value + step))} aria-label="Increase brush size">
        +
      </Button>
      <span className="min-w-12 text-sm font-medium text-slate-800 dark:text-slate-100">{value}px</span>
    </div>
  );
}
