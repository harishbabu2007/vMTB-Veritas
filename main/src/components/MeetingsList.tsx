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
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
          <FileText className="w-3 h-3" />
          View MoM
        </span>
      );
    case 'pending':
    case 'processing':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
          <span className="w-1.5 h-1.5 bg-yellow-500 rounded-full animate-pulse" />
          MoM Generating
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
          <AlertCircle className="w-3 h-3" />
          MoM Failed
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
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
      className={`bg-white rounded-xl border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all cursor-pointer ${
        isMobile ? 'p-3' : 'p-4'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <CalendarDays className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
            <span className="text-sm font-medium text-gray-900">
              {formatDate(meeting.started_at)}
            </span>
            <span className="text-gray-300">·</span>
            <Clock className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
            <span className="text-sm text-gray-600">{formatTime(meeting.started_at)}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-500">
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
          <ChevronRight className="w-4 h-4 text-gray-400" />
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
      <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
        <p className="text-sm text-gray-500">Loading meetings...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Notification toggle */}
      <div className="flex items-center justify-between bg-white rounded-xl border border-gray-100 p-4">
        <div className="flex items-center gap-2">
          {mtb.notificationEnabled !== false ? (
            <span className="text-blue-600 text-sm">🔔</span>
          ) : (
            <span className="text-gray-400 text-sm">🔕</span>
          )}
          <span className="text-sm text-gray-700">Notify MTB members about meetings</span>
        </div>
        <button
          onClick={() => onToggleNotification(mtb.notificationEnabled === false)}
          disabled={togglingNotification}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors duration-200 disabled:opacity-50 ${
            mtb.notificationEnabled !== false ? 'bg-blue-600' : 'bg-gray-300'
          }`}
          role="switch"
          aria-checked={mtb.notificationEnabled !== false}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 mt-0.5 ${
              mtb.notificationEnabled !== false ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {/* Active Meeting Banner */}
      {activeMeeting && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4">
          <div className={`flex items-center justify-between ${isMobile ? 'flex-col gap-3' : ''}`}>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse flex-shrink-0" />
                <h3 className="text-sm font-semibold text-green-800">Meeting in Progress</h3>
              </div>
              <p className="text-xs text-green-700">
                Started {formatTimeAgo(activeMeeting.started_at)} · {activeMeeting.max_participants} participant(s)
              </p>
            </div>
            <button
              onClick={joinMeeting}
              className="flex items-center justify-center gap-2 bg-green-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-green-700 transition-colors"
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
          className={`w-full flex items-center justify-center gap-2 bg-green-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-green-700 transition-colors ${
            isMobile ? '' : ''
          }`}
        >
          <Video className="w-4 h-4" />
          Start Meeting
        </button>
      )}

      {/* Meeting History */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Past Meetings</h3>
        {historyError ? (
          <div className="bg-white rounded-xl border border-gray-100 p-6 text-center">
            <p className="text-sm text-red-500">{historyError}</p>
          </div>
        ) : meetings.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
            <Video className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-500">No meetings yet.</p>
            <p className="text-xs text-gray-400 mt-1">Start a meeting to see it appear here.</p>
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
