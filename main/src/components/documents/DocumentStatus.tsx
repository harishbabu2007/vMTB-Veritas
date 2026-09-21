import { AlertTriangle, Loader2, RotateCw } from 'lucide-react';

export function DocumentLoading({ label = 'Opening document…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-sm text-text-muted" role="status">
      <Loader2 className="w-6 h-6 animate-spin text-primary" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function DocumentError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 px-6 text-center" role="alert">
      <AlertTriangle className="w-6 h-6 text-warning" aria-hidden="true" />
      <p className="text-sm max-w-md text-text-muted">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border border-border text-text bg-surface hover:bg-surface-hover transition-colors"
        >
          <RotateCw className="w-4 h-4" aria-hidden="true" />
          Try again
        </button>
      )}
    </div>
  );
}
