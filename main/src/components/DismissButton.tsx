import { X } from 'lucide-react';

interface DismissButtonProps {
  onClick: () => void;
  label?: string;
  className?: string;
}

// The close (×) control for inline notices and error messages. Inherits the
// notice's text colour so it reads on any tone.
export function DismissButton({ onClick, label = 'Dismiss', className = '' }: DismissButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex-shrink-0 -m-1 p-1 rounded-md opacity-60 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-current ${className}`}
    >
      <X className="w-4 h-4" aria-hidden="true" />
    </button>
  );
}
