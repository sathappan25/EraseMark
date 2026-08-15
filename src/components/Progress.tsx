interface ProgressProps {
  label: string;
  detail?: string;
}

export default function Progress({ label, detail }: ProgressProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-slate-900/45 p-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-card dark:bg-slate-900">
        <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-brand-600" />
        </div>
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{label}</p>
        {detail ? <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{detail}</p> : null}
      </div>
    </div>
  );
}
