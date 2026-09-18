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
import { useActiveMeeting } from '../hooks/useActiveMeeting';
import { buildMeetingUrl } from '../utils/roomName';

type MTBDetailTab = 'cases' | 'meetings';

export function MTBDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { cases, mtbs, addCaseToMTB, leaveMTB, updateMTBName, updateMTBNotification } = useCases();
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState<MTBDetailTab>('cases');
  const [showAddCaseModal, setShowAddCaseModal] = useState(false);
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [mtbCases, setMtbCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(false);
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
  // Only allow adding verified cases to MTBs
  const availableCases = cases.filter((c) => !mtb?.cases.includes(c.id) && c.summaryStatus === 'verified');

  const { activeMeeting } = useActiveMeeting(id);

  const handleCopyCode = () => {
    if (mtb?.joinCode) {
      navigator.clipboard.writeText(mtb.joinCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  useEffect(() => {
    const fetchMTBCases = async () => {
      if (!id) return;
      setLoading(true);
      try {
        const { data: mtbCaseIds } = await supabase
          .from('mtb_cases')
          .select('case_id, cases!inner(summary_status)')
          .eq('mtb_id', id)
          .eq('cases.summary_status', 'verified');
        const caseIds = (mtbCaseIds || []).map(mc => mc.case_id);
        if (caseIds.length > 0) {
          const { data: casesData } = await supabase.from('cases').select('*').in('id', caseIds);
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
          setStatsLoading(true);
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
            setOpinionCounts(counts);
          } catch (err) {
            console.error('Failed to fetch case stats', err);
          } finally {
            setStatsLoading(false);
          }
        } else {
          setMtbCases([]);
        }
      } catch (err) {
        console.error('Failed to fetch MTB cases:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchMTBCases();
  }, [id, mtbs]);

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
    if (id) {
      for (const caseId of selectedCaseIds) {
        await addCaseToMTB(id, caseId);
      }
      setSelectedCaseIds([]);
      setShowAddCaseModal(false);
      // Refetch MTB cases
      const { data: mtbCaseIds } = await supabase.from('mtb_cases').select('case_id').eq('mtb_id', id);
      const caseIds = (mtbCaseIds || []).map(mc => mc.case_id);
      if (caseIds.length > 0) {
        const { data: casesData } = await supabase.from('cases').select('*').in('id', caseIds);
        setMtbCases((casesData || []).map(row => ({
          id: row.id,
          caseName: row.case_name,
          patientName: row.patient_name,
          age: row.age,
          sex: row.sex,
          cancerType: row.cancer_type,
          createdDate: row.created_at.split('T')[0],
          ownerId: row.owner_id,
        })));
      }
    }
  };

  if (!mtb) {
    return (
      <Layout>
        <div className="text-center py-12">
          <p className="text-gray-600">MTB not found</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout wide>
      <div className={isMobile ? 'space-y-4' : 'space-y-6'}>
        <div className={`bg-white rounded-lg shadow-sm border border-gray-100 ${isMobile ? 'p-4 space-y-3' : 'p-6'}`}>
          <div className={`flex ${isMobile ? 'flex-col gap-3' : 'justify-between items-center'}`}>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <h1 className={`font-bold ${isMobile ? 'text-lg' : 'text-2xl'}`} style={{ color: '#4A5565' }}>{mtb.name}</h1>
                {isOwner && (
                  <button
                    onClick={() => {
                      setNewMtbName(mtb.name);
                      setShowRenameModal(true);
                    }}
                    className="text-gray-400 hover:text-blue-600 transition-colors"
                    title="Rename MTB"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-4 text-sm" style={{ color: '#4A5565' }}>
                <div className="flex items-center gap-1.5">
                  <Users className="w-4 h-4 text-gray-400" />
                  <span className="font-medium">{mtb.experts}</span>
                  <span className="text-gray-500">Experts</span>
                </div>
                <span className="text-gray-300">•</span>
                <div className="flex items-center gap-1.5">
                  <FileText className="w-4 h-4 text-gray-400" />
                  <span className="font-medium">{mtbCases.length}</span>
                  <span className="text-gray-500">Cases</span>
                </div>
                {isOwner && mtb.joinCode && (
                  <>
                    <span className="text-gray-300">•</span>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500">Invite Code:</span>
                      <code className="font-mono font-semibold text-sm px-2 py-0.5 bg-blue-50 rounded border border-blue-200" style={{ color: '#4A90E2' }}>{mtb.joinCode}</code>
                      <button
                        onClick={handleCopyCode}
                        className="text-gray-400 hover:text-blue-600 transition-colors"
                        title="Copy join code"
                      >
                        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                  </>
                )}
              </div>
              {isOwner && mtb.joinCode && (
                <p className="mt-1.5 text-xs text-gray-500">
                  Share this code to invite experts to this MTB.
                </p>
              )}
            </div>
            <div className={`flex items-center ${isMobile ? 'w-full justify-end gap-2' : 'gap-3'}`}>
              {!isOwner && (
                <button
                  onClick={() => setShowLeaveConfirmModal(true)}
                  disabled={leavingMTB}
                  className={`flex items-center justify-center gap-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50 ${
                    isMobile ? 'px-3 py-2 text-sm' : 'px-4 py-2.5'
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
                className={`flex items-center justify-center gap-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  isMobile ? 'px-3 py-2 text-sm' : 'px-4 py-2.5'
                }`}
              >
                <Video className="w-4 h-4" />
                <span>{activeMeeting ? 'Join Meeting' : 'Start Meeting'}</span>
              </button>
              <button
                onClick={() => setShowAddCaseModal(true)}
                className={`flex items-center justify-center gap-2 text-white rounded-lg hover:opacity-90 transition-opacity ${
                  isMobile ? 'px-3 py-2 text-sm' : 'px-4 py-2.5'
                }`}
                style={{ backgroundColor: '#4A90E2' }}
              >
                <Plus className="w-4 h-4" />
                <span>{isMobile ? 'Add' : 'Add Case'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="border-b border-gray-200">
          <nav className="-mb-px flex items-center gap-6">
            {(['cases', 'meetings'] as MTBDetailTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`border-b-2 font-medium transition-colors whitespace-nowrap py-3 px-0.5 text-sm ${
                  activeTab === tab
                    ? 'text-blue-600 border-blue-500'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
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
          <div className="bg-white rounded-lg shadow p-12 text-center">
            <p className="text-gray-600">Loading cases...</p>
          </div>
        ) : mtbCases.length === 0 ? (
          <div className={`bg-white rounded-2xl shadow-sm border border-gray-100 text-center ${isMobile ? 'p-8' : 'p-16'}`}>
            <div className="max-w-md mx-auto">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-50 flex items-center justify-center">
                <Plus className="w-8 h-8" style={{ color: '#4A90E2' }} />
              </div>
              <h3 className="text-xl font-semibold mb-2" style={{ color: '#4A5565' }}>
                No Cases Yet
              </h3>
              <p className="text-gray-500 mb-6">
                Start collaborating by adding your first case to this MTB. Share verified cases with experts to get valuable insights and treatment recommendations.
              </p>
              <button
                onClick={() => setShowAddCaseModal(true)}
                className="inline-flex items-center justify-center gap-2 text-white rounded-lg px-6 py-3 font-medium hover:opacity-90 transition-opacity"
                style={{ backgroundColor: '#4A90E2' }}
              >
                <Plus className="w-5 h-5" />
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
                className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => navigate(`/mtb/${id}/case/${caseItem.id}`)}
              >
                <div className="flex justify-between items-start mb-2">
                  <h3 className="font-medium text-gray-900 text-sm line-clamp-1 flex-1 mr-2">
                    {caseItem.caseName}
                  </h3>
                  {caseItem.ownerId === user?.id ? (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-700 font-medium">Owner</span>
                  ) : (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-blue-100 text-blue-700 font-medium">Member</span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-gray-600 mb-3">
                  <div>
                    <span className="text-gray-400">Info: </span>
                    <span className="font-medium text-gray-700">{caseItem.age}Y, {caseItem.sex}</span>
                  </div>
                  <div>
                    <span className="text-gray-400">Opinions: </span>
                    <span className="font-medium text-gray-700">{statsLoading ? '…' : (opinionCounts[caseItem.id] || 0)}</span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-gray-400">Cancer: </span>
                    <span className="font-medium text-gray-700 line-clamp-1">{caseItem.cancerType}</span>
                  </div>
                </div>
                <div className="flex justify-between items-center pt-2 border-t border-gray-100">
                  <span className="text-xs text-gray-500">{caseItem.createdDate}</span>
                  {reviewedSet.has(caseItem.id) ? (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700">
                      Reviewed
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium" style={{ backgroundColor: '#E8F4FD', color: '#4A90E2' }}>
                      Not reviewed
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* Desktop Table View */
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <div 
              ref={tableContainerRef}
              className="overflow-x-auto no-scrollbar select-none"
              style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUpOrLeave}
              onMouseLeave={handleMouseUpOrLeave}
            >
              <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50/80">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" style={{ maxWidth: '200px' }}>
                    Case Name
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Patient Info
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" style={{ maxWidth: '180px' }}>
                    Cancer Type
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Opinions</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Created Date
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Owner</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {mtbCases.map((caseItem) => (
                  <tr 
                    key={caseItem.id} 
                    onClick={() => navigate(`/mtb/${id}/case/${caseItem.id}`)}
                    className="hover:bg-blue-50 transition-colors cursor-pointer"
                  >
                    <td className="px-6 py-4 text-sm font-medium text-gray-900" style={{ maxWidth: '200px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {caseItem.caseName}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                      {caseItem.age}Y, {caseItem.sex}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-700" style={{ maxWidth: '180px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {caseItem.cancerType}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      {reviewedSet.has(caseItem.id) ? (
                        <span className="px-3 py-1 rounded-full text-xs font-medium bg-green-50 text-green-700">
                          Reviewed
                        </span>
                      ) : (
                        <span className="px-3 py-1 rounded-full text-xs font-medium" style={{ backgroundColor: '#E8F4FD', color: '#4A90E2' }}>
                          Not reviewed
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                      {statsLoading ? '…' : (opinionCounts[caseItem.id] || 0)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                      {caseItem.createdDate}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
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
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gray-100 flex items-center justify-center">
                <FileText className="w-8 h-8 text-gray-400" />
              </div>
              <p className="text-sm font-medium text-gray-900 mb-1">No Cases Available</p>
              <p className="text-sm text-gray-500">
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
                    className="flex items-start gap-3 p-3.5 bg-gray-50 rounded-lg border border-gray-200 hover:bg-gray-100 cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedCaseIds.includes(caseItem.id)}
                      onChange={() => toggleCaseSelection(caseItem.id)}
                      className="mt-0.5 w-4 h-4 rounded border-gray-300 focus:ring-2 focus:ring-offset-0"
                      style={{ 
                        accentColor: '#4A90E2',
                        '--tw-ring-color': '#4A90E2' 
                      } as React.CSSProperties}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 mb-0.5 truncate">{caseItem.caseName}</p>
                      <p className="text-xs text-gray-500 truncate">
                        {caseItem.patientName || 'Anonymous'} • {caseItem.cancerType}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
            
            {selectedCaseIds.length === 0 && (
              <p className="text-xs text-gray-500 text-center py-2 bg-gray-50 rounded-lg border border-gray-200">
                No cases selected. Select at least one case to add.
              </p>
            )}
            
            <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
              <button
                onClick={() => setShowAddCaseModal(false)}
                className="px-5 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAddCases}
                disabled={selectedCaseIds.length === 0}
                className="px-6 py-2.5 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ backgroundColor: '#4A90E2' }}
              >
                Add {selectedCaseIds.length > 0 ? `${selectedCaseIds.length} ` : ''}Case{selectedCaseIds.length !== 1 ? 's' : ''}
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
            <label htmlFor="newMtbName" className="block text-sm font-medium text-gray-700 mb-1">
              MTB Name
            </label>
            <input
              id="newMtbName"
              type="text"
              value={newMtbName}
              onChange={(e) => setNewMtbName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Enter new MTB name"
            />
          </div>
          <div className="flex justify-end space-x-3">
            <button
              onClick={() => setShowRenameModal(false)}
              disabled={renamingMTB}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
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
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
          <p className="text-sm text-gray-600">
            Are you sure you want to leave this MTB? You will no longer have access to the cases shared in this board.
          </p>
          <div className="flex justify-end space-x-3">
            <button
              onClick={() => setShowLeaveConfirmModal(false)}
              disabled={leavingMTB}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
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
              className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {leavingMTB ? 'Leaving...' : 'Leave MTB'}
            </button>
          </div>
        </div>
      </Modal>
    </Layout>
  );
}
