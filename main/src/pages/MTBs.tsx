import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Users, FileText, Search } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Modal } from '../components/Modal';
import { useCases } from '../context/CasesContext';
import { useAuth } from '../context/AuthContext';
import { useIsMobile } from '../hooks/useMobile';
import { useTourGroup } from '../hooks/useTourGroup';

export function MTBs() {
  const navigate = useNavigate();
  const { mtbs, createMTB, joinMTB, mtbsLoading: loading } = useCases();
  const { user } = useAuth();
  const isMobile = useIsMobile();
  useTourGroup('mtbs', !loading);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [mtbName, setMtbName] = useState('');
  const [mtbCode, setMtbCode] = useState('');
  const [mtbDescription, setMtbDescription] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'owner-first' | 'name-asc' | 'experts-desc'>('owner-first');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const sortedMtbs = useMemo(() => {
    const filtered = mtbs.filter((mtb) =>
      mtb.name.toLowerCase().includes(searchQuery.toLowerCase().trim())
    );

    return filtered.sort((a, b) => {
      if (sortBy === 'name-asc') {
        return a.name.localeCompare(b.name);
      }

      if (sortBy === 'experts-desc') {
        return b.experts - a.experts;
      }

      const aIsOwner = a.ownerId === user?.id;
      const bIsOwner = b.ownerId === user?.id;
      if (aIsOwner && !bIsOwner) return -1;
      if (!aIsOwner && bIsOwner) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [mtbs, searchQuery, sortBy, user?.id]);

  const handleCreateMTB = async () => {
    if (!mtbName.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      await createMTB(mtbName);
      setMtbName('');
      setMtbDescription('');
      setShowCreateModal(false);
    } catch (err: any) {
      setError(err?.message || 'Failed to create MTB');
    } finally {
      setSubmitting(false);
    }
  };

  const handleJoinMTB = async () => {
    if (!mtbCode.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      await joinMTB(mtbCode);
      setMtbCode('');
      setShowJoinModal(false);
    } catch (err: any) {
      setError(err?.message || 'Failed to join MTB');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Layout wide>
      <div className={isMobile ? 'space-y-4' : 'space-y-6'}>
        <div className={`flex ${isMobile ? 'flex-col gap-3' : 'justify-between items-center'}`}>
          <h1 className={`font-bold text-text-muted ${isMobile ? 'text-xl' : 'text-2xl'}`}>
            {isMobile ? 'MTBs' : 'Molecular Tumor Boards'}
          </h1>
          <div className={`flex ${isMobile ? 'gap-2' : 'space-x-3'}`}>
            <button
              onClick={() => setShowJoinModal(true)}
              data-tour="join-mtb"
              className={`flex items-center justify-center space-x-2 rounded-lg text-white transition-opacity hover:opacity-90 bg-primary ${isMobile ? 'flex-1 px-3 py-2 text-sm' : 'px-4 py-2'}`}
            >
              <Plus className={isMobile ? 'w-4 h-4' : 'w-5 h-5'} />
              <span>Join MTB</span>
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              data-tour="create-mtb"
              className={`flex items-center justify-center space-x-2 rounded-lg text-white transition-opacity hover:opacity-90 bg-primary ${isMobile ? 'flex-1 px-3 py-2 text-sm' : 'px-4 py-2'}`}
            >
              <Plus className={isMobile ? 'w-4 h-4' : 'w-5 h-5'} />
              <span>Create MTB</span>
            </button>
          </div>
        </div>

        <div className={isMobile ? 'space-y-2' : 'flex items-center gap-3'}>
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search MTBs by name"
              className="w-full pl-9 pr-3 py-2 border border-border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'owner-first' | 'name-asc' | 'experts-desc')}
            className={`${isMobile ? 'w-full' : 'w-56'} px-3 py-2 border border-border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary`}
          >
            <option value="owner-first">Owner First</option>
            <option value="name-asc">Name A-Z</option>
            <option value="experts-desc">Experts (High to Low)</option>
          </select>
        </div>

        {loading ? (
          <div className={`text-center text-text-muted ${isMobile ? 'py-6' : 'py-8'}`}>Loading MTBs...</div>
        ) : sortedMtbs.length === 0 ? (
          <div className={`text-center text-text-muted ${isMobile ? 'py-6' : 'py-8'}`}>No MTBs yet. Create or join one!</div>
        ) : (
          <div className={`grid gap-3 ${isMobile ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4'}`}>
            {sortedMtbs.map((mtb) => {
              const isOwner = mtb.ownerId === user?.id;
              return (
                <div
                  key={mtb.id}
                  onClick={() => navigate(`/mtb/${mtb.id}`)}
                  className="bg-surface rounded-xl shadow-sm border border-border hover:shadow-md transition-shadow cursor-pointer overflow-hidden"
                >
                  <div className="flex">
                    <div className="w-1.5 bg-primary" />
                    <div className="p-4 flex-1">
                      <div className="mb-3 flex items-start justify-between gap-2">
                        <h3 className="text-base font-semibold line-clamp-2 text-text-muted">{mtb.name}</h3>
                        <span
                          className={`px-2.5 py-1 text-xs rounded-full font-medium whitespace-nowrap ${
                            isOwner ? 'bg-status-verified-bg text-status-verified-text' : 'bg-status-processing-bg text-status-processing-text'
                          }`}
                        >
                          {isOwner ? 'Owner' : 'Member'}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-3 pt-3 border-t border-border">
                        <div className="flex items-center gap-2">
                          <Users className="w-4 h-4 text-primary" />
                          <div>
                            <p className="text-xs text-text-muted">Experts</p>
                            <p className="text-sm font-semibold text-text-muted">{mtb.experts}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-primary" />
                          <div>
                            <p className="text-xs text-text-muted">Cases</p>
                            <p className="text-sm font-semibold text-text-muted">{mtb.cases.length}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        title="Create New MTB"
      >
        <div className="space-y-5">
          <div>
            <label htmlFor="mtbName" className="block text-sm font-medium mb-2 text-text-muted">
              MTB Name
            </label>
            <input
              id="mtbName"
              type="text"
              value={mtbName}
              onChange={(e) => setMtbName(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
              placeholder="e.g., Thoracic Oncology Board"
            />
          </div>
          <div>
            <label htmlFor="mtbDescription" className="block text-sm font-medium mb-2 text-text-muted">
              Description (Optional)
            </label>
            <textarea
              id="mtbDescription"
              value={mtbDescription}
              onChange={(e) => setMtbDescription(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent resize-none"
              rows={3}
              placeholder="Add a brief description for this MTB"
            />
            <p className="mt-1.5 text-xs text-text-muted">
              Help others understand the purpose and focus area of this board.
            </p>
          </div>
          {error && <div className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</div>}
          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={() => setShowCreateModal(false)}
              disabled={submitting}
              className="px-4 py-2 border border-border rounded-lg text-sm font-medium text-text hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleCreateMTB}
              disabled={submitting || !mtbName.trim()}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed bg-primary"
            >
              {submitting ? 'Creating...' : 'Create MTB'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showJoinModal}
        onClose={() => setShowJoinModal(false)}
        title="Join MTB"
      >
        <div className="space-y-5">
          <div>
            <label htmlFor="mtbCode" className="block text-sm font-medium mb-2 text-text-muted">
              Enter Invite Code
            </label>
            <input
              id="mtbCode"
              type="text"
              value={mtbCode}
              onChange={(e) => setMtbCode(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
              placeholder="e.g., ABC123XYZ"
            />
            <p className="mt-1.5 text-xs text-text-muted">
              Ask the MTB owner for the invitation code to join.
            </p>
          </div>
          {error && <div className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</div>}
          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={() => setShowJoinModal(false)}
              disabled={submitting}
              className="px-4 py-2 border border-border rounded-lg text-sm font-medium text-text hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleJoinMTB}
              disabled={submitting || !mtbCode.trim()}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed bg-primary"
            >
              {submitting ? 'Joining...' : 'Join MTB'}
            </button>
          </div>
        </div>
      </Modal>
    </Layout>
  );
}
