import { useState, useRef, useEffect, useCallback } from 'react';
import { showToast } from '../utils/toast';
import { useIsMobile } from '../hooks/useMobile';
import { VoiceRecorder } from './VoiceRecorder';
import { TranscriptionSource } from '../services/voiceTranscriptionService';

interface InlineOpinionInputProps {
  onSubmit: (content: string) => Promise<void>;
  placeholder: string;
  variant?: 'card' | 'inline';
  submitLabel?: string;
  source?: TranscriptionSource;
}

export function InlineOpinionInput({
  onSubmit,
  placeholder,
  variant = 'inline',
  submitLabel = 'Submit',
  source,
}: InlineOpinionInputProps) {
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const isMobile = useIsMobile();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const effectiveSource: TranscriptionSource =
    source || (variant === 'card' ? 'general_opinion' : 'answer');

  // Auto-resize logic: starts ~3-4 lines, auto-grows up to ~20 lines (~440px), then scrolls
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    const lineHeight = 22; // ~22px per line
    const minLines = variant === 'card' ? (isMobile ? 3 : 4) : 2;
    const minHeight = minLines * lineHeight + 16; // including vertical padding
    const maxHeight = 20 * lineHeight + 16; // ~20 lines limit (~456px)

    const scrollHeight = textarea.scrollHeight;
    const targetHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);

    textarea.style.height = `${targetHeight}px`;
    textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [variant, isMobile]);

  useEffect(() => {
    adjustTextareaHeight();
  }, [content, adjustTextareaHeight]);

  const handleSubmit = async () => {
    if (!content.trim()) return;

    setSubmitting(true);
    try {
      await onSubmit(content);
      setContent('');
    } catch (error: any) {
      console.error('Failed to submit opinion:', error);
      if (error?.code === '23505') {
        showToast.error('You have already submitted an opinion for this case. Please edit your existing opinion instead.');
      } else {
        showToast.error('Failed to submit opinion. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleTranscriptionComplete = (text: string) => {
    console.log(`[InlineOpinionInput] handleTranscriptionComplete called with text length: ${text.length}`);
    setContent((prev) => {
      const next = prev ? prev + ' ' + text : text;
      console.log(`[InlineOpinionInput] New content length: ${next.length} chars.`);
      return next;
    });
  };

  if (variant === 'card') {
    return (
      <div className="bg-surface rounded-xl shadow-sm border border-border p-4">
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={isMobile ? 3 : 4}
            className="w-full px-3 py-2 pr-10 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent resize-none text-sm bg-bg transition-all duration-150"
            placeholder={placeholder}
          />
          <div className="absolute right-3 top-3">
            <VoiceRecorder
              onTranscriptionComplete={handleTranscriptionComplete}
              variant="card"
              source={effectiveSource}
            />
          </div>
        </div>
        <div className={`flex items-center justify-between mt-2.5`}>
          {!isMobile && <span className="text-[11px] text-text-muted">Ctrl + Enter to submit</span>}
          <button
            onClick={handleSubmit}
            disabled={submitting || !content.trim()}
            className="px-4 py-1.5 text-sm font-medium text-on-solid rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed ml-auto bg-primary-solid"
          >
            {submitting ? 'Posting...' : submitLabel}
          </button>
        </div>
      </div>
    );
  }

  // Inline variant (compact, for question answers)
  return (
    <div className="mt-3">
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          className="w-full px-3 py-2 pr-10 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent resize-none text-sm bg-bg transition-all duration-150"
          placeholder={placeholder}
        />
        <div className="absolute right-3 top-2.5">
          <VoiceRecorder
            onTranscriptionComplete={handleTranscriptionComplete}
            variant="inline"
            source={effectiveSource}
          />
        </div>
      </div>
      <div className="flex justify-end mt-1.5">
        <button
          onClick={handleSubmit}
          disabled={submitting || !content.trim()}
          className="px-3 py-1 text-xs font-medium text-on-solid rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed bg-primary-solid"
        >
          {submitting ? 'Posting...' : submitLabel}
        </button>
      </div>
    </div>
  );
}
