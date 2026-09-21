import { useState } from 'react';
import { Modal } from './Modal';
import { useIsMobile } from '../hooks/useMobile';
import { showToast } from '../utils/toast';

interface OpinionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (content: string) => Promise<void>;
  title: string;
  placeholder?: string;
  initialContent?: string;
}

export function OpinionModal({
  isOpen,
  onClose,
  onSubmit,
  title,
  placeholder = 'Share your opinion...',
  initialContent = '',
}: OpinionModalProps) {
  const [content, setContent] = useState(initialContent);
  const [submitting, setSubmitting] = useState(false);
  const isMobile = useIsMobile();

  const handleSubmit = async () => {
    if (!content.trim()) return;
    
    setSubmitting(true);
    try {
      await onSubmit(content);
      setContent('');
      onClose();
    } catch (error) {
      console.error('Failed to submit opinion:', error);
      showToast.error('Failed to submit opinion. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setContent('');
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={title}>
      <div className="space-y-4">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={isMobile ? 6 : 8}
          className={`w-full px-3 py-2 border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary ${isMobile ? 'text-sm' : ''}`}
          placeholder={placeholder}
          autoFocus
        />

        <div className={`flex ${isMobile ? 'flex-col-reverse gap-2' : 'justify-end space-x-3'}`}>
          <button
            onClick={handleClose}
            disabled={submitting}
            className={`border border-border rounded-md text-text-muted hover:bg-surface-hover transition-colors disabled:opacity-50 ${isMobile ? 'w-full py-2.5 text-sm' : 'px-4 py-2'}`}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !content.trim()}
            className={`bg-primary-solid text-on-solid rounded-md hover:bg-primary-solid-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${isMobile ? 'w-full py-2.5 text-sm' : 'px-6 py-2'}`}
          >
            {submitting ? 'Submitting...' : 'Submit Opinion'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
