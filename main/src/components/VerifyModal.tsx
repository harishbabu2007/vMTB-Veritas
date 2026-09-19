import { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';

interface VerifyModalProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading: boolean;
  title?: string;
  description?: string;
  bullets?: string[];
  footerNote?: string;
  confirmLabel?: string;
  confirmingLabel?: string;
  /** Optional content (e.g. a patient-details recap) rendered above the bullet list. */
  reviewContent?: ReactNode;
}

const DEFAULT_BULLETS = [
  'Shared with selected MTBs',
  'Visible to other MTB members and experts',
  'No longer editable',
];

export function VerifyModal({
  isOpen,
  onConfirm,
  onCancel,
  isLoading,
  title = 'Verify Case Summary',
  description = 'Once you verify this case summary, it will be:',
  bullets = DEFAULT_BULLETS,
  footerNote = 'Make sure the summary is accurate before confirming. This action cannot be undone.',
  confirmLabel = 'Verify & Share',
  confirmingLabel = 'Verifying...',
  reviewContent,
}: VerifyModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onCancel} title={title}>
      <div className="space-y-5">
        {/* Warning Icon */}
        <div className="flex justify-center">
          <div className="w-12 h-12 rounded-full bg-orange-100 flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-orange-500" />
          </div>
        </div>

        {/* Warning Text */}
        <p className="text-sm text-center text-text-muted">
          {description}
        </p>

        {/* Review content (e.g. patient details recap) */}
        {reviewContent}

        {/* Bullet List */}
        {bullets.length > 0 && (
          <ul className="space-y-2">
            {bullets.map((bullet) => (
              <li key={bullet} className="flex items-start gap-3">
                <span className="text-blue-500 font-bold mt-0.5">•</span>
                <span className="text-sm text-text-muted">
                  {bullet}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* Footer Note */}
        <p className="text-xs text-center text-text-muted">
          {footerNote}
        </p>

        {/* Actions */}
        <div className="flex gap-3 justify-end pt-2 border-t border-border">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-text bg-surface border border-border rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 bg-primary"
          >
            {isLoading ? confirmingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
