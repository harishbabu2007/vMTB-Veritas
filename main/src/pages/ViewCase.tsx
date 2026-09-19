import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { MessageSquare, Edit2, Trash2, CheckCircle, Plus, ArrowLeft, AlertTriangle, Filter, ChevronDown, Check, Lock, Archive, ArchiveRestore, Users, Info } from 'lucide-react';
import { marked } from 'marked';
import TurndownService from 'turndown';
import DOMPurify from 'dompurify';
import { Layout } from '../components/Layout';
import { Modal } from '../components/Modal';
import { EditorToolbar } from '../components/EditorToolbar';
import { Reports } from '../components/Reports';
import { VerifyModal } from '../components/VerifyModal';
import { OpinionComment } from '../components/OpinionComment';
import { InlineOpinionInput } from '../components/InlineOpinionInput';
import { useTourGroup } from '../hooks/useTourGroup';
import { TreatmentPlanFollowUp } from '../components/TreatmentPlanFollowUp';
import { VoiceRecorder } from '../components/VoiceRecorder';
import { useCases, Case, Opinion, Question } from '../context/CasesContext';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../Supabase/client';
import { showToast } from '../utils/toast';
import { useIsMobile } from '../hooks/useMobile';
import { useDismissed } from '../hooks/useDismissed';
import { DismissButton } from '../components/DismissButton';
import { getMtbCaseStatusMeta } from '../utils/summaryStatus';
import { CaseUpdateStatus } from '../components/CaseUpdateStatus';
import { useCaseRunState } from '../hooks/useCaseRunState';
import { useRunActions } from '../hooks/useRunActions';
import { PipelineError } from '../services/pipelineService';

type TabType = 'summary' | 'reports' | 'opinions' | 'treatmentfollowup' | 'settings';

