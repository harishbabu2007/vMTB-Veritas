import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, Copy, Check, LogOut, Video, Pencil, Users, FileText } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Modal } from '../components/Modal';
import { MeetingsList } from '../components/MeetingsList';
import { useCases, Case } from '../context/CasesContext';
import { supabase } from '../Supabase/client';
import { useAuth } from '../context/AuthContext';
import { showToast } from '../utils/toast';
import { useIsMobile } from '../hooks/useMobile';
import { useTourGroup } from '../hooks/useTourGroup';
import { getMtbCaseStatusMeta } from '../utils/summaryStatus';
import { useActiveMeeting } from '../hooks/useActiveMeeting';
import { buildMeetingUrl } from '../utils/roomName';

type MTBDetailTab = 'cases' | 'meetings';

export function MTBDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { cases, mtbs, mtbsLoading, addCaseToMTB, leaveMTB, updateMTBName, updateMTBNotification } = useCases();
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState<MTBDetailTab>('cases');
  const [showAddCaseModal, setShowAddCaseModal] = useState(false);
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [mtbCases, setMtbCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(false);
  const loadedMtbIdRef = useRef<string | null>(null);
  const [addingCases, setAddingCases] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reviewedSet, setReviewedSet] = useState<Set<string>>(new Set());
  const [opinionCounts, setOpinionCounts] = useState<Record<string, number>>({});
  const [statsLoading, setStatsLoading] = useState(false);
  const [leavingMTB, setLeavingMTB] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [newMtbName, setNewMtbName] = useState('');
  const [renamingMTB, setRenamingMTB] = useState(false);
  const [showLeaveConfirmModal, setShowLeaveConfirmModal] = useState(false);
  const [togglingNotification, setTogglingNotification] = useState(false);

  // Drag-to-scroll state
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);

  const mtb = mtbs.find((m) => m.id === id);
  const isOwner = mtb?.ownerId === user?.id;
  // Walkthrough tip: Add Case and Meeting. It only points at the Meeting
  // button; the modal with Start Meeting (which boots the meeting VM) is
  // never opened by the tour.
  useTourGroup('mtb_board', Boolean(mtb));
  // Only allow adding verified, non-archived cases to MTBs
  const availableCases = cases.filter((c) => !mtb?.cases.includes(c.id) && c.summaryStatus === 'verified' && !c.archivedAt);
  // Refetch the table only when this board's membership actually changes --
  // not whenever any MTB in context changes (rename, notification toggle).
  const mtbCaseKey = mtb ? [...mtb.cases].sort().join(',') : '';
  // Bumped to re-read the listed cases' statuses in place (see the refresh
  // effect below the fetch).
  const [refreshTick, setRefreshTick] = useState(0);

  const { activeMeeting } = useActiveMeeting(id);

  const handleCopyCode = () => {
    if (mtb?.joinCode) {
      navigator.clipboard.writeText(mtb.joinCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const fetchMTBCases = async () => {
      if (!id) return;
      // Loading placeholders only on the first load of this board; later
      // refreshes (e.g. after adding a case) keep the table on screen.
      const isFirstLoad = loadedMtbIdRef.current !== id;
      if (isFirstLoad) setLoading(true);
      try {
        // Every case already shared into this MTB stays listed regardless of
        // its current summary_status — an edit that puts the summary back
        // into 'processing'/'unverified' must not make the case vanish from
        // here. (Whether a case is eligible to be ADDED in the first place
        // is a separate, still-verified-only gate — see availableCases
        // above.) Each case's own summary_status is fetched below via
        // `select('*')` and rendered as a "please wait" state per row.
        const { data: mtbCaseIds } = await supabase
          .from('mtb_cases')
          .select('case_id')
          .eq('mtb_id', id);
        const caseIds = (mtbCaseIds || []).map(mc => mc.case_id);
        if (cancelled) return;
        if (caseIds.length > 0) {
          const { data: casesData } = await supabase.from('cases').select('*').in('id', caseIds);
          if (cancelled) return;
          setMtbCases((casesData || []).map(row => ({
            id: row.id,
            caseName: row.case_name,
            patientName: row.patient_name,
            age: row.patient_age,
            sex: row.patient_sex,
            cancerType: row.cancer_type,
            createdDate: row.created_at.split('T')[0],
            ownerId: row.owner_id,
            summaryStatus: row.summary_status || 'processing',
          })));
          // Fetch stats: reviewed by user + opinions count
          if (isFirstLoad) setStatsLoading(true);
          try {
            if (user?.id) {
              const { data: userOpinions } = await supabase
                .from('case_opinions')
                .select('case_id')
                .eq('user_id', user.id)
                .eq('mtb_id', id)
                .in('case_id', caseIds);
              const s = new Set<string>();
              (userOpinions || []).forEach((row: any) => s.add(row.case_id));
              setReviewedSet(s);
            }

            const { data: opinions } = await supabase
              .from('case_opinions')
              .select('case_id, user_id')
              .eq('mtb_id', id)
              .in('case_id', caseIds);
            const counts: Record<string, number> = {};
            const usersPerCase: Record<string, Set<string>> = {};
            (opinions || []).forEach((row: any) => {
              const cid = row.case_id as string;
              const uid = row.user_id as string;
              if (!usersPerCase[cid]) usersPerCase[cid] = new Set<string>();
              usersPerCase[cid].add(uid);
            });
            Object.keys(usersPerCase).forEach(cid => {
              counts[cid] = usersPerCase[cid].size;
            });
            if (cancelled) return;
            setOpinionCounts(counts);
          } catch (err) {
            console.error('Failed to fetch case stats', err);
          } finally {
            setStatsLoading(false);
          }
        } else {
          setMtbCases([]);
        }
        loadedMtbIdRef.current = id;
      } catch (err) {
        console.error('Failed to fetch MTB cases:', err);
      } finally {
        if (!cancelled && isFirstLoad) setLoading(false);
      }
    };
    fetchMTBCases();
    return () => { cancelled = true; };
  }, [id, user?.id, mtbCaseKey, refreshTick]);

  // A shared case can change under the board at any time (the owner edits
  // documents, a new summary is generated, the owner re-verifies). Re-read
  // while any listed case isn't verified, and whenever the window regains
  // focus, so members see "Case updated — awaiting verification" rather than
  // a stale state from when the page was opened.
  const hasUnverifiedCase = mtbCases.some((c) => c.summaryStatus !== 'verified');
  useEffect(() => {
    const onFocus = () => setRefreshTick((t) => t + 1);
    window.addEventListener('focus', onFocus);
    const interval = hasUnverifiedCase ? window.setInterval(onFocus, 30000) : undefined;
    return () => {
      window.removeEventListener('focus', onFocus);
      if (interval) window.clearInterval(interval);
    };
  }, [hasUnverifiedCase]);

  // Drag-to-scroll handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!tableContainerRef.current) return;
    // Only start drag if clicking on the table container itself or td elements
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON' || target.tagName === 'A' || target.closest('button') || target.closest('a')) {
      return;
    }
    setIsDragging(true);
    setStartX(e.pageX - tableContainerRef.current.offsetLeft);
    setScrollLeft(tableContainerRef.current.scrollLeft);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !tableContainerRef.current) return;
    e.preventDefault();
    const x = e.pageX - tableContainerRef.current.offsetLeft;
    const walk = (x - startX) * 1.5; // Scroll speed multiplier
    tableContainerRef.current.scrollLeft = scrollLeft - walk;
  };

  const handleMouseUpOrLeave = () => {
    setIsDragging(false);
  };

  const toggleCaseSelection = (caseId: string) => {
    setSelectedCaseIds((prev) =>
      prev.includes(caseId) ? prev.filter((id) => id !== caseId) : [...prev, caseId]
    );
  };

  const handleAddCases = async () => {
    if (!id) return;
    setAddingCases(true);
    try {
      for (const caseId of selectedCaseIds) {
        await addCaseToMTB(id, caseId);
      }
      setSelectedCaseIds([]);
      setShowAddCaseModal(false);
      // addCaseToMTB updates this board's case list in context, which
      // refreshes the table via the effect above.
    } catch (err) {
      console.error('Failed to add cases to MTB:', err);
      showToast.error('Failed to add cases. Please try again.');
    } finally {
      setAddingCases(false);
    }
  };

  if (!mtb && mtbsLoading) {
    return (
      <Layout>
        <div className="text-center py-12">
          <p className="text-text-muted">Loading MTB...</p>
        </div>
      </Layout>
    );
  }

  if (!mtb) {
    return (
      <Layout>
        <div className="text-center py-12">
          <p className="text-text-muted">MTB not found</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout wide>
      <div className={isMobile ? 'space-y-4' : 'space-y-6'}>
        <div className={`bg-surface rounded-xl shadow-sm border border-border ${isMobile ? 'p-4 space-y-3' : 'p-6'}`}>
          <div className={`flex ${isMobile ? 'flex-col gap-3' : 'justify-between items-center'}`}>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <h1 className={`font-bold text-text ${isMobile ? 'text-lg' : 'text-2xl'}`}>{mtb.name}</h1>
                {isOwner && (
                  <button
                    onClick={() => {
                      setNewMtbName(mtb.name);
                      setShowRenameModal(true);
                    }}
                    className="text-text-subtle hover:text-info transition-colors"
                    title="Rename MTB"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-4 text-sm text-text-muted">
                <div className="flex items-center gap-1.5">
                  <Users className="w-4 h-4 text-text-faint" />
                  <span className="font-medium">{mtb.experts}</span>
                  <span className="text-text-muted">Experts</span>
                </div>
                <span className="text-text-faint">•</span>
                <div className="flex items-center gap-1.5">
                  <FileText className="w-4 h-4 text-text-faint" />
                  <span className="font-medium">{mtbCases.length}</span>
                  <span className="text-text-muted">Cases</span>
                </div>
                {isOwner && mtb.joinCode && (
                  <>
                    <span className="text-text-faint">•</span>
                    <div className="flex items-center gap-2">
                      <span className="text-text-muted">Invite Code:</span>
                      <code className="font-mono font-semibold text-sm px-2 py-0.5 bg-status-processing-bg rounded border border-info-border text-link">{mtb.joinCode}</code>
                      <button
                        onClick={handleCopyCode}
                        className="text-text-subtle hover:text-info transition-colors"
                        title="Copy join code"
                      >
                        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                  </>
                )}
              </div>
              {isOwner && mtb.joinCode && (
                <p className="mt-1.5 text-xs text-text-muted">
                  Share this code to invite experts to this MTB.
                </p>
              )}
            </div>
            <div className={`flex items-center ${isMobile ? 'w-full justify-end gap-2' : 'gap-3'}`}>
              {!isOwner && (
                <button
                  onClick={() => setShowLeaveConfirmModal(true)}
                  disabled={leavingMTB}
                  className={`flex items-center justify-center gap-2 border border-danger-border text-danger rounded-lg hover:bg-danger-bg transition-colors disabled:opacity-50 ${
                    isMobile ? 'px-3 py-2 text-sm' : 'px-4 py-2'
                  }`}
                >
                  <LogOut className="w-4 h-4" />
                  <span>{leavingMTB ? 'Leaving...' : 'Leave'}</span>
                </button>
              )}
              <button
                onClick={() => {
                  if (!mtb) return;
                  const url = buildMeetingUrl(mtb);
                  window.open(url, '_blank');
                }}
                data-tour="mtb-meeting"
                className={`flex items-center justify-center gap-2 bg-success-solid text-on-solid rounded-lg hover:bg-success-solid-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  isMobile ? 'px-3 py-2 text-sm' : 'px-4 py-2'
                }`}
              >
                <Video className="w-4 h-4" />
                <span>{activeMeeting ? 'Join Meeting' : 'Start Meeting'}</span>
              </button>
              <button
                onClick={() => setShowAddCaseModal(true)}
                data-tour="mtb-add-case"
                className={`flex items-center justify-center gap-2 text-on-solid rounded-lg hover:opacity-90 transition-opacity bg-primary-solid ${
                  isMobile ? 'px-3 py-2 text-sm' : 'px-4 py-2'
                }`}
              >
                <Plus className="w-4 h-4" />
                <span>{isMobile ? 'Add' : 'Add Case'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="border-b border-border">
          <nav className="-mb-px flex items-center gap-6">
            {(['cases', 'meetings'] as MTBDetailTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`border-b-2 font-medium transition-colors whitespace-nowrap py-3 px-0.5 text-sm ${
                  activeTab === tab
                    ? 'text-info border-info'
                    : 'border-transparent text-text-subtle hover:text-text-muted hover:border-border-strong'
                }`}
              >
                {tab === 'cases' ? 'Cases' : 'Meetings'}
              </button>
            ))}
          </nav>
        </div>

        {/* Tab Content */}
        {activeTab === 'cases' && (
          <>
            {loading ? (
          <div className="bg-surface rounded-xl shadow-sm border border-border p-8 text-center">
            <p className="text-text-muted">Loading cases...</p>
          </div>
        ) : mtbCases.length === 0 ? (
          <div className={`bg-surface rounded-xl shadow-sm border border-border text-center ${isMobile ? 'p-6' : 'p-8'}`}>
            <div className="max-w-md mx-auto">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-info-bg flex items-center justify-center">
                <Plus className="w-8 h-8 text-primary" />
              </div>
              <h3 className="text-xl font-semibold mb-2 text-text-muted">
                No Cases Yet
              </h3>
              <p className="text-sm text-text-muted mb-4">
                Start collaborating by adding your first case to this MTB. Share verified cases with experts to get valuable insights and treatment recommendations.
              </p>
              <button
                onClick={() => setShowAddCaseModal(true)}
                className="inline-flex items-center justify-center gap-2 text-on-solid rounded-lg px-4 py-2 font-medium hover:opacity-90 transition-opacity bg-primary-solid"
              >
                <Plus className="w-4 h-4" />
                <span>Add Your First Case</span>
              </button>
            </div>
          </div>
        ) : isMobile ? (
          /* Mobile Card View */
          <div className="space-y-3">
            {mtbCases.map((caseItem) => (
              <div
                key={caseItem.id}
                className="bg-surface rounded-xl shadow-sm border border-border p-4 cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => navigate(`/mtb/${id}/case/${caseItem.id}`)}
              >
                <div className="flex justify-between items-start mb-2">
                  <h3 className="font-medium text-text text-sm line-clamp-1 flex-1 mr-2">
                    {caseItem.caseName}
                  </h3>
                  {caseItem.ownerId === user?.id ? (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-status-verified-bg text-status-verified-text font-medium">Owner</span>
                  ) : (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-status-processing-bg text-status-processing-text font-medium">Member</span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-text-muted mb-3">
                  <div>
                    <span className="text-text-muted">Info: </span>
                    <span className="font-medium text-text">{caseItem.age != null && caseItem.sex ? `${caseItem.age}Y, ${caseItem.sex}` : 'Not detected'}</span>
                  </div>
                  <div>
                    <span className="text-text-muted">Opinions: </span>
                    <span className="font-medium text-text">{statsLoading ? '…' : (opinionCounts[caseItem.id] || 0)}</span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-text-muted">Cancer: </span>
                    <span className="font-medium text-text line-clamp-1">{caseItem.cancerType}</span>
                  </div>
                </div>
                <div className="flex justify-between items-center pt-2 border-t border-border">
                  <span className="text-xs text-text-muted">{caseItem.createdDate}</span>
                  {getMtbCaseStatusMeta(caseItem.summaryStatus) ? (
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${getMtbCaseStatusMeta(caseItem.summaryStatus)!.className}`}
                      title={getMtbCaseStatusMeta(caseItem.summaryStatus)!.description}
                    >
                      {getMtbCaseStatusMeta(caseItem.summaryStatus)!.label}
                    </span>
                  ) : reviewedSet.has(caseItem.id) ? (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-status-verified-bg text-status-verified-text">
                      Reviewed
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-status-processing-bg text-status-processing-text">
                      Not reviewed
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* Desktop Table View */
          <div className="bg-surface rounded-xl shadow-sm border border-border overflow-hidden">
            <div 
              ref={tableContainerRef}
              className="overflow-x-auto no-scrollbar select-none"
              style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUpOrLeave}
              onMouseLeave={handleMouseUpOrLeave}
            >
              <table className="min-w-full divide-y divide-border">
              <thead className="bg-bg">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wider" style={{ maxWidth: '200px' }}>
                    Case Name
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wider">
                    Patient Info
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wider" style={{ maxWidth: '180px' }}>
                    Cancer Type
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wider">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wider">Opinions</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wider">
                    Created Date
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wider">Owner</th>
                </tr>
              </thead>
              <tbody className="bg-surface divide-y divide-border">
                {mtbCases.map((caseItem) => (
                  <tr 
                    key={caseItem.id} 
                    onClick={() => navigate(`/mtb/${id}/case/${caseItem.id}`)}
                    className="hover:bg-status-processing-bg transition-colors cursor-pointer"
                  >
                    <td className="px-4 py-3 text-sm font-medium text-text" style={{ maxWidth: '200px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {caseItem.caseName}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-text-muted">
                      {caseItem.age != null && caseItem.sex ? `${caseItem.age}Y, ${caseItem.sex}` : 'Not detected'}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-muted" style={{ maxWidth: '180px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {caseItem.cancerType}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm">
                      {getMtbCaseStatusMeta(caseItem.summaryStatus) ? (
                        <span
                          className={`px-3 py-1 rounded-full text-xs font-medium ${getMtbCaseStatusMeta(caseItem.summaryStatus)!.className}`}
                          title={getMtbCaseStatusMeta(caseItem.summaryStatus)!.description}
                        >
                          {getMtbCaseStatusMeta(caseItem.summaryStatus)!.label}
                        </span>
                      ) : reviewedSet.has(caseItem.id) ? (
                        <span className="px-3 py-1 rounded-full text-xs font-medium bg-status-verified-bg text-status-verified-text">
                          Reviewed
                        </span>
                      ) : (
                        <span className="px-3 py-1 rounded-full text-xs font-medium bg-status-processing-bg text-status-processing-text">
                          Not reviewed
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-text-muted">
                      {statsLoading ? '…' : (opinionCounts[caseItem.id] || 0)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-text-muted">
                      {caseItem.createdDate}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-text-muted">
                      {caseItem.ownerId === user?.id ? 'You' : 'Other'}
                    </td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          </div>
        )}
          </>
        )}

        {activeTab === 'meetings' && mtb && (
          <MeetingsList
            mtbId={mtb.id}
            mtb={mtb}
            onToggleNotification={async (enabled) => {
              if (!mtb || togglingNotification) return;
              setTogglingNotification(true);
              try {
                await updateMTBNotification(mtb.id, enabled);
                showToast.success(enabled ? 'Notifications enabled' : 'Notifications disabled');
              } catch (err: any) {
                console.error('Failed to toggle notification:', err);
                showToast.error('Failed to update notification setting');
              } finally {
                setTogglingNotification(false);
              }
            }}
            togglingNotification={togglingNotification}
          />
        )}
      </div>

      <Modal
        isOpen={showAddCaseModal}
        onClose={() => setShowAddCaseModal(false)}
        title="Add Cases to MTB"
      >
        {availableCases.length === 0 ? (
          <div className="py-8">
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-bg flex items-center justify-center">
                <FileText className="w-8 h-8 text-text-faint" />
              </div>
              <p className="text-sm font-medium text-text mb-1">No Cases Available</p>
              <p className="text-sm text-text-muted">
                All your verified cases are already added to this MTB.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="max-h-80 overflow-y-auto pr-1">
              <div className="space-y-2.5">
                {availableCases.map((caseItem) => (
                  <label
                    key={caseItem.id}
                    className="flex items-start gap-3 p-3.5 bg-bg rounded-lg border border-border hover:bg-surface-muted cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedCaseIds.includes(caseItem.id)}
                      onChange={() => toggleCaseSelection(caseItem.id)}
                      className="mt-0.5 w-4 h-4 rounded border-border focus:ring-2 focus:ring-primary focus:ring-offset-0"
                      style={{ accentColor: 'var(--color-primary)' } as React.CSSProperties}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text mb-0.5 truncate">{caseItem.caseName}</p>
                      <p className="text-xs text-text-muted truncate">
                        {caseItem.patientName || 'Anonymous'} • {caseItem.cancerType}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
            
            {selectedCaseIds.length === 0 && (
              <p className="text-xs text-text-muted text-center py-2 bg-bg rounded-lg border border-border">
                No cases selected. Select at least one case to add.
              </p>
            )}
            
            <div className="flex justify-end gap-3 pt-2 border-t border-border">
              <button
                onClick={() => setShowAddCaseModal(false)}
                className="px-4 py-2 border border-border rounded-lg text-sm font-medium text-text hover:bg-surface-hover transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAddCases}
                disabled={selectedCaseIds.length === 0 || addingCases}
                className="px-4 py-2 text-sm font-medium text-on-solid rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed bg-primary-solid"
              >
                {addingCases ? 'Adding…' : `Add ${selectedCaseIds.length > 0 ? `${selectedCaseIds.length} ` : ''}Case${selectedCaseIds.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={showRenameModal}
        onClose={() => setShowRenameModal(false)}
        title="Rename MTB"
      >
        <div className="space-y-4">
          <div>
            <label htmlFor="newMtbName" className="block text-sm font-medium text-text mb-1">
              MTB Name
            </label>
            <input
              id="newMtbName"
              type="text"
              value={newMtbName}
              onChange={(e) => setNewMtbName(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="Enter new MTB name"
            />
          </div>
          <div className="flex justify-end space-x-3">
            <button
              onClick={() => setShowRenameModal(false)}
              disabled={renamingMTB}
              className="px-4 py-2 border border-border rounded-lg text-text hover:bg-surface-hover transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                if (!id || !newMtbName.trim()) return;
                setRenamingMTB(true);
                try {
                  await updateMTBName(id, newMtbName.trim());
                  showToast.success('MTB renamed successfully');
                  setShowRenameModal(false);
                } catch (err: any) {
                  console.error('Failed to rename MTB:', err);
                  showToast.error(err?.message || 'Failed to rename MTB. Please try again.');
                } finally {
                  setRenamingMTB(false);
                }
              }}
              disabled={renamingMTB || !newMtbName.trim()}
              className="px-4 py-2 bg-info-solid text-on-solid rounded-lg hover:bg-info-solid-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {renamingMTB ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Leave MTB Confirmation Modal */}
      <Modal
        isOpen={showLeaveConfirmModal}
        onClose={() => setShowLeaveConfirmModal(false)}
        title="Leave MTB"
      >
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            Are you sure you want to leave this MTB? You will no longer have access to the cases shared in this board.
          </p>
          <div className="flex justify-end space-x-3">
            <button
              onClick={() => setShowLeaveConfirmModal(false)}
              disabled={leavingMTB}
              className="px-4 py-2 border border-border rounded-lg text-text hover:bg-surface-hover transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                if (!id) return;
                setLeavingMTB(true);
                try {
                  await leaveMTB(id);
                  showToast.success('You have left the MTB');
                  setShowLeaveConfirmModal(false);
                  navigate('/mtbs');
                } catch (err) {
                  console.error('Failed to leave MTB:', err);
                  showToast.error('Failed to leave MTB. Please try again.');
                } finally {
                  setLeavingMTB(false);
                }
              }}
              disabled={leavingMTB}
              className="px-4 py-2 bg-danger-solid text-on-solid rounded-lg hover:bg-danger-solid-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {leavingMTB ? 'Leaving...' : 'Leave MTB'}
            </button>
          </div>
        </div>
      </Modal>
    </Layout>
  );
}