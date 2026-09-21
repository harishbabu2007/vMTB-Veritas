import { useState, useRef, useEffect } from 'react';
import { Reply, ThumbsUp } from 'lucide-react';
import { Opinion } from '../context/CasesContext';
import { showToast } from '../utils/toast';
import { VoiceRecorder } from './VoiceRecorder';

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.max(0, now - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface OpinionCommentProps {
  opinion: Opinion;
  allOpinions: Opinion[];
  depth: number;
  onReply: (parentId: string, questionId: string | null, content: string) => Promise<void>;
  currentUserId: string | undefined;
  canReply: boolean;
  ownerId?: string;
  compact?: boolean;
}

export function OpinionComment({
  opinion,
  allOpinions,
  depth,
  onReply,
  currentUserId,
  canReply,
  ownerId,
  compact,
}: OpinionCommentProps) {
  const [showReplyInput, setShowReplyInput] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [liked, setLiked] = useState(false);
  const replyTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const isOwnOpinion = opinion.authorUserId === currentUserId;
  const isCaseOwner = opinion.authorUserId === ownerId;

  const authorLabel = isOwnOpinion ? 'You' : isCaseOwner ? 'Case Owner' : `Anonymous ${opinion.authorUserId?.slice(-2) || ''}`;

  // Auto-resize reply textarea up to ~20 lines
  useEffect(() => {
    if (!showReplyInput) return;
    const textarea = replyTextareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    const lineHeight = 20; // ~20px per line
    const minHeight = 2 * lineHeight + 16;
    const maxHeight = 20 * lineHeight + 16; // ~20 lines limit (~416px)

    const scrollHeight = textarea.scrollHeight;
    const targetHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);

    textarea.style.height = `${targetHeight}px`;
    textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [replyText, showReplyInput]);

  // Get replies to this opinion
  const replies = allOpinions
    .filter(o => o.parentId === opinion.id)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const handleSubmitReply = async () => {
    if (!replyText.trim()) return;
    setSubmitting(true);
    try {
      await onReply(opinion.id, opinion.questionId, replyText);
      setReplyText('');
      setShowReplyInput(false);
    } catch (error: any) {
      console.error('Failed to submit reply:', error);
      if (error?.code === '23505') {
        showToast.error('You have already submitted an opinion for this case. Please edit your existing opinion instead.');
      } else {
        showToast.error('Failed to submit reply. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleTranscriptionComplete = (text: string) => {
    console.log(`[OpinionComment] handleTranscriptionComplete called for reply with text length: ${text.length}`);
    setReplyText((prev) => (prev ? prev + ' ' + text : text));
  };

  const marginLeft = depth > 0 ? 20 : 0;

  return (
    <div style={{ marginLeft: `${marginLeft}px` }}>
      <div className={`${compact ? 'py-2' : depth === 0 ? 'bg-surface rounded-xl shadow-sm border border-border p-4' : 'pl-4 py-3 border-l-2 border-info-border'}`}>
        {/* Author and timestamp */}
        <div className="flex items-center gap-2 mb-1.5">
          {/* Intentionally NOT a real-photo Avatar: authorLabel is anonymized
              ("You"/"Case Owner"/"Anonymous XX"), and showing the real profile
              photo here would deanonymize case discussions. */}
          <div className="w-6 h-6 rounded-full bg-info-bg-strong flex items-center justify-center flex-shrink-0">
            <span className="text-[10px] font-bold text-info">{authorLabel.charAt(0).toUpperCase()}</span>
          </div>
          <span className="text-sm font-semibold text-text">{authorLabel}</span>
          {isCaseOwner && !isOwnOpinion && (
            <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-info-bg text-info">Owner</span>
          )}
          <span className="text-xs text-text-subtle">{timeAgo(opinion.createdAt)}</span>
        </div>

        {/* Content */}
        <p className={`text-text whitespace-pre-wrap leading-relaxed ${compact ? 'text-xs' : 'text-sm'} ml-8`}>{opinion.content}</p>

        {/* Actions */}
        <div className="flex items-center gap-4 mt-2 ml-8">
          <button
            onClick={() => setLiked(!liked)}
            className={`flex items-center gap-1 text-xs transition-colors ${liked ? 'text-info' : 'text-text-subtle hover:text-info'}`}
          >
            <ThumbsUp className="w-3 h-3" />
            <span>Like</span>
          </button>
          {canReply && (
            <button
              onClick={() => setShowReplyInput(!showReplyInput)}
              className="flex items-center gap-1 text-xs text-text-subtle hover:text-info transition-colors"
            >
              <Reply className="w-3 h-3" />
              <span>Reply</span>
            </button>
          )}
          {replies.length > 0 && (
            <span className="text-xs text-text-subtle">
              {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
            </span>
          )}
        </div>

        {/* Inline Reply Input */}
        {showReplyInput && (
          <div className="mt-3 ml-8 space-y-2">
            <div className="relative">
              <textarea
                ref={replyTextareaRef}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                rows={2}
                className="w-full px-3 py-2 pr-10 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent resize-none bg-bg transition-all duration-150"
                placeholder="Write your reply..."
                autoFocus
              />
              <div className="absolute right-3 top-2.5">
                <VoiceRecorder
                  onTranscriptionComplete={handleTranscriptionComplete}
                  variant="inline"
                  source="reply"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSubmitReply}
                disabled={submitting || !replyText.trim()}
                className="px-3 py-1.5 text-xs font-medium text-on-solid rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed bg-primary-solid"
              >
                {submitting ? 'Posting...' : 'Reply'}
              </button>
              <button
                onClick={() => { setShowReplyInput(false); setReplyText(''); }}
                className="px-3 py-1.5 text-xs font-medium border border-border rounded-lg text-text-muted hover:bg-surface-hover transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Nested Replies — inside the card so they're contained */}
        {replies.length > 0 && (
          <div className="mt-3">
            {replies.map((reply) => (
              <OpinionComment
                key={reply.id}
                opinion={reply}
                allOpinions={allOpinions}
                depth={depth + 1}
                onReply={onReply}
                currentUserId={currentUserId}
                canReply={canReply}
                ownerId={ownerId}
                compact={compact}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
