import type { ReactNode } from "react";
import type { EditorTool } from "../types";
import Button from "./Button";

interface ToolbarProps {
  tool: EditorTool;
  onToolChange: (tool: EditorTool) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  onSelectAll: () => void;
  onRestore: () => void;
  restoreDisabled?: boolean;
  extra?: ReactNode;
}

function ToolButton({
  active,
  onClick,
  children,
  title,
}: {
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  title: string;
}) {
  return (
    <Button
      variant={active ? "primary" : "secondary"}
      onClick={onClick}
      title={title}
      className="min-w-[72px]"
    >
      {children}
    </Button>
  );
}

export default function Toolbar({
  tool,
  onToolChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClear,
  onSelectAll,
  onRestore,
  restoreDisabled,
  extra,
}: ToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ToolButton active={tool === "brush"} onClick={() => onToolChange("brush")} title="Brush">
        Brush
      </ToolButton>
      <ToolButton active={tool === "eraser"} onClick={() => onToolChange("eraser")} title="Eraser">
        Eraser
      </ToolButton>
      <ToolButton active={tool === "pan"} onClick={() => onToolChange("pan")} title="Pan">
        Hand
      </ToolButton>
      {extra}
      <div className="mx-1 hidden h-6 w-px bg-slate-200 dark:bg-slate-700 sm:block" />
      <Button onClick={onUndo} disabled={!canUndo}>
        Undo
      </Button>
      <Button onClick={onRedo} disabled={!canRedo}>
        Redo
      </Button>
      <Button onClick={onClear}>Clear Selection</Button>
      <Button onClick={onSelectAll}>Select All</Button>
      <Button variant="primary" onClick={onRestore} disabled={restoreDisabled}>
        Clean Selected Area
      </Button>
    </div>
  );
}
