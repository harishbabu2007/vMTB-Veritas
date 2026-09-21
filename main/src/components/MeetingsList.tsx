import { useNavigate } from 'react-router-dom';
import { CalendarDays, Clock, Users, Video, AlertCircle, FileText, ChevronRight } from 'lucide-react';
import { useActiveMeeting } from '../hooks/useActiveMeeting';
import { useMeetingHistory, MeetingHistoryItem } from '../hooks/useMeetingHistory';
import { buildMeetingUrl } from '../utils/roomName';
import { useIsMobile } from '../hooks/useMobile';

interface MeetingsListProps {
  mtbId: string;
  mtb: { id: string; name: string; notificationEnabled?: boolean };
  onToggleNotification: (enabled: boolean) => void;
  togglingNotification: boolean;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatTimeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function MomStatusBadge({ status }: { status: MeetingHistoryItem['mom_status'] }) {
  switch (status) {
    case 'completed':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-success-bg-strong text-success">
          <FileText className="w-3 h-3" />
          View MoM
        </span>
      );
    case 'pending':
    case 'processing':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-warning-bg-strong text-warning-text">
          <span className="w-1.5 h-1.5 bg-warning-solid rounded-full animate-pulse" />
          MoM Generating
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-danger-bg-strong text-danger-text">
          <AlertCircle className="w-3 h-3" />
          MoM Failed
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-surface-muted text-text-subtle">
          No transcript
        </span>
      );
  }
}

function MeetingCard({ meeting, mtbId }: { meeting: MeetingHistoryItem; mtbId: string }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  return (
    <div
      onClick={() => navigate(`/mtb/${mtbId}/meeting/${meeting.id}`)}
      className={`bg-surface rounded-xl border border-border hover:border-info-border hover:shadow-sm transition-all cursor-pointer ${
        isMobile ? 'p-3' : 'p-4'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <CalendarDays className="w-3.5 h-3.5 text-text-faint flex-shrink-0" />
            <span className="text-sm font-medium text-text">
              {formatDate(meeting.started_at)}
            </span>
            <span className="text-text-faint">·</span>
            <Clock className="w-3.5 h-3.5 text-text-faint flex-shrink-0" />
            <span className="text-sm text-text-muted">{formatTime(meeting.started_at)}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-text-subtle">
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDuration(meeting.total_duration_seconds)}
            </span>
            <span className="flex items-center gap-1">
              <Users className="w-3 h-3" />
              {meeting.max_participants} joined
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <MomStatusBadge status={meeting.mom_status} />
          <ChevronRight className="w-4 h-4 text-text-faint" />
        </div>
      </div>
    </div>
  );
}

export function MeetingsList({ mtbId, mtb, onToggleNotification, togglingNotification }: MeetingsListProps) {
  const { activeMeeting, loading: activeLoading } = useActiveMeeting(mtbId);
  const { meetings, loading: historyLoading, error: historyError } = useMeetingHistory(mtbId);
  const isMobile = useIsMobile();

  const joinMeeting = () => {
    if (!mtb) return;
    const url = buildMeetingUrl(mtb);
    window.open(url, '_blank');
  };

  const startMeeting = () => {
    if (!mtb) return;
    const url = buildMeetingUrl(mtb);
    window.open(url, '_blank');
  };

  if (activeLoading || historyLoading) {
    return (
      <div className="bg-surface rounded-xl border border-border p-8 text-center">
        <p className="text-sm text-text-subtle">Loading meetings...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Notification toggle */}
      <div className="flex items-center justify-between bg-surface rounded-xl border border-border p-4">
        <div className="flex items-center gap-2">
          {mtb.notificationEnabled !== false ? (
            <span className="text-info text-sm">🔔</span>
          ) : (
            <span className="text-text-subtle text-sm">🔕</span>
          )}
          <span className="text-sm text-text-muted">Notify MTB members about meetings</span>
        </div>
        <button
          onClick={() => onToggleNotification(mtb.notificationEnabled === false)}
          disabled={togglingNotification}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors duration-200 disabled:opacity-50 ${
            mtb.notificationEnabled !== false ? 'bg-info-solid' : 'bg-border-strong'
          }`}
          role="switch"
          aria-checked={mtb.notificationEnabled !== false}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-on-solid shadow transition duration-200 mt-0.5 ${
              mtb.notificationEnabled !== false ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {/* Active Meeting Banner */}
      {activeMeeting && (
        <div className="bg-success-bg border border-success-border rounded-xl p-4">
          <div className={`flex items-center justify-between ${isMobile ? 'flex-col gap-3' : ''}`}>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="w-2 h-2 bg-success-solid rounded-full animate-pulse flex-shrink-0" />
                <h3 className="text-sm font-semibold text-success-text">Meeting in Progress</h3>
              </div>
              <p className="text-xs text-success">
                Started {formatTimeAgo(activeMeeting.started_at)} · {activeMeeting.max_participants} participant(s)
              </p>
            </div>
            <button
              onClick={joinMeeting}
              className="flex items-center justify-center gap-2 bg-success-solid text-on-solid rounded-lg px-4 py-2 text-sm font-medium hover:bg-success-solid-hover transition-colors"
            >
              <Video className="w-4 h-4" />
              Join Meeting
            </button>
          </div>
        </div>
      )}

      {/* Start Meeting button (when no active meeting) */}
      {!activeMeeting && (
        <button
          onClick={startMeeting}
          className={`w-full flex items-center justify-center gap-2 bg-success-solid text-on-solid rounded-xl py-3 text-sm font-medium hover:bg-success-solid-hover transition-colors ${
            isMobile ? '' : ''
          }`}
        >
          <Video className="w-4 h-4" />
          Start Meeting
        </button>
      )}

      {/* Meeting History */}
      <div>
        <h3 className="text-sm font-semibold text-text-muted mb-3">Past Meetings</h3>
        {historyError ? (
          <div className="bg-surface rounded-xl border border-border p-6 text-center">
            <p className="text-sm text-danger">{historyError}</p>
          </div>
        ) : meetings.length === 0 ? (
          <div className="bg-surface rounded-xl border border-border p-8 text-center">
            <Video className="w-8 h-8 text-text-faint mx-auto mb-2" />
            <p className="text-sm text-text-subtle">No meetings yet.</p>
            <p className="text-xs text-text-subtle mt-1">Start a meeting to see it appear here.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {meetings.map((meeting) => (
              <MeetingCard key={meeting.id} meeting={meeting} mtbId={mtbId} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
