import { ReactNode } from 'react';
import { AlertTriangle, Lock } from 'lucide-react';
import { Modal } from './Modal';

interface VerifyModalProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading: boolean;
  title?: string;
  description?: string;
  bullets?: string[];
  /** The one consequence easiest to miss and hardest to undo: shown in its
   * own callout, not buried in the bullet list. Off for modes (like the
   * "add patient details" block) that aren't actually verifying anything. */
  showLockNotice?: boolean;
  lockNoticeText?: string;
  footerNote?: string;
  confirmLabel?: string;
  confirmingLabel?: string;
  /** Optional content (e.g. a patient-details recap) rendered above the bullet list. */
  reviewContent?: ReactNode;
}

// Verifying locks the summary; it does not by itself share the case with
// anyone. Sharing to an MTB is a separate action from Case Settings, and
// only then does an MTB's members see it.
const DEFAULT_BULLETS = [
  'Can be shared with MTBs from Case Settings',
  'Visible to MTB members once shared',
];

export function VerifyModal({
  isOpen,
  onConfirm,
  onCancel,
  isLoading,
  title = 'Verify Case Summary',
  description = 'Please review the patient details and summary below, then confirm to verify this case.',
  bullets = DEFAULT_BULLETS,
  showLockNotice = true,
  lockNoticeText = 'This case becomes permanently non-editable.',
  footerNote = 'Make sure the summary is accurate before confirming. This action cannot be undone.',
  confirmLabel = 'Verify Case',
  confirmingLabel = 'Verifying...',
  reviewContent,
}: VerifyModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onCancel} title={title}>
      <div className="space-y-5">
        {/* Warning Icon */}
        <div className="flex justify-center">
          <div className="w-12 h-12 rounded-full bg-warning-bg-strong flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-warning" />
          </div>
        </div>

        {/* Warning Text */}
        <p className="text-sm text-center text-text-muted">
          {description}
        </p>

        {/* Review content (e.g. patient details recap) */}
        {reviewContent}

        {/* The hardest-to-undo consequence, called out on its own so it
            can't be skimmed past as just another bullet. */}
        {showLockNotice && (
          <div className="flex items-start gap-3 rounded-lg border border-warning-border bg-warning-bg-strong p-3">
            <Lock className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-sm font-semibold text-warning-text">{lockNoticeText}</p>
          </div>
        )}

        {/* Other, lower-stakes bullets */}
        {bullets.length > 0 && (
          <ul className="space-y-2">
            {bullets.map((bullet) => (
              <li key={bullet} className="flex items-start gap-3">
                <span className="text-info font-bold mt-0.5">•</span>
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
            className="px-4 py-2 text-sm font-medium text-text bg-surface border border-border rounded-lg hover:bg-surface-hover transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-on-solid rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 bg-primary-solid"
          >
            {isLoading ? confirmingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
