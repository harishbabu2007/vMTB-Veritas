import { useState } from 'react';
import { MessageSquare, Reply, ChevronDown, ChevronUp } from 'lucide-react';
import { Opinion } from '../context/CasesContext';
import { useIsMobile } from '../hooks/useMobile';

interface OpinionThreadProps {
  opinion: Opinion;
  replies: Opinion[];
  depth: number;
  onReply: (parentId: string, questionId: string | null) => void;
  onExpand: (opinionId: string) => void;
  isOwner: boolean;
  currentUserId: string | undefined;
}

export function OpinionThread({
  opinion,
  replies,
  depth,
  onReply,
  onExpand,
  isOwner,
  currentUserId,
}: OpinionThreadProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [showFullContent, setShowFullContent] = useState(false);
  const isMobile = useIsMobile();

  const isLongContent = opinion.content.length > 200;
  const displayContent = showFullContent || !isLongContent 
    ? opinion.content 
    : opinion.content.substring(0, 200) + '...';

  const formattedDate = new Date(opinion.createdAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const isOwnOpinion = opinion.authorUserId === currentUserId;

  return (
    <div className={`${depth > 0 ? (isMobile ? 'ml-3 mt-2' : 'ml-8 mt-3') : 'mt-4'}`}>
      <div className={`border rounded-lg bg-surface hover:shadow-md transition-shadow ${isMobile ? 'p-3' : 'p-4'} ${
        depth > 0 ? 'border-l-4 border-l-blue-300' : 'border-border'
      }`}>
        {/* Header */}
        <div className={`flex items-center justify-between mb-2 ${isMobile ? 'flex-wrap gap-1' : ''}`}>
          <div className="flex items-center space-x-2">
            <MessageSquare className={`text-info ${isMobile ? 'w-3.5 h-3.5' : 'w-4 h-4'}`} />
            <span className={`font-medium text-text ${isMobile ? 'text-xs' : 'text-sm'}`}>
              {isOwnOpinion ? 'You' : 'Expert'}
            </span>
            {isOwnOpinion && (
              <span className={`bg-info-bg-strong text-info-text rounded ${isMobile ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'}`}>Your Opinion</span>
            )}
          </div>
          <p className={`text-text-subtle ${isMobile ? 'text-[10px]' : 'text-xs'}`}>{formattedDate}</p>
        </div>

        {/* Content */}
        <p className={`text-text-muted whitespace-pre-wrap mb-3 ${isMobile ? 'text-xs' : 'text-sm'}`}>{displayContent}</p>
        
        {/* Show More/Less */}
        {isLongContent && (
          <button
            onClick={() => setShowFullContent(!showFullContent)}
            className={`text-info hover:text-info-text mb-2 flex items-center space-x-1 ${isMobile ? 'text-[10px]' : 'text-xs'}`}
          >
            <span>{showFullContent ? 'Show less' : 'Show more'}</span>
            {showFullContent ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        )}

        {/* Actions */}
        <div className={`flex items-center space-x-3 ${isMobile ? 'text-[10px]' : 'text-xs'}`}>
          {/* Everyone can reply */}
          <button
            onClick={() => onReply(opinion.id, opinion.questionId)}
            className="flex items-center space-x-1 text-text-muted hover:text-info transition-colors"
          >
            <Reply className="w-3 h-3" />
            <span>Reply</span>
          </button>
          
          {replies.length > 0 && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="flex items-center space-x-1 text-text-muted hover:text-text transition-colors"
            >
              {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              <span>{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Nested Replies */}
      {isExpanded && replies.length > 0 && (
        <div className="mt-2">
          {replies.map((reply) => (
            <OpinionThreadContainer
              key={reply.id}
              opinionId={reply.id}
              allOpinions={[]} // Will be passed from parent
              depth={depth + 1}
              onReply={onReply}
              onExpand={onExpand}
              isOwner={isOwner}
              currentUserId={currentUserId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Container component to fetch replies for an opinion
interface OpinionThreadContainerProps {
  opinionId: string;
  allOpinions: Opinion[];
  depth: number;
  onReply: (parentId: string, questionId: string | null) => void;
  onExpand: (opinionId: string) => void;
  isOwner: boolean;
  currentUserId: string | undefined;
}

export function OpinionThreadContainer({
  opinionId,
  allOpinions,
  depth,
  onReply,
  onExpand,
  isOwner,
  currentUserId,
}: OpinionThreadContainerProps) {
  const opinion = allOpinions.find(o => o.id === opinionId);
  if (!opinion) return null;

  const replies = allOpinions
    .filter(o => o.parentId === opinionId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  return (
    <OpinionThread
      opinion={opinion}
      replies={replies}
      depth={depth}
      onReply={onReply}
      onExpand={onExpand}
      isOwner={isOwner}
      currentUserId={currentUserId}
    />
  );
}
