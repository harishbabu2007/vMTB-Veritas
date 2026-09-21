import { useNavigate, useSearchParams } from 'react-router-dom';
import { useEffect, useState, useRef } from 'react';
import { Plus, Search } from 'lucide-react';
import { Layout } from '../components/Layout';

import { StatusInfoIcon } from '../components/StatusInfoIcon';
import { useCases } from '../context/CasesContext';
import { getSummaryStatusMeta } from '../utils/summaryStatus';
import { supabase } from '../Supabase/client';
import { useIsMobile } from '../hooks/useMobile';
import { useTourGroup } from '../hooks/useTourGroup';

const getStatusBadge = getSummaryStatusMeta;

type CaseView = 'active' | 'archived';

export function MyCases() {
  const navigate = useNavigate();
  const { cases, casesLoading: loading, refreshProcessingCases } = useCases();
  // Active vs archived lives in the URL (?view=archived) so the profile menu's
  // "Archived cases" link and browser back/forward land on the right list.
  const [searchParams, setSearchParams] = useSearchParams();
  const view: CaseView = searchParams.get('view') === 'archived' ? 'archived' : 'active';
  const [opinionCounts, setOpinionCounts] = useState<Record<string, number>>({});
  const [countsLoading, setCountsLoading] = useState(false);
  const countsLoadedRef = useRef(false);
  // Counts depend only on which cases are listed, not on their status, so the
  // 10s processing poll doesn't refetch them.
  const caseIdsKey = cases.map(c => c.id).join(',');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('newest');
  const isMobile = useIsMobile();

  // Walkthrough: the welcome once the list has loaded; pointers back into an
  // interrupted case or MTB section; and a tip on the first Pending case
  // (the badge carries data-tour="case-pending").
  const listed = !loading && view === 'active';
  useTourGroup('welcome', listed);
  useTourGroup('case_resume', listed);
  useTourGroup('mtb_intro', listed);
  useTourGroup(
    'case_status',
    !loading && view === 'active' && cases.some(c => !c.archivedAt && (c.summaryStatus ?? 'unverified') === 'unverified')
  );

  // Drag-to-scroll state
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);

  // Poll processing cases every 10s and stop when none left
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;

    const processingExists = cases.some(c => c.summaryStatus === 'processing');
    if (processingExists) {
      interval = setInterval(() => {
        void refreshProcessingCases();
      }, 10000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [cases, refreshProcessingCases]);

  // Fetch opinions count for listed cases
  useEffect(() => {
    const fetchOpinionCounts = async () => {
      const caseIds = caseIdsKey ? caseIdsKey.split(',') : [];
      if (caseIds.length === 0) {
        setOpinionCounts({});
        return;
      }
      try {
        if (!countsLoadedRef.current) setCountsLoading(true);
        const { data } = await supabase
          .from('case_opinions')
          .select('case_id, user_id')
          .in('case_id', caseIds);
        const counts: Record<string, number> = {};
        const usersPerCase: Record<string, Set<string>> = {};
        (data || []).forEach((row: any) => {
          const cid = row.case_id as string;
          const uid = row.user_id as string;
          if (!usersPerCase[cid]) usersPerCase[cid] = new Set<string>();
          usersPerCase[cid].add(uid);
        });
        Object.keys(usersPerCase).forEach(cid => {
          counts[cid] = usersPerCase[cid].size;
        });
        setOpinionCounts(counts);
        countsLoadedRef.current = true;
      } catch (err) {
        console.error('Failed to fetch opinion counts', err);
      } finally {
        setCountsLoading(false);
      }
    };
    fetchOpinionCounts();
  }, [caseIdsKey]);

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

  // One dropdown for both: the sort options show active cases, and
  // "Archived cases" switches the list to archived ones.
  const handleListOptionChange = (value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value === 'archived') {
      params.set('view', 'archived');
    } else {
      params.delete('view');
      setSortBy(value);
    }
    setSearchParams(params);
  };

  const emptyMessage = searchQuery
    ? 'No cases found matching your search.'
    : view === 'archived'
    ? 'No archived cases. Cases you archive from Case Settings appear here.'
    : 'No cases yet. Create your first case!';

  const listOptionSelect = (
    <select
      value={view === 'archived' ? 'archived' : sortBy}
      onChange={(e) => handleListOptionChange(e.target.value)}
      aria-label="Sort or filter cases"
      className={`px-4 py-2 border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 transition text-sm ${isMobile ? 'w-full' : ''}`}
    >
      <option value="newest">Newest First</option>
      <option value="oldest">Oldest First</option>
      <option value="name">Name (A-Z)</option>
      <option disabled>──────────</option>
      <option value="archived">Archived cases</option>
    </select>
  );

  // Filter and sort cases
  const filteredAndSortedCases = cases
    .filter(caseItem => (view === 'archived' ? Boolean(caseItem.archivedAt) : !caseItem.archivedAt))
    .filter(caseItem => {
      if (!searchQuery) return true;
      const query = searchQuery.toLowerCase();
      return (
        caseItem.caseName.toLowerCase().includes(query) ||
        caseItem.patientName?.toLowerCase().includes(query) ||
        caseItem.cancerType.toLowerCase().includes(query)
      );
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'newest':
          return new Date(b.createdAt ?? b.createdDate).getTime() - new Date(a.createdAt ?? a.createdDate).getTime();
        case 'oldest':
          return new Date(a.createdAt ?? a.createdDate).getTime() - new Date(b.createdAt ?? b.createdDate).getTime();
        case 'name':
          return a.caseName.localeCompare(b.caseName);
        default:
          return 0;
      }
    });

  return (
    <Layout wide>
      <div className={isMobile ? 'space-y-4' : 'space-y-6'}>
        {/* Header */}
        <div className="flex justify-between items-center">
          <h1 data-tour="my-cases-heading" className="text-2xl font-bold text-text">My Cases</h1>
          <button
            onClick={() => navigate('/cases/new/step-1')}
            data-tour="add-case"
            className="flex items-center justify-center space-x-2 text-on-solid rounded-lg transition px-4 py-2 font-medium bg-primary-solid hover:bg-primary-solid-hover"
          >
            <Plus className="w-5 h-5" />
            <span>Add New Case</span>
          </button>
        </div>

        {/* Search and Sort */}
        {!isMobile && (
          <div className="flex gap-3 items-center">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-text-faint" />
              <input
                type="text"
                placeholder="Search by case name, patient name, or cancer type..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-border rounded-lg bg-surface text-text focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 transition text-sm"
              />
            </div>
            <div>{listOptionSelect}</div>
          </div>
        )}

        {isMobile && listOptionSelect}

        {/* Mobile Card View */}
        {isMobile ? (
          <div className="space-y-3">
            {loading ? (
              <div className="text-center py-8 text-text-muted">Loading cases...</div>
            ) : filteredAndSortedCases.length === 0 ? (
              <div className="text-center py-8 text-text-muted bg-surface rounded-xl shadow-sm border border-border">
                {emptyMessage}
              </div>
            ) : (
              filteredAndSortedCases.map((caseItem) => (
                <div
                  key={caseItem.id}
                  className="bg-surface rounded-xl shadow-sm border border-border p-4 cursor-pointer hover:shadow-md transition-shadow"
                  onClick={() => navigate(`/case/${caseItem.id}`)}
                >
                  <div className="flex justify-between items-start mb-2">
                    <h3 className="font-medium text-text text-sm line-clamp-1 flex-1 mr-2">
                      {caseItem.caseName}
                    </h3>
                    <span data-tour={(caseItem.summaryStatus ?? 'unverified') === 'unverified' ? 'case-pending' : undefined} className={`px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ${
                      getStatusBadge(caseItem.summaryStatus).bg
                    } ${getStatusBadge(caseItem.summaryStatus).text}`}>
                      {getStatusBadge(caseItem.summaryStatus).label}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs text-text-muted mb-3">
                    <div>
                      <span className="text-text-muted">Patient: </span>
                      <span className="font-medium text-text">{caseItem.patientName || 'Anonymous'}</span>
                    </div>
                    <div>
                      <span className="text-text-muted">Info: </span>
                      <span className="font-medium text-text">{caseItem.age != null && caseItem.sex ? `${caseItem.age}Y, ${caseItem.sex}` : 'Not detected'}</span>
                    </div>
                    <div className="col-span-2">
                      <span className="text-text-muted">Cancer: </span>
                      <span className="font-medium text-text line-clamp-1">{caseItem.cancerType}</span>
                    </div>
                  </div>
                  <div className="flex justify-between items-center pt-2 border-t border-border">
                    <div className="flex items-center gap-4 text-xs text-text-muted">
                      <span>Opinions: {countsLoading ? '…' : (opinionCounts[caseItem.id] || 0)}</span>
                      <span>{caseItem.createdDate}</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          /* Desktop Table View */
          <div className="bg-surface rounded-xl shadow-sm border border-border overflow-hidden">
            <div 
              ref={tableContainerRef}
              className="overflow-x-auto no-scrollbar select-none"
              style={{ cursor: isDragging ? 'grabbing' : 'grab', overflowY: 'visible' }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUpOrLeave}
              onMouseLeave={handleMouseUpOrLeave}
            >
              <table className="min-w-full divide-y divide-border">
              <thead className="bg-bg">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">
                    Case Name
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">
                    Patient Name
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">
                    Patient Info
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">
                    Cancer Type
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">
                    <div className="flex items-center gap-2 relative">
                      Summary Status
                      <StatusInfoIcon />
                    </div>
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">
                    Opinions
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted">
                    Created Date
                  </th>
                </tr>
              </thead>
              <tbody className="bg-surface divide-y divide-border">
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-text-muted">Loading cases...</td></tr>
              ) : filteredAndSortedCases.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-text-muted">
                  {emptyMessage}
                </td></tr>
              ) : filteredAndSortedCases.map((caseItem) => (
                <tr 
                  key={caseItem.id} 
                  onClick={() => navigate(`/case/${caseItem.id}`)}
                  className="hover:bg-status-processing-bg transition-colors cursor-pointer"
                >
                  <td className="px-4 py-3 text-sm font-medium text-text">
                    <div className="max-w-[200px] truncate">{caseItem.caseName}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-text-muted">
                    <div className="max-w-[150px] truncate">{caseItem.patientName || 'Anonymous'}</div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-text-muted">
                    {caseItem.age != null && caseItem.sex ? `${caseItem.age}Y, ${caseItem.sex}` : 'Not detected'}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-muted">
                    <div className="max-w-[180px] truncate">{caseItem.cancerType}</div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm">
                    <span data-tour={(caseItem.summaryStatus ?? 'unverified') === 'unverified' ? 'case-pending' : undefined} className={`px-3 py-1 rounded-full text-xs font-medium ${
                      getStatusBadge(caseItem.summaryStatus).bg
                    } ${getStatusBadge(caseItem.summaryStatus).text}`}>
                      {getStatusBadge(caseItem.summaryStatus).label}
                    </span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-text-muted">
                    {countsLoading ? '…' : (opinionCounts[caseItem.id] || 0)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-text-muted">
                    {caseItem.createdDate}
                  </td>
                </tr>
              ))}
              </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
