import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, FlaskConical, Plus, Users, Video } from 'lucide-react';
import { Layout } from '../components/Layout';
import { useOnboarding } from '../context/OnboardingContext';
import { useIsMobile } from '../hooks/useMobile';
import { useTourGroup } from '../hooks/useTourGroup';
import { showToast } from '../utils/toast';
import { SAMPLE_BOARD } from '../onboarding/sampleCase';

// The walkthrough's sample board: a look-alike of a board page so a new user,
// who has no board yet, can see where Add Case and Meeting are.
//
// Deliberately has no meeting code at all: no MeetingService, no meeting
// URL, no window.open. Its buttons only say it's a sample. Starting a
// meeting boots a billable VM and GPU services, so it must never be
// reachable from here.

export function SampleBoard() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { mtbSectionRunning } = useOnboarding();
  const runningOnArrival = useRef(mtbSectionRunning);

  // Only reachable from the walkthrough's MTB section (a refresh restarts
  // that section on the MTBs page). Checked on arrival only, so finishing the
  // section here doesn't bounce the user while the tour's last button is
  // taking them somewhere else.
  useEffect(() => {
    if (!runningOnArrival.current) navigate('/mtbs', { replace: true });
  }, [navigate]);

  useTourGroup('sample_board', mtbSectionRunning);

  const sampleOnly = () => showToast.success('This is a sample board. On your own board, this works for real.');

  const buttonSize = isMobile ? 'px-3 py-2 text-sm' : 'px-4 py-2';

  return (
    <Layout wide>
      <div className={isMobile ? 'space-y-4' : 'space-y-6'}>
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg border border-border bg-status-pending-bg text-sm text-status-pending-text">
          <FlaskConical className="w-4 h-4 flex-shrink-0" />
          <span>This is a sample board, to show you around.</span>
        </div>

        <div className={`bg-surface rounded-xl shadow-sm border border-border ${isMobile ? 'p-4 space-y-3' : 'p-6'}`}>
          <div className={`flex ${isMobile ? 'flex-col gap-3' : 'justify-between items-center'}`}>
            <div className="flex-1">
              <h1 className={`font-bold text-text mb-2 ${isMobile ? 'text-lg' : 'text-2xl'}`}>{SAMPLE_BOARD.name}</h1>
              <div className="flex items-center gap-4 flex-wrap text-sm text-text-muted">
                <div className="flex items-center gap-1.5">
                  <Users className="w-4 h-4 text-gray-400" />
                  <span className="font-medium">{SAMPLE_BOARD.experts}</span>
                  <span>Experts</span>
                </div>
                <span className="text-gray-300">•</span>
                <div className="flex items-center gap-1.5">
                  <FileText className="w-4 h-4 text-gray-400" />
                  <span className="font-medium">{SAMPLE_BOARD.cases.length}</span>
                  <span>Cases</span>
                </div>
                <span className="text-gray-300">•</span>
                <div data-tour="mtb-invite" className="flex items-center gap-2">
                  <span>Invite Code:</span>
                  <code className="font-mono font-semibold text-sm px-2 py-0.5 bg-status-processing-bg rounded border border-blue-200 dark:border-blue-900 text-primary">
                    {SAMPLE_BOARD.inviteCode}
                  </code>
                </div>
              </div>
            </div>
            <div className={`flex items-center ${isMobile ? 'w-full justify-end gap-2' : 'gap-3'}`}>
              <button
                type="button"
                onClick={sampleOnly}
                data-tour="mtb-meeting"
                className={`flex items-center justify-center gap-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors ${buttonSize}`}
              >
                <Video className="w-4 h-4" />
                <span>Meeting</span>
              </button>
              <button
                type="button"
                onClick={sampleOnly}
                data-tour="mtb-add-case"
                className={`flex items-center justify-center gap-2 text-white rounded-lg hover:opacity-90 transition-opacity bg-primary ${buttonSize}`}
              >
                <Plus className="w-4 h-4" />
                <span>{isMobile ? 'Add' : 'Add Case'}</span>
              </button>
            </div>
          </div>
        </div>

        <div className="bg-surface rounded-xl shadow-sm border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border">
              <thead className="bg-bg">
                <tr>
                  {['Case Name', 'Cancer Type', 'Status', 'Opinions', 'Owner'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wider whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="bg-surface divide-y divide-border">
                {SAMPLE_BOARD.cases.map(c => (
                  <tr key={c.id}>
                    <td className="px-4 py-3 text-sm font-medium text-text whitespace-nowrap">{c.caseName}</td>
                    <td className="px-4 py-3 text-sm text-text-muted whitespace-nowrap">{c.cancerType}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-status-processing-bg text-status-processing-text">
                        Not reviewed
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-text-muted">{c.opinions}</td>
                    <td className="px-4 py-3 text-sm text-text-muted whitespace-nowrap">{c.owner}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Layout>
  );
}
