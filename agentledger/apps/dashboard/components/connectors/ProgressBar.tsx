export function ProgressBar({ progress, label }: { progress: number; label: string }) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex justify-between text-xs text-muted">
        <span>{label}</span>
        <span>{Math.round(progress)}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-edge">
        <div
          className="h-full rounded-full bg-accent transition-all duration-300 ease-out"
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
      </div>
    </div>
  );
}
