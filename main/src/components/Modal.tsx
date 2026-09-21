import { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  size?: 'default' | 'large';
}

export function Modal({ isOpen, onClose, title, children, size = 'default' }: ModalProps) {
  if (!isOpen) return null;

  const sizeClasses = size === 'large' 
    ? 'sm:max-w-[80vw] sm:w-[80vw]' 
    : 'sm:max-w-lg sm:w-full';

  const modalContent = (
    <div className="fixed inset-0 z-[99999] flex items-center justify-center px-4" aria-labelledby="modal-title" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-overlay"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Dialog - Mobile responsive */}
      <div className={`relative z-[100000] bg-surface rounded-xl shadow-xl w-full max-h-[90vh] flex flex-col
        ${sizeClasses}
        max-[640px]:mx-2 max-[640px]:max-w-[calc(100%-1rem)] max-[640px]:rounded-lg
      `}>
        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-border flex-shrink-0 max-[640px]:px-4 max-[640px]:py-3">
          <h3 id="modal-title" className="text-lg font-medium text-text max-[640px]:text-base">{title}</h3>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text transition-colors p-1"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body - Scrollable */}
        <div className={`bg-surface flex-1 overflow-y-auto`}>
          <div className="px-6 py-4 max-[640px]:px-4 max-[640px]:py-3">
            {children}
          </div>
        </div>
      </div>
    </div>
  );

  // Render via portal to avoid parent stacking/overflow issues
  return createPortal(modalContent, document.body);
}