export function ViewCase() {
  const { id, mtbId: mtbIdFromPath } = useParams<{ id: string; mtbId?: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { mtbs, getCaseById, getCaseOpinions, refreshCase, addOpinion, deleteCase, verifySummary, saveSummaryEdit, regenerateSummary, removeCaseFromMTB, addCaseToMTBs, archiveCase, unarchiveCase } = useCases();
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [caseData, setCaseData] = useState<Case | null>(null);
  const [loading, setLoading] = useState(false);
  const loadedCaseIdRef = useRef<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('summary');
  // Reports and Treatment stay mounted after their first visit so switching
  // tabs doesn't refetch them.
  const [visitedTabs, setVisitedTabs] = useState<Set<TabType>>(() => new Set(['summary']));
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Case Settings: MTB sharing, archive
  const [mtbToRemove, setMtbToRemove] = useState<{ id: string; name: string } | null>(null);
  const [showAddToMtbModal, setShowAddToMtbModal] = useState(false);
  const [selectedAddMtbIds, setSelectedAddMtbIds] = useState<string[]>([]);
  const [addingToMtbs, setAddingToMtbs] = useState(false);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [removingFromMTB, setRemovingFromMTB] = useState(false);
  const [savingCase, setSavingCase] = useState(false);
  const [editingCase, setEditingCase] = useState(false);
  const [renderedHTML, setRenderedHTML] = useState('');
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [verifyModalMode, setVerifyModalMode] = useState<'confirm' | 'blocked'>('confirm');
  const [verifyingProgress, setVerifyingProgress] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [patientDetailsError, setPatientDetailsError] = useState<string | null>(null);
  const [patientForm, setPatientForm] = useState({
    patientName: '',
    age: '',
    sex: '',
    cancerType: '',
  });
  
  // Opinions page state (inline, no modals)
  const [showAddQuestionModal, setShowAddQuestionModal] = useState(false);
  const [newQuestionText, setNewQuestionText] = useState('');
  const [addingQuestion, setAddingQuestion] = useState(false);
  const questionTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-resize for Add Question textarea up to ~20 lines
  useEffect(() => {
    const textarea = questionTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const lineHeight = 22;
    const minHeight = 4 * lineHeight + 16;
    const maxHeight = 20 * lineHeight + 16;
    const scrollHeight = textarea.scrollHeight;
    const targetHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${targetHeight}px`;
    textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [newQuestionText]);
  const [opinionMtbs, setOpinionMtbs] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedOpinionMtbId, setSelectedOpinionMtbId] = useState<string | null>(null);
  const [opinionsLoading, setOpinionsLoading] = useState(false);
  const opinionsRequestRef = useRef(0);
  const [showMtbFilterMenu, setShowMtbFilterMenu] = useState(false);
  
  // Ref for contenteditable div
  const editorRef = useRef<HTMLDivElement>(null);
  const mtbFilterMenuRef = useRef<HTMLDivElement>(null);

  // Initialize Turndown service for HTML to Markdown conversion
  const turndownService = useRef(
    new TurndownService({
      headingStyle: 'atx',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced'
    })
  );

  // Configure marked options
  useEffect(() => {
    marked.setOptions({
      breaks: true, // Convert line breaks to <br>
      gfm: true // GitHub Flavored Markdown
    });
  }, []);

  // MTB members see what the owner last VERIFIED while a newer version of the
  // case (changed documents, a regenerated summary) is still unverified —
  // never a summary that may not match its documents, and never content the
  // owner hasn't signed off. Cases verified before snapshots existed have no
  // snapshot and keep showing the live version.
  const memberSnapshot =
    caseData && user && caseData.ownerId !== user.id && caseData.verifiedSnapshot &&
    caseData.verifiedGeneration != null && caseData.verifiedGeneration !== caseData.contentGeneration
      ? caseData.verifiedSnapshot
      : null;
  const shownSummary = memberSnapshot ? memberSnapshot.summary : caseData?.summary;

  // Closable notices, each keyed to the state it describes so a later change
  // (a newer update, re-archiving) shows it again.
  const [archivedNoticeDismissed, dismissArchivedNotice] = useDismissed(
    caseData?.archivedAt ? `case-archived:${caseData.id}:${caseData.archivedAt}` : null
  );
  const [memberNoticeDismissed, dismissMemberNotice] = useDismissed(
    caseData ? `case-member-update:${caseData.id}:${caseData.contentGeneration}:${caseData.summaryStatus}` : null
  );

  // Convert markdown to HTML when summary changes
  useEffect(() => {
    if (shownSummary) {
      const html = marked.parse(shownSummary) as string;
      const sanitized = DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['p', 'strong', 'em', 'u', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'br'],
        ALLOWED_ATTR: []
      });
      setRenderedHTML(sanitized);
    } else {
      setRenderedHTML('');
    }
  }, [shownSummary]);

  // Handle toolbar formatting commands
  const handleFormat = (command: string, value?: string) => {
    if (value) {
      document.execCommand(command, false, value);
    } else {
      document.execCommand(command, false);
    }
    // Keep focus on editor
    editorRef.current?.focus();
  };

  // Handle paste to strip formatting and keep only plain text
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (!editingCase) return;
    
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  };

  const isOwner = caseData?.ownerId === user?.id;
  const viewMode = isOwner ? 'owner' : 'visitor';
  // A brand-new case has summaryStatus undefined/'processing' with no summary
  // text yet at all — the null/undefined check alone catches that. An edit
  // that re-triggers summarization instead leaves the OLD summary text in
  // place until the new one lands, so summary_status is the only signal
  // that distinguishes "regenerating" from "done" in that case; without it
  // this would silently show the stale summary as final while it's still
  // being rebuilt.
  const isProcessingSummary = memberSnapshot
    ? false
    : caseData?.summaryStatus === 'processing' || caseData?.summary === null || caseData?.summary === undefined;
  const shownAge = memberSnapshot ? memberSnapshot.patient_age : caseData?.age ?? null;
  const shownSex = memberSnapshot ? memberSnapshot.patient_sex : caseData?.sex ?? null;
  const shownCancerType = memberSnapshot ? memberSnapshot.cancer_type ?? caseData?.cancerType : caseData?.cancerType;
  const mtbIdFromQuery = searchParams.get('mtbId');
  const currentMtbId = mtbIdFromPath || mtbIdFromQuery || null;
  const fromMTB = searchParams.get('from') === 'mtb' || Boolean(currentMtbId);
  // "You" is redundant on the owner's own My Cases view; it's only useful to
  // distinguish "a case you own" among other members' cases inside an MTB.
  const showYouBadge = isOwner && fromMTB;
  // The owner always sees the patient name, regardless of how they opened
  // the case; non-owners viewing via an MTB never do (a non-owner shouldn't
  // reach the bare /case/:id route at all, so `!fromMTB` already implies
  // isOwner in practice -- this is written explicitly rather than relying on
  // that).
  const showPatientName = isOwner || !fromMTB;
  const everVerified = Boolean(caseData?.firstVerifiedAt);
  const activeOpinionMtbId = selectedOpinionMtbId || currentMtbId;
  const showCompactMtbFilter = Boolean(isOwner && opinionMtbs.length > 1);
  const activeOpinionMtbName = opinionMtbs.find(m => m.id === activeOpinionMtbId)?.name || '';

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!mtbFilterMenuRef.current) return;
      if (!mtbFilterMenuRef.current.contains(event.target as Node)) {
        setShowMtbFilterMenu(false);
      }
    };

    if (showMtbFilterMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showMtbFilterMenu]);

  const fetchSharedMtbsForCase = async (caseId: string): Promise<Array<{ id: string; name: string }>> => {
    const { data, error } = await supabase
      .from('mtb_cases')
      .select('mtb_id, mtbs(id, name)')
      .eq('case_id', caseId);

    if (error) throw error;

    const parsed = (data || [])
      .map((row: any) => {
        const mtb = Array.isArray(row.mtbs) ? row.mtbs[0] : row.mtbs;
        return mtb?.id && mtb?.name ? { id: mtb.id as string, name: mtb.name as string } : null;
      })
      .filter(Boolean) as Array<{ id: string; name: string }>;

    return Array.from(new Map(parsed.map(m => [m.id, m])).values());
  };

  // Merge a freshly read `cases` row into the loaded case, keeping the
  // separately loaded questions/opinions/documents/follow-ups.
  const mergeCaseRow = (row: Case | null) => {
    if (!row) return;
    setCaseData(prev => (prev && prev.id === row.id ? { ...prev, ...row } : prev));
  };

  // The owner's live view of processing: whenever a run moves on (another
  // tab saved, a summary landed, a run failed), re-read the case row so the
  // summary, status and the version being verified are never stale.
  const runState = useCaseRunState(isOwner ? id : undefined, () => {
    if (id) refreshCase(id).then(mergeCaseRow).catch(() => undefined);
  });
  const runActions = useRunActions(isOwner ? id : undefined, runState);

  const loadOpinionsForMtb = async (mtbId: string, showOpinionLoading = false) => {
    if (!id) return;
    const requestId = ++opinionsRequestRef.current;
    if (showOpinionLoading) setOpinionsLoading(true);
    try {
      const opinions = await getCaseOpinions(id, mtbId);
      // Ignore a slower response for an MTB the user has already switched away from.
      if (requestId !== opinionsRequestRef.current) return;
      setCaseData(prev => (prev ? { ...prev, opinions } : prev));
    } catch (err) {
      console.error('Failed to load opinions:', err);
      showToast.error('Failed to load discussions for this MTB.');
    } finally {
      if (showOpinionLoading && requestId === opinionsRequestRef.current) setOpinionsLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const fetchCase = async () => {
      if (!id) return;
      // Full-page loading state only for the first load of this case; a
      // re-run (e.g. MTB context change) keeps the page on screen.
      const isFirstLoad = loadedCaseIdRef.current !== id;
      if (isFirstLoad) setLoading(true);
      try {
        const [baseData, sharedMtbs] = await Promise.all([
          getCaseById(id, currentMtbId ? { mtbId: currentMtbId } : undefined),
          fetchSharedMtbsForCase(id).catch((err) => {
            console.error('Failed to fetch MTBs for case:', err);
            return [] as Array<{ id: string; name: string }>;
          }),
        ]);
        if (cancelled) return;

        if (!baseData) {
          setCaseData(null);
          return;
        }

        let defaultMtbId: string | null = currentMtbId;
        if (baseData.ownerId === user?.id) {
          setOpinionMtbs(sharedMtbs);
          if (!(currentMtbId && sharedMtbs.some(m => m.id === currentMtbId))) {
            defaultMtbId = sharedMtbs[0]?.id || null;
          }
        } else {
          setOpinionMtbs([]);
        }

        setSelectedOpinionMtbId(defaultMtbId);

        let opinions = baseData.opinions || [];
        if (!defaultMtbId) {
          opinions = [];
        } else if (defaultMtbId !== currentMtbId) {
          opinions = await getCaseOpinions(id, defaultMtbId);
          if (cancelled) return;
        }
        setCaseData({ ...baseData, opinions });
        loadedCaseIdRef.current = id;
      } catch (err) {
        console.error('Failed to fetch case:', err);
      } finally {
        if (!cancelled && isFirstLoad) setLoading(false);
      }
    };
    fetchCase();
    return () => { cancelled = true; };
    // Context functions are stable; keyed only on what identifies the view.
  }, [id, user?.id, currentMtbId, getCaseById, getCaseOpinions]);

  // Snap back to the Summary tab if the active tab is locked -- e.g. a
  // never-verified case loaded while a stale/deep-linked non-summary tab
  // was selected.
  useEffect(() => {
    if (!caseData) return;
    if (activeTab !== 'summary' && !everVerified) {
      setActiveTab('summary');
    }
  }, [caseData, everVerified, activeTab]);

  useEffect(() => {
    if (!caseData) return;
    setPatientForm({
      patientName: caseData.patientName || '',
      age: caseData.age ? String(caseData.age) : '',
      sex: caseData.sex || '',
      cancerType: caseData.cancerType || '',
    });
  }, [caseData]);

  // Poll backend for processing cases to auto-refresh summary/status. Only the
  // `cases` row can change while processing, so only that row is re-read.
  useEffect(() => {
    if (!id) return;
    if (caseData?.summaryStatus !== 'processing') return;

    const interval = setInterval(async () => {
      try {
        mergeCaseRow(await refreshCase(id));
      } catch (err) {
        console.error('Failed to refresh case status:', err);
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [id, caseData?.summaryStatus, refreshCase]);

  const handleCheckStatusNow = async () => {
    if (!id) return;
    setCheckingStatus(true);
    try {
      mergeCaseRow(await refreshCase(id));
    } catch (err) {
      console.error('Failed to refresh case status:', err);
      showToast.error('Could not check the summary status. Try again in a moment.');
    } finally {
      setCheckingStatus(false);
    }
  };

  const startEditingCase = () => {
    if (!caseData) return;
    setPatientDetailsError(null);
    setPatientForm({
      patientName: caseData.patientName || '',
      age: caseData.age != null ? String(caseData.age) : '',
      sex: caseData.sex || '',
      cancerType: caseData.cancerType || '',
    });
    setEditingCase(true);
  };

  const cancelEditingCase = () => {
    // Reset the summary preview back to the last-saved version
    if (caseData?.summary) {
      const html = marked.parse(caseData.summary) as string;
      const sanitized = DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['p', 'strong', 'em', 'u', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'br'],
        ALLOWED_ATTR: []
      });
      setRenderedHTML(sanitized);
    }
    setPatientDetailsError(null);
    setEditingCase(false);
  };

  const handlePatientFieldChange = (field: 'patientName' | 'age' | 'sex' | 'cancerType', value: string) => {
    setPatientForm(prev => ({ ...prev, [field]: value }));
  };

  // Shared by "Save Changes" and "Save & Verify". requireForVerify additionally
  // demands the fields the verify gate checks (age/sex), so the user fixes them
  // here rather than saving and then being blocked by the verify dialog.
  const saveCaseChanges = async (requireForVerify: boolean): Promise<boolean> => {
    if (!id || !isOwner || !caseData) return false;

    const trimmedAge = patientForm.age.trim();
    const parsedAge = trimmedAge ? Number.parseInt(trimmedAge, 10) : null;
    if (trimmedAge && (!Number.isFinite(parsedAge) || (parsedAge as number) <= 0)) {
      setPatientDetailsError('Please enter a valid age.');
      return false;
    }
    if (!patientForm.cancerType.trim()) {
      setPatientDetailsError('Cancer type is required.');
      return false;
    }
    if (requireForVerify) {
      const missing: string[] = [];
      if (parsedAge == null) missing.push('age');
      if (!patientForm.sex.trim()) missing.push('sex');
      if (missing.length > 0) {
        setPatientDetailsError(`Please fill in ${missing.join(' and ')} before verifying.`);
        return false;
      }
    }

    setSavingCase(true);
    setPatientDetailsError(null);
    try {
      // Get HTML from contenteditable
      const html = editorRef.current?.innerHTML || '';

      // Sanitize HTML
      const cleanHTML = DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['p', 'strong', 'em', 'u', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'br'],
        ALLOWED_ATTR: []
      });

      // Convert HTML to Markdown
      const markdown = turndownService.current.turndown(cleanHTML);

      // caseName is system-generated and not editable, so it is never updated
      // here. Saved through save_case_summary_edit, which refuses while a new
      // summary is being generated (it would overwrite this edit) or if the
      // case changed since this version was loaded.
      const updated = await saveSummaryEdit(id, caseData.contentGeneration ?? 0, {
        summary: markdown,
        patientName: patientForm.patientName.trim(),
        patientAge: parsedAge,
        patientSex: patientForm.sex || null,
        cancerType: patientForm.cancerType.trim(),
      });
      if (!updated) throw new Error('Case was not updated');
      mergeCaseRow(updated);
      setEditingCase(false);
      return true;
    } catch (err) {
      console.error('Failed to save case:', err);
      if (err instanceof PipelineError && (err.code === 'STALE_GENERATION' || err.code === 'SUMMARY_NOT_READY')) {
        setPatientDetailsError(
          err.code === 'SUMMARY_NOT_READY'
            ? 'A new summary is being generated from updated documents, so this edit wasn’t saved. Copy anything you want to keep, then edit the new summary once it’s ready.'
            : 'This case changed since you started editing, so this edit wasn’t saved. Copy anything you want to keep, then reload.'
        );
        runState.refresh();
      } else {
        setPatientDetailsError(err instanceof Error ? err.message : 'Failed to save changes. Please try again.');
      }
      return false;
    } finally {
      setSavingCase(false);
    }
  };

  const handleSaveCase = () => {
    void saveCaseChanges(false);
  };

  const handleSaveAndVerify = async () => {
    const saved = await saveCaseChanges(true);
    if (!saved) return;
    setVerifyModalMode('confirm');
    setShowVerifyModal(true);
  };

  const handleRegenerateSummary = async () => {
    if (!id || !isOwner || !caseData) return;
    setRegenerating(true);
    try {
      mergeCaseRow(await regenerateSummary(id));
      runState.refresh();
      showToast.success('Regenerating the case summary — this may take a few minutes.');
      // Exit edit mode: if the user is still here when the new summary
      // lands, they should see the fresh result, not a stale edit session.
      setEditingCase(false);
    } catch (err) {
      console.error('Failed to regenerate summary:', err);
      showToast.error(err instanceof Error ? err.message : 'Failed to regenerate summary.');
    } finally {
      setRegenerating(false);
    }
  };

  const handleVerifySummary = async () => {
    if (!id || !isOwner) return;
    setVerifyingProgress(true);
    try {
      // The version shown on screen is the one being verified; if the case has
      // moved on since, the backend refuses rather than verifying unseen content.
      const updated = await verifySummary(id, caseData?.contentGeneration ?? 0);
      setShowVerifyModal(false);
      mergeCaseRow(updated);
    } catch (err) {
      console.error('Failed to verify summary:', err);
      showToast.error(err instanceof Error ? err.message : 'Failed to verify this case. Please try again.');
      setShowVerifyModal(false);
      if (id) refreshCase(id).then(mergeCaseRow).catch(() => undefined);
      runState.refresh();
    } finally {
      setVerifyingProgress(false);
    }
  };

  const handleVerifyClick = () => {
    if (!caseData) return;
    // Age/sex are AI-extracted now, not manually entered, so they may not
    // have been detected — verifying without them isn't allowed.
    const missingPatientDetails = caseData.age == null || !caseData.sex;
    setVerifyModalMode(missingPatientDetails ? 'blocked' : 'confirm');
    setShowVerifyModal(true);
  };

  const appendOpinion = (opinion: Opinion) => {
    setCaseData(prev => (prev ? { ...prev, opinions: [...(prev.opinions || []), opinion] } : prev));
  };

  // Inline opinion submission handlers
  const handleSubmitGeneralOpinion = async (content: string) => {
    if (!id) return;
    if (!activeOpinionMtbId) {
      showToast.error('Select an MTB context to post opinions.');
      return;
    }
    appendOpinion(await addOpinion(id, content, null, null, activeOpinionMtbId));
  };

  const handleSubmitQuestionOpinion = async (questionId: string, content: string) => {
    if (!id) return;
    if (!activeOpinionMtbId) {
      showToast.error('Select an MTB context to post opinions.');
      return;
    }
    appendOpinion(await addOpinion(id, content, questionId, null, activeOpinionMtbId));
  };

  const handleSubmitReply = async (parentId: string, questionId: string | null, content: string) => {
    if (!id) return;
    if (!activeOpinionMtbId) {
      showToast.error('Select an MTB context to post replies.');
      return;
    }
    appendOpinion(await addOpinion(id, content, questionId, parentId, activeOpinionMtbId));
  };

  const handleAddQuestion = async () => {
    if (!id || !newQuestionText.trim()) return;

    setAddingQuestion(true);
    try {
      const { data, error } = await supabase
        .from('case_questions')
        .insert({
          case_id: id,
          question_text: newQuestionText.trim(),
        })
        .select('id, question_text')
        .single();
      if (error) throw error;

      const question: Question = { id: data.id, text: data.question_text };
      setCaseData(prev => (prev ? { ...prev, questions: [...(prev.questions || []), question] } : prev));

      setNewQuestionText('');
      setShowAddQuestionModal(false);
    } catch (err) {
      console.error('Failed to add question:', err);
      showToast.error('Failed to add question. Please try again.');
    } finally {
      setAddingQuestion(false);
    }
  };

  const handleDeleteCase = async () => {
    if (!id || !isOwner) return;
    setDeleting(true);
    try {
      await deleteCase(id);
      navigate('/my-cases');
    } catch (err) {
      console.error('Failed to delete case:', err);
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const canPostOpinions = Boolean(activeOpinionMtbId) && (isOwner || fromMTB);

  // Walkthrough tips: reviewing and verifying your own case once its summary
  // is ready, and posting opinions the first time the Opinions tab is usable.
  useTourGroup(
    'case_review',
    !loading && Boolean(caseData) && isOwner && activeTab === 'summary' &&
      !isProcessingSummary && caseData?.summaryStatus !== 'failed'
  );
  useTourGroup('opinions', !loading && activeTab === 'opinions' && canPostOpinions && !opinionsLoading);
  // The first time the owner opens each of these tabs.
  const ownCaseLoaded = !loading && Boolean(caseData) && isOwner;
  useTourGroup('reports', ownCaseLoaded && activeTab === 'reports');
  useTourGroup('treatment', ownCaseLoaded && activeTab === 'treatmentfollowup');
  useTourGroup('case_settings', ownCaseLoaded && activeTab === 'settings');

  // Sharing follows the same rule as MTBDetail's Add Case list: verified, not archived.
  const shareBlockedReason = caseData?.archivedAt
    ? 'Restore the case to share it'
    : caseData?.summaryStatus !== 'verified'
    ? 'Verify the summary before sharing'
    : null;
  const canShareToMtbs = !shareBlockedReason;
  const addableMtbs = mtbs.filter(m => !opinionMtbs.some(shared => shared.id === m.id));

  const handleRemoveFromMTB = async () => {
    if (!mtbToRemove || !id) return;
    const removedId = mtbToRemove.id;
    setRemovingFromMTB(true);
    try {
      await removeCaseFromMTB(removedId, id);
      const remaining = opinionMtbs.filter(m => m.id !== removedId);
      setOpinionMtbs(remaining);
      showToast.success(`Removed from ${mtbToRemove.name}`);
      setMtbToRemove(null);
      if (removedId === currentMtbId) {
        // The MTB this page was opened through no longer has the case.
        navigate(`/case/${id}`, { replace: true });
      } else if (removedId === selectedOpinionMtbId) {
        const next = remaining[0]?.id ?? null;
        setSelectedOpinionMtbId(next);
        if (next) {
          void loadOpinionsForMtb(next);
        } else {
          setCaseData(prev => (prev ? { ...prev, opinions: [] } : prev));
        }
      }
    } catch (err) {
      console.error('Failed to remove case from MTB:', err);
      showToast.error('Failed to remove the case from this MTB. Please try again.');
    } finally {
      setRemovingFromMTB(false);
    }
  };

  const handleAddToMtbs = async () => {
    if (!id || selectedAddMtbIds.length === 0) return;
    setAddingToMtbs(true);
    try {
      await addCaseToMTBs(id, selectedAddMtbIds);
      const added = mtbs
        .filter(m => selectedAddMtbIds.includes(m.id))
        .map(m => ({ id: m.id, name: m.name }));
      setOpinionMtbs(prev => [...prev, ...added]);
      if (!selectedOpinionMtbId && added[0]) {
        setSelectedOpinionMtbId(added[0].id);
        void loadOpinionsForMtb(added[0].id);
      }
      showToast.success(`Added to ${added.length} MTB${added.length === 1 ? '' : 's'}`);
      setShowAddToMtbModal(false);
      setSelectedAddMtbIds([]);
    } catch (err) {
      console.error('Failed to add case to MTBs:', err);
      showToast.error('Failed to add the case to MTBs. Please try again.');
    } finally {
      setAddingToMtbs(false);
    }
  };

  const handleArchiveCase = async () => {
    if (!id) return;
    setArchiving(true);
    try {
      await archiveCase(id);
      showToast.success('Case archived');
      navigate('/my-cases?view=archived');
    } catch (err) {
      console.error('Failed to archive case:', err);
      showToast.error(err instanceof Error ? err.message : 'Failed to archive the case. Please try again.');
      setArchiving(false);
      setShowArchiveConfirm(false);
    }
  };

  const handleRestoreCase = async () => {
    if (!id) return;
    setRestoring(true);
    try {
      mergeCaseRow(await unarchiveCase(id));
      showToast.success('Case restored to My Cases');
    } catch (err) {
      console.error('Failed to restore case:', err);
      showToast.error('Failed to restore the case. Please try again.');
    } finally {
      setRestoring(false);
    }
  };

  const handleSelectOpinionMtb = async (nextMtbId: string) => {
    setSelectedOpinionMtbId(nextMtbId);
    setShowMtbFilterMenu(false);
    await loadOpinionsForMtb(nextMtbId, true);
  };

  if (loading) {
    return (
      <Layout>
        <div className="text-center py-12">
          <p className="text-text-muted">Loading case...</p>
        </div>
      </Layout>
    );
  }

  if (!caseData) {
    return (
      <Layout>
        <div className="text-center py-12">
          <p className="text-text-muted">Case not found</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout wide>
      <div className="w-full flex justify-center">
        <div className="w-full">
          {/* Back Arrow + Tab Navigation in one row. Scrolls with the page
              until it reaches the top nav, then stays pinned under it (offset
              and background in index.css) while the tab content scrolls. */}
          <div className="case-tabs-sticky border-b border-border mb-4">
            <nav className={`-mb-px flex items-center ${isMobile ? 'overflow-x-auto no-scrollbar gap-1' : 'gap-6'}`}>
              <button
                onClick={() => navigate(-1)}
                className="flex-shrink-0 mr-2 text-text-muted hover:text-text transition-colors"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              {(['summary', 'reports', 'opinions', 'treatmentfollowup', 'settings'] as TabType[]).map((tab) => {
                // Locked until the case has been verified for the first time
                // (caseData.firstVerifiedAt), not by live summaryStatus — a
                // later regeneration (redaction edit, Regenerate Summary)
                // cycles summaryStatus back to processing/unverified, but
                // firstVerifiedAt is set once and never cleared, so the
                // documents/opinions/treatment plan behind these tabs stay
                // reachable throughout. Only the Summary tab's own content
                // (above) reflects live summaryStatus.
                const isLocked = tab !== 'summary' && !everVerified;
                const tabLabel = isMobile
                  ? (tab === 'summary' ? 'Summary' :
                     tab === 'reports' ? 'Reports' :
                     tab === 'opinions' ? 'Opinions' :
                     tab === 'treatmentfollowup' ? 'Treatment' :
                     'Settings')
                  : (tab === 'summary' ? 'Case Summary' :
                     tab === 'reports' ? 'Reports' :
                     tab === 'opinions' ? 'Opinions' :
                     tab === 'treatmentfollowup' ? 'Treatment Plan & Follow-Up' :
                     'Case Settings');
                return (
                  <button
                    key={tab}
                    onClick={() => {
                      if (isLocked) {
                        showToast.error('Verify the case first to unlock this tab.');
                        return;
                      }
                      setActiveTab(tab);
                      setVisitedTabs(prev => (prev.has(tab) ? prev : new Set(prev).add(tab)));
                    }}
                    title={isLocked ? 'Verify the case first to unlock this tab' : undefined}
                    aria-disabled={isLocked || undefined}
                    data-tour={tab === 'summary' ? 'tab-summary' : tab === 'reports' ? 'tab-reports' : undefined}
                    className={`flex items-center gap-1.5 border-b-2 font-medium transition-colors whitespace-nowrap flex-shrink-0 ${
                      isMobile ? 'py-2.5 px-2 text-xs' : 'py-3 px-0.5 text-sm'
                    } ${
                      isLocked
                        ? 'border-transparent text-gray-300 cursor-not-allowed'
                        : activeTab === tab
                        ? 'text-blue-600' + ' border-blue-500'
                        : 'border-transparent text-text-muted hover:text-text hover:border-border'
                    }`}
                  >
                    {isLocked && <Lock className="w-3 h-3" />}
                    {tabLabel}
                  </button>
                );
              })}
            </nav>
          </div>

          {caseData.archivedAt && !archivedNoticeDismissed && (
            <div className="mb-4 flex items-center justify-between gap-4 flex-wrap px-4 py-3 rounded-lg border border-border bg-surface">
              <div className="flex items-center gap-3 min-w-0">
                <Archive className="w-4 h-4 text-text-muted flex-shrink-0" />
                <p className="text-sm text-text-muted">
                  <span className="font-medium">Archived on {new Date(caseData.archivedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.</span>{' '}
                  It's hidden from My Cases and isn't shared with any MTB.
                </p>
              </div>
              {isOwner && (
                <button
                  onClick={handleRestoreCase}
                  disabled={restoring}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-border text-text rounded-lg hover:bg-bg transition-colors disabled:opacity-50"
                >
                  <ArchiveRestore className="w-4 h-4" />
                  <span>{restoring ? 'Restoring…' : 'Restore'}</span>
                </button>
              )}
              <DismissButton onClick={dismissArchivedNotice} label="Dismiss this notice" className="text-text-muted" />
            </div>
          )}

          {/* Tab Content */}
          {visitedTabs.has('reports') && (
            <div hidden={activeTab !== 'reports'}>
              <Reports
                caseData={caseData}
                isOwner={isOwner}
                snapshotGeneration={memberSnapshot ? caseData.verifiedGeneration ?? null : null}
                onCaseChange={(patch) => setCaseData(prev => (prev ? { ...prev, ...patch } : prev))}
              />
            </div>
          )}
          {visitedTabs.has('treatmentfollowup') && (
            <div hidden={activeTab !== 'treatmentfollowup'}>
              <TreatmentPlanFollowUp caseId={id!} isOwner={isOwner} />
            </div>
          )}
          {activeTab !== 'reports' && activeTab !== 'treatmentfollowup' && (
            <div className={isMobile ? 'space-y-4' : 'space-y-6'}>
              {/* === CASE SUMMARY TAB === */}
              {activeTab === 'summary' && (
                <>
                  {/* Where the owner's latest changes stand: applying, failed (with
                      Retry), or waiting for them to verify the new summary. */}
                  {isOwner && !editingCase && (
                    <CaseUpdateStatus
                      caseId={id}
                      runState={runState.state}
                      isOwner={isOwner}
                      startFailed={runActions.startFailed}
                      busy={runActions.retrying}
                      onStartRun={runActions.startCurrentRun}
                      onRetryRun={runActions.retryFailedRun}
                    />
                  )}

                  {/* MTB members must not read a changed-but-unverified case as
                      the one they reviewed. */}
                  {memberSnapshot && !memberNoticeDismissed && (
                    <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-amber-50 text-amber-800" role="status">
                      <Info className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
                      <div className="text-sm">
                        <p className="font-medium">The owner has updated this case. The changes aren’t verified yet</p>
                        <p className="mt-0.5 opacity-90">
                          You’re viewing the last verified version
                          {memberSnapshot.verified_at
                            ? ` (verified ${new Date(memberSnapshot.verified_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })})`
                            : ''}
                          , including its documents. The update appears here once the owner verifies it.
                        </p>
                      </div>
                      <DismissButton onClick={dismissMemberNotice} label="Dismiss this notice" className="ml-auto" />
                    </div>
                  )}
                  {!isOwner && fromMTB && !memberSnapshot && !memberNoticeDismissed && getMtbCaseStatusMeta(caseData.summaryStatus) && (
                    <div className={`flex items-start gap-3 px-4 py-3 rounded-lg ${getMtbCaseStatusMeta(caseData.summaryStatus)!.className}`} role="status">
                      <Info className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
                      <div className="text-sm">
                        <p className="font-medium">{getMtbCaseStatusMeta(caseData.summaryStatus)!.label}</p>
                        <p className="mt-0.5 opacity-90">
                          {getMtbCaseStatusMeta(caseData.summaryStatus)!.description} What you see below may still change.
                        </p>
                      </div>
                      <DismissButton onClick={dismissMemberNotice} label="Dismiss this notice" className="ml-auto" />
                    </div>
                  )}
                  {/* Case Details & Summary — one section, one Edit affordance */}
                  <div className="bg-surface rounded-xl shadow-sm border border-border p-6">
                    {/* Case details fields + actions — one line: fields left, buttons right */}
                    <div className="flex items-start justify-between gap-4 flex-wrap pb-4 mb-4 border-b border-border">
                      <div className="flex flex-wrap gap-x-6 gap-y-3">
                        <div className="w-40">
                          <p className="text-xs text-gray-400">Case</p>
                          {/* System-generated: read-only even while editing */}
                          <p className="text-sm font-semibold truncate text-text-muted" title={caseData.caseName}>{caseData.caseName}</p>
                        </div>
                        {showPatientName && (
                          <div className="w-32">
                            <p className="text-xs text-gray-400">Patient</p>
                            {editingCase ? (
                              <input
                                type="text"
                                value={patientForm.patientName}
                                onChange={(e) => handlePatientFieldChange('patientName', e.target.value)}
                                placeholder="Anonymous"
                                className="w-full text-sm px-2 py-1 border border-border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                                disabled={savingCase}
                              />
                            ) : (
                              <p className="text-sm font-medium truncate text-text-muted" title={caseData.patientName || 'Anonymous'}>{caseData.patientName || 'Anonymous'}</p>
                            )}
                          </div>
                        )}
                        <div className="w-14">
                          <p className="text-xs text-gray-400">Age</p>
                          {editingCase ? (
                            <input
                              type="number"
                              min={1}
                              value={patientForm.age}
                              onChange={(e) => handlePatientFieldChange('age', e.target.value)}
                              className="w-full text-sm px-2 py-1 border border-border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                              disabled={savingCase}
                            />
                          ) : (
                            <p className={`text-sm font-medium truncate ${shownAge != null ? 'text-text-muted' : 'text-gray-400'}`}>
                              {shownAge != null ? `${shownAge}y` : 'Not detected'}
                            </p>
                          )}
                        </div>
                        <div className="w-20">
                          <p className="text-xs text-gray-400">Sex</p>
                          {editingCase ? (
                            <select
                              value={patientForm.sex}
                              onChange={(e) => handlePatientFieldChange('sex', e.target.value)}
                              className="w-full text-sm px-1 py-1 border border-border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                              disabled={savingCase}
                            >
                              <option value="">Select</option>
                              <option value="Male">Male</option>
                              <option value="Female">Female</option>
                              <option value="Other">Other</option>
                            </select>
                          ) : (
                            <p className={`text-sm font-medium truncate ${shownSex ? 'text-text-muted' : 'text-gray-400'}`}>
                              {shownSex || 'Not detected'}
                            </p>
                          )}
                        </div>
                        <div className="w-40">
                          <p className="text-xs text-gray-400">Cancer Type</p>
                          {editingCase ? (
                            <input
                              type="text"
                              value={patientForm.cancerType}
                              onChange={(e) => handlePatientFieldChange('cancerType', e.target.value)}
                              className="w-full text-sm px-2 py-1 border border-border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                              disabled={savingCase}
                            />
                          ) : (
                            <p className="text-sm font-medium truncate text-text-muted" title={shownCancerType}>{shownCancerType}</p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-wrap flex-shrink-0">
                        {showYouBadge && (
                          <span className="px-3 py-1 text-xs font-medium rounded-full bg-blue-50 text-blue-600">
                            You
                          </span>
                        )}
                        {caseData?.summaryStatus === 'verified' && (
                          <span className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-green-50 text-green-700 border border-green-200">
                            <CheckCircle className="w-3.5 h-3.5" />
                            Verified & Shared
                          </span>
                        )}
                        {editingCase ? (
                          <>
                            {isOwner && !isProcessingSummary && (
                              (caseData.summaryRegenerationCount ?? 0) >= 5 ? (
                                <span
                                  className="px-3 py-1.5 text-sm font-medium rounded-lg text-gray-400 bg-bg border border-border cursor-not-allowed"
                                  title="This case has used all 5 available summary regenerations."
                                >
                                  Regeneration limit reached (5/5)
                                </span>
                              ) : (
                                <button
                                  onClick={handleRegenerateSummary}
                                  disabled={regenerating}
                                  className="px-3 py-1.5 text-sm font-medium rounded-lg text-text-muted bg-bg border border-border hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
                                  title="Not happy with this summary? Regenerate it from the same documents."
                                >
                                  {regenerating ? 'Starting…' : `Regenerate Summary (${5 - (caseData.summaryRegenerationCount ?? 0)} left)`}
                                </button>
                              )
                            )}
                            <button
                              onClick={handleSaveCase}
                              disabled={savingCase}
                              className="px-4 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {savingCase ? 'Saving...' : 'Save Changes'}
                            </button>
                            <button
                              onClick={handleSaveAndVerify}
                              disabled={savingCase}
                              data-tour="case-verify"
                              className="flex items-center gap-1.5 px-4 py-1.5 text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed bg-primary"
                              title="Save your changes and verify this case"
                            >
                              <CheckCircle className="w-3.5 h-3.5" />
                              <span>Save &amp; Verify</span>
                            </button>
                            <button
                              onClick={cancelEditingCase}
                              disabled={savingCase}
                              className="px-4 py-1.5 border border-border text-sm text-text rounded-lg hover:bg-bg transition-colors disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            {isOwner && caseData?.summaryStatus === 'unverified' && (
                              <button
                                onClick={handleVerifyClick}
                                data-tour="case-verify"
                                className="px-3 py-1.5 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity bg-primary"
                              >
                                Verify Case
                              </button>
                            )}
                            {!isProcessingSummary && isOwner && caseData?.summaryStatus !== 'verified' && (
                              <button
                                onClick={startEditingCase}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg text-text-muted bg-bg border border-border hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                                <span>Edit</span>
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    {patientDetailsError && (
                      <div className="mb-4 flex items-start justify-between gap-3 px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg" role="alert">
                        <span>{patientDetailsError}</span>
                        <DismissButton onClick={() => setPatientDetailsError(null)} label="Dismiss error" />
                      </div>
                    )}

            {isProcessingSummary ? (
              <div className="space-y-3">
                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <p className="text-sm font-medium text-yellow-800 mb-2">
                    {everVerified ? 'Documents changed. The summary is being regenerated' : '⏳ Summary is being generated'}
                  </p>
                  <p className="text-sm text-yellow-700">
                    {everVerified && isOwner
                      ? "This may take up to 5 minutes, and you'll need to verify the new summary. This page updates automatically when it's ready."
                      : 'This may take up to 5 minutes. This page updates automatically when the summary is ready.'}
                  </p>
                </div>
                <button
                  onClick={handleCheckStatusNow}
                  disabled={checkingStatus}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm disabled:opacity-50"
                >
                  {checkingStatus ? 'Checking…' : 'Check now'}
                </button>
              </div>
            ) : (
              <>
                {/* Toolbar - Only visible when editing */}
                {editingCase && <EditorToolbar onFormat={handleFormat} />}

                {/* Editable Summary */}
                <div
                  ref={editorRef}
                  contentEditable={editingCase}
                  suppressContentEditableWarning
                  onPaste={handlePaste}
                  className={`summary-editor bg-bg p-6 rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[200px] ${
                    editingCase ? 'rounded-t-none' : ''
                  }`}
                  style={{
                    cursor: editingCase ? 'text' : 'default'
                  }}
                  dangerouslySetInnerHTML={{ __html: renderedHTML || '<p class="text-text-muted">No summary yet...</p>' }}
                />

                {/* Verified metadata - Show when verified */}
                {caseData?.summaryStatus === 'verified' && !editingCase && (
                  <div className="mt-5 pt-4 border-t border-border">
                    <p className="text-xs text-gray-400">
                      {/* Only the owner can verify, and no verifier is stored — this
                          used to print the *viewer's* email. */}
                      Verified by <span className="text-text-muted font-medium">{isOwner ? 'you' : 'the case owner'}</span>
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {caseData.createdDate ? new Date(caseData.createdDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

            </>
          )}

          {/* === CASE SETTINGS TAB === */}
          {activeTab === 'settings' && (
            <div data-tour={isOwner ? 'case-settings' : undefined} className="max-w-3xl space-y-6">
              {isOwner ? (
                <>
                  {/* MTB sharing: every MTB the case is in, each removable, plus add to more */}
                  <section className="bg-surface rounded-xl shadow-sm border border-border">
                    <div className="flex items-start justify-between gap-4 p-6 pb-4">
                      <div className="min-w-0">
                        <h3 className="text-base font-semibold text-text-muted">MTB sharing</h3>
                        <p className="text-sm text-text-muted mt-1">
                          {opinionMtbs.length > 0
                            ? `Shared with ${opinionMtbs.length} MTB${opinionMtbs.length === 1 ? '' : 's'}. Members can view and discuss this case.`
                            : 'Not shared with any MTB yet.'}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        <button
                          onClick={() => {
                            setSelectedAddMtbIds([]);
                            setShowAddToMtbModal(true);
                          }}
                          disabled={!canShareToMtbs}
                          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed bg-primary"
                        >
                          <Plus className="w-4 h-4" />
                          <span>Add to MTBs</span>
                        </button>
                        {shareBlockedReason && (
                          <p className="text-xs text-gray-400">{shareBlockedReason}</p>
                        )}
                      </div>
                    </div>

                    {opinionMtbs.length > 0 && (
                      <ul className="border-t border-border divide-y divide-border">
                        {opinionMtbs.map((sharedMtb) => {
                          const contextMtb = mtbs.find(m => m.id === sharedMtb.id);
                          const role = contextMtb ? (contextMtb.ownerId === user?.id ? 'Owner' : 'Member') : null;
                          return (
                            <li key={sharedMtb.id} className="flex items-center justify-between gap-4 px-6 py-3">
                              <div className="flex items-center gap-3 min-w-0">
                                <Users className="w-4 h-4 text-gray-400 flex-shrink-0" />
                                <span className="text-sm font-medium truncate text-text-muted">{sharedMtb.name}</span>
                                {role && (
                                  <span className={`px-2 py-0.5 text-xs font-medium rounded-full flex-shrink-0 ${
                                    role === 'Owner' ? 'bg-green-50 text-green-700' : 'bg-blue-50 text-blue-700'
                                  }`}>
                                    {role}
                                  </span>
                                )}
                              </div>
                              <button
                                onClick={() => setMtbToRemove(sharedMtb)}
                                className="text-sm font-medium text-text-muted hover:text-red-600 transition-colors flex-shrink-0"
                              >
                                Remove
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>

                  {/* Archive / restore */}
                  <section className="bg-surface rounded-xl shadow-sm border border-border p-6 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h3 className="text-base font-semibold text-text-muted">
                        {caseData.archivedAt ? 'Restore case' : 'Archive case'}
                      </h3>
                      <p className="text-sm text-text-muted mt-1">
                        {caseData.archivedAt
                          ? 'Move this case back to My Cases. It stays unshared until you add it to MTBs again.'
                          : 'Hide this case from My Cases and remove it from all MTBs. You can restore it anytime from Archived cases.'}
                      </p>
                    </div>
                    {caseData.archivedAt ? (
                      <button
                        onClick={handleRestoreCase}
                        disabled={restoring}
                        className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium border border-border text-text rounded-lg hover:bg-bg transition-colors disabled:opacity-50 flex-shrink-0"
                      >
                        <ArchiveRestore className="w-4 h-4" />
                        <span>{restoring ? 'Restoring…' : 'Restore'}</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => setShowArchiveConfirm(true)}
                        className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium border border-border text-text rounded-lg hover:bg-bg transition-colors flex-shrink-0"
                      >
                        <Archive className="w-4 h-4" />
                        <span>Archive</span>
                      </button>
                    )}
                  </section>

                  {/* Danger zone */}
                  <section className="bg-surface rounded-xl shadow-sm border border-red-200 p-6 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h3 className="text-base font-semibold text-red-700">Danger zone</h3>
                      <p className="text-sm text-text-muted mt-1">
                        Permanently delete this case and all its documents, opinions and questions. This can't be undone.
                      </p>
                    </div>
                    <button
                      onClick={() => setShowDeleteConfirm(true)}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors flex-shrink-0"
                    >
                      <Trash2 className="w-4 h-4" />
                      <span>Delete case</span>
                    </button>
                  </section>
                </>
              ) : (
                <div className="bg-surface rounded-xl shadow-sm border border-border p-6 text-center">
                  <p className="text-sm text-text-muted">No settings available. Only the case owner can manage case settings.</p>
                </div>
              )}
            </div>
          )}

          {/* === OPINIONS TAB === */}
          {activeTab === 'opinions' && (
            <>
              {!activeOpinionMtbId && (
                <div className="bg-bg border border-border rounded-lg p-3 mb-4">
                  <p className="text-sm text-text-muted">No MTB selected for discussions.</p>
                </div>
              )}

              {/* Switching MTB keeps the current discussions on screen, dimmed,
                  until the new ones arrive. */}
              <div className={`transition-opacity ${opinionsLoading ? 'opacity-50 pointer-events-none' : ''}`} aria-busy={opinionsLoading}>
              {/* Two Column Layout */}
              <div className={`${isMobile ? 'flex flex-col gap-4' : 'grid gap-6'}`} style={!isMobile ? { gridTemplateColumns: '3fr 2fr' } : undefined}>

                {/* ===== LEFT COLUMN — General Opinions ===== */}
                <div className="flex flex-col gap-4">
                  <h3 className="text-base font-semibold text-text-muted">General Opinions</h3>

                  {/* Opinion Input Card */}
                  {canPostOpinions && (
                    <div data-tour="opinion-input">
                      <InlineOpinionInput
                        onSubmit={handleSubmitGeneralOpinion}
                        placeholder="Write your opinion..."
                        variant="card"
                        source="general_opinion"
                      />
                    </div>
                  )}

                  {/* Opinion Feed */}
                  {(() => {
                    const generalOpinions = (caseData.opinions || [])
                      .filter(o => o.questionId === null && o.parentId === null)
                      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

                    return generalOpinions.length > 0 ? (
                      <div className="space-y-3">
                        {generalOpinions.map(opinion => (
                          <OpinionComment
                            key={opinion.id}
                            opinion={opinion}
                            allOpinions={caseData.opinions || []}
                            depth={0}
                            onReply={handleSubmitReply}
                            currentUserId={user?.id}
                            canReply={canPostOpinions}
                            ownerId={caseData.ownerId}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="bg-surface rounded-xl border border-border shadow-sm p-8 text-center">
                        <MessageSquare className="w-8 h-8 text-gray-200 mx-auto mb-3" />
                        <p className="text-sm text-gray-400">No discussions yet in this MTB.</p>
                      </div>
                    );
                  })()}
                </div>

                {/* ===== RIGHT COLUMN — Specific Questions ===== */}
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-semibold text-text-muted">Specific Questions</h3>
                    <div className="flex items-center gap-2">
                      {showCompactMtbFilter && (
                        <div className="relative" ref={mtbFilterMenuRef}>
                          <button
                            type="button"
                            onClick={() => setShowMtbFilterMenu(prev => !prev)}
                            title={activeOpinionMtbName ? `Current MTB: ${activeOpinionMtbName}` : 'Select MTB'}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-border text-text bg-surface hover:bg-bg transition-colors"
                            disabled={opinionsLoading}
                          >
                            <Filter className="w-3.5 h-3.5" />
                            <span>MTB</span>
                            <ChevronDown className="w-3 h-3" />
                          </button>

                          {showMtbFilterMenu && (
                            <div className="absolute right-0 mt-2 w-56 bg-surface border border-border rounded-lg shadow-lg z-20 py-1">
                              {opinionMtbs.map((mtb) => {
                                const isActive = mtb.id === activeOpinionMtbId;
                                return (
                                  <button
                                    key={mtb.id}
                                    type="button"
                                    onClick={() => handleSelectOpinionMtb(mtb.id)}
                                    className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-bg ${isActive ? 'text-blue-700 bg-blue-50' : 'text-text'}`}
                                  >
                                    <span className="truncate pr-2">{mtb.name}</span>
                                    {isActive && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}

                      {isOwner && (
                        <button
                          onClick={() => setShowAddQuestionModal(true)}
                          data-tour="ask-question"
                          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg text-white hover:opacity-90 transition-opacity bg-primary"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>Ask Question</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Questions List */}
                  {caseData.questions && caseData.questions.length > 0 ? (
                    <div className="space-y-4">
                      {caseData.questions.map((question) => {
                        const questionOpinions = (caseData.opinions || [])
                          .filter(o => o.questionId === question.id && o.parentId === null)
                          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

                        return (
                          <div key={question.id} className="bg-surface rounded-xl shadow-sm border border-border">
                            {/* Question Header */}
                            <div className="px-4 py-3 border-b border-border">
                              <p className="text-sm font-semibold text-text leading-snug">{question.text}</p>
                              <div className="flex items-center gap-2 mt-2">
                                <span className="px-2 py-0.5 text-[10px] font-medium rounded-full bg-blue-50 text-blue-600">Clinical</span>
                                <span className="text-xs text-gray-400">Asked by Case Owner</span>
                              </div>
                            </div>

                            {/* Answers */}
                            <div className="px-4 py-3">
                              {questionOpinions.length > 0 ? (
                                <div className="space-y-2">
                                  {questionOpinions.map(opinion => (
                                    <OpinionComment
                                      key={opinion.id}
                                      opinion={opinion}
                                      allOpinions={caseData.opinions || []}
                                      depth={0}
                                      onReply={handleSubmitReply}
                                      currentUserId={user?.id}
                                      canReply={canPostOpinions}
                                      ownerId={caseData.ownerId}
                                      compact
                                    />
                                  ))}
                                </div>
                              ) : (
                                <p className="text-xs text-gray-400 py-2">No answers yet.</p>
                              )}

                              {/* Answer Input */}
                              {canPostOpinions && (
                                <InlineOpinionInput
                                  onSubmit={(content) => handleSubmitQuestionOpinion(question.id, content)}
                                  placeholder="Write your answer..."
                                  variant="inline"
                                  submitLabel="Answer"
                                  source="answer"
                                />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="bg-surface rounded-xl border border-border shadow-sm p-8 text-center">
                      <MessageSquare className="w-8 h-8 text-gray-200 mx-auto mb-3" />
                      <p className="text-sm text-gray-400">
                        {isOwner
                          ? 'No questions yet. Add questions to guide expert discussions.'
                          : 'No questions have been added by the case owner yet.'}
                      </p>
                    </div>
                  )}
                </div>

              </div>
              </div>
            </>
          )}
            </div>
          )}
        </div>
      </div>


      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        title="Delete Case"
      >
        <div className="space-y-4">
          <p className="text-sm text-text">
            This case will be permanently deleted and cannot be recovered. All associated documents, opinions, and questions will also be removed.
          </p>
          <p className="text-sm font-medium text-text">Do you want to continue?</p>
          <div className="flex justify-end space-x-3">
            <button
              onClick={() => setShowDeleteConfirm(false)}
              className="px-4 py-2 border border-border rounded-lg text-text hover:bg-bg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleDeleteCase}
              disabled={deleting}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
            >
              {deleting ? 'Deleting...' : 'Delete Case'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Verify Summary Modal */}
      {verifyModalMode === 'blocked' ? (
        <VerifyModal
          isOpen={showVerifyModal}
          onConfirm={() => {
            setShowVerifyModal(false);
            startEditingCase();
          }}
          onCancel={() => setShowVerifyModal(false)}
          isLoading={false}
          title="Add patient details to verify"
          description="Age and sex couldn't be detected from the uploaded documents, so this case can't be verified yet."
          bullets={[]}
          footerNote="Add them in Edit Patient Info, then verify again."
          confirmLabel="Edit Patient Info"
        />
      ) : (
        <VerifyModal
          isOpen={showVerifyModal}
          onConfirm={handleVerifySummary}
          onCancel={() => setShowVerifyModal(false)}
          isLoading={verifyingProgress}
          description="Please review the patient details and summary below, then confirm to verify this case. Once verified, it will be:"
          reviewContent={
            caseData && (
              <div className="grid grid-cols-2 gap-3 text-sm p-3 bg-bg rounded-lg">
                {showPatientName && (
                  <div>
                    <p className="text-xs text-gray-400">Patient</p>
                    <p className="font-medium text-text-muted">{caseData.patientName || 'Anonymous'}</p>
                  </div>
                )}
                <div>
                  <p className="text-xs text-gray-400">Age / Sex</p>
                  <p className="font-medium text-text-muted">{caseData.age}y, {caseData.sex}</p>
                </div>
                <div className="col-span-2">
                  <p className="text-xs text-gray-400">Cancer Type</p>
                  <p className="font-medium text-text-muted">{caseData.cancerType}</p>
                </div>
              </div>
            )
          }
        />
      )}

      {/* Add Question Modal */}
      <Modal
        isOpen={showAddQuestionModal}
        onClose={() => {
          setShowAddQuestionModal(false);
          setNewQuestionText('');
        }}
        title="Add New Question"
      >
        <div className="space-y-4">
          <div className="relative">
            <textarea
              ref={questionTextareaRef}
              value={newQuestionText}
              onChange={(e) => setNewQuestionText(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 pr-10 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none transition-all duration-150"
              placeholder="Enter your question for the experts..."
              autoFocus
            />
            <div className="absolute right-3 top-2.5">
              <VoiceRecorder
                onTranscriptionComplete={(text) => setNewQuestionText((prev) => (prev ? prev + ' ' + text : text))}
                variant="inline"
                source="question"
              />
            </div>
          </div>

          <div className="flex justify-end space-x-3">
            <button
              onClick={() => {
                setShowAddQuestionModal(false);
                setNewQuestionText('');
              }}
              disabled={addingQuestion}
              className="px-4 py-2 border border-border rounded-lg text-text hover:bg-bg transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleAddQuestion}
              disabled={addingQuestion || !newQuestionText.trim()}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {addingQuestion ? 'Adding...' : 'Add Question'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Remove from MTB Confirmation Modal */}
      <Modal
        isOpen={Boolean(mtbToRemove)}
        onClose={() => !removingFromMTB && setMtbToRemove(null)}
        title="Remove from MTB"
      >
        <div className="space-y-4">
          <p className="text-sm text-text">
            Remove this case from <span className="font-medium">{mtbToRemove?.name}</span>? Its members will no longer see it. Opinions already posted there are kept if you add it back later.
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setMtbToRemove(null)}
              disabled={removingFromMTB}
              className="px-4 py-2 text-sm font-medium border border-border rounded-lg text-text hover:bg-bg transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleRemoveFromMTB}
              disabled={removingFromMTB}
              className="px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
            >
              {removingFromMTB ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Add to MTBs Modal */}
      <Modal
        isOpen={showAddToMtbModal}
        onClose={() => !addingToMtbs && setShowAddToMtbModal(false)}
        title="Add to MTBs"
      >
        {addableMtbs.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-sm font-medium text-text mb-1">
              {mtbs.length === 0 ? "You're not part of any MTB yet" : 'Already shared with all your MTBs'}
            </p>
            <p className="text-sm text-text-muted">
              {mtbs.length === 0 ? 'Create or join an MTB from the MTBs page first.' : 'Every MTB you belong to already has this case.'}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-text-muted">Select the MTBs to share this case with.</p>
              <button
                type="button"
                onClick={() => setSelectedAddMtbIds(
                  selectedAddMtbIds.length === addableMtbs.length ? [] : addableMtbs.map(m => m.id)
                )}
                className="text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                {selectedAddMtbIds.length === addableMtbs.length ? 'Clear all' : 'Select all'}
              </button>
            </div>
            <div className="max-h-80 overflow-y-auto space-y-2 pr-1">
              {addableMtbs.map((mtb) => (
                <label
                  key={mtb.id}
                  className="flex items-center gap-3 p-3 bg-bg rounded-lg border border-border hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selectedAddMtbIds.includes(mtb.id)}
                    onChange={() => setSelectedAddMtbIds(prev => (
                      prev.includes(mtb.id) ? prev.filter(mid => mid !== mtb.id) : [...prev, mtb.id]
                    ))}
                    className="w-4 h-4 rounded border-border"
                    style={{ accentColor: 'var(--color-primary)' }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text truncate">{mtb.name}</p>
                    <p className="text-xs text-text-muted">
                      {mtb.ownerId === user?.id ? 'Owner' : 'Member'} · {mtb.experts} expert{mtb.experts === 1 ? '' : 's'}
                    </p>
                  </div>
                </label>
              ))}
            </div>
            <p className="text-xs text-text-muted">Members of the selected MTBs will be notified.</p>
            <div className="flex items-center justify-end gap-3 pt-3 border-t border-border">
              <div className="flex gap-3">
                <button
                  onClick={() => setShowAddToMtbModal(false)}
                  disabled={addingToMtbs}
                  className="px-4 py-2 text-sm font-medium border border-border rounded-lg text-text hover:bg-bg transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddToMtbs}
                  disabled={addingToMtbs || selectedAddMtbIds.length === 0}
                  className="px-4 py-2 text-sm whitespace-nowrap font-medium text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed bg-primary"
                >
                  {addingToMtbs
                    ? 'Adding…'
                    : selectedAddMtbIds.length > 0
                    ? `Add to ${selectedAddMtbIds.length} MTB${selectedAddMtbIds.length === 1 ? '' : 's'}`
                    : 'Add to MTBs'}
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Archive Confirmation Modal */}
      <Modal
        isOpen={showArchiveConfirm}
        onClose={() => !archiving && setShowArchiveConfirm(false)}
        title="Archive case"
      >
        <div className="space-y-4">
          <p className="text-sm text-text">
            This case will move to Archived cases
            {opinionMtbs.length > 0
              ? ` and be removed from ${opinionMtbs.length} MTB${opinionMtbs.length === 1 ? '' : 's'}.`
              : '.'}
          </p>
          {opinionMtbs.length > 0 && (
            <p className="text-sm text-text-muted">
              Restoring it later won't share it again — you'd add it to MTBs yourself.
            </p>
          )}
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setShowArchiveConfirm(false)}
              disabled={archiving}
              className="px-4 py-2 text-sm font-medium border border-border rounded-lg text-text hover:bg-bg transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleArchiveCase}
              disabled={archiving}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 bg-primary"
            >
              {archiving ? 'Archiving…' : 'Archive case'}
            </button>
          </div>
        </div>
      </Modal>
    </Layout>
  );
}
