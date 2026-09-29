import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, ReactNode } from 'react';
import { supabase } from '../Supabase/client';
import { useAuth } from './AuthContext';
import { useRealtimeResync } from '../hooks/useRealtimeResync';
import { useRealtimeAuthToken } from '../hooks/useRealtimeAuth';
import {
  PipelineError,
  SummaryEdit,
  newRequestId,
  saveCaseSummaryEdit,
  startRegeneration,
  startRun,
  verifyCaseSummary,
} from '../services/pipelineService';

export type SummaryStatus = 'processing' | 'unverified' | 'verified' | 'failed';
export type ReportStatus = 'not_ready' | 'unverified' | 'verified';

export interface Question {
  id: string;
  text: string;
}

export interface Case {
  id: string;
  caseName: string;
  patientName?: string;
  age: number | null;
  sex: string | null;
  cancerType: string;
  createdDate: string;
  createdAt?: string;
  summary?: string | null;
  summaryStatus?: SummaryStatus;
  reportStatus?: ReportStatus;
  firstVerifiedAt?: string | null;
  summaryRegenerationCount?: number;
  archivedAt?: string | null;
  /** Bumped on every saved change to the case's documents (see case_pipeline_runs). */
  contentGeneration?: number;
  /** The contentGeneration the current summary was produced from. */
  summaryGeneration?: number;
  verifiedGeneration?: number | null;
  /** What the owner last verified; MTB members see this while a newer version is unverified. */
  verifiedSnapshot?: VerifiedSnapshot | null;
  requestId?: string | null;
  questions?: Question[];
  opinions?: Opinion[];
  documents?: Document[];
  treatmentPlan?: any;
  followUps?: FollowUp[];
  ownerId?: string;
}

export interface VerifiedSnapshot {
  summary: string | null;
  patient_age: number | null;
  patient_sex: string | null;
  cancer_type: string | null;
  verified_at: string;
}

export interface Opinion {
  id: string;
  caseId: string;
  questionId: string | null; // NULL = general opinion, UUID = tied to question
  parentId: string | null; // NULL = top-level, UUID = reply to another opinion
  mtbId: string | null;
  authorUserId: string;
  content: string;
  createdAt: string;
}

interface GetCaseByIdOptions {
  mtbId?: string | null;
  includeLegacyWhenNoMtbSpecific?: boolean;
}

export interface Document {
  id: string;
  name: string;
  size: string;
  type: 'NGS' | 'Clinical' | 'Text';
  storagePath?: string;
  mimeType?: string;
}

export interface FollowUp {
  id: string;
  caseId: string;
  followUp: string;
  createdAt: string;
  createdBy: string;
}

export interface MTB {
  id: string;
  name: string;
  experts: number;
  cases: string[];
  ownerId?: string;
  joinCode?: string;
  notificationEnabled?: boolean;
}

interface CasesContextType {
  cases: Case[];
  mtbs: MTB[];
  // True only while the first load for the signed-in user is in flight. Later
  // refetches happen in the background so lists never blank out.
  casesLoading: boolean;
  mtbsLoading: boolean;
  refetchCases: () => Promise<void>;
  refetchMTBs: () => Promise<void>;
  refreshProcessingCases: () => Promise<void>;
  createCase: (
    caseData: Omit<Case, 'id' | 'createdDate' | 'ownerId'> & { requestId?: string },
    documents: Document[],
    questions: string[],
    shareWithMtbIds?: string[],
  ) => Promise<{ caseId: string; createdAt: string }>;
  updateCase: (id: string, updates: Partial<Case>) => Promise<Case | null>;
  deleteCase: (id: string) => Promise<void>;
  /** generation: the contentGeneration of the version the user reviewed. */
  verifySummary: (caseId: string, generation: number) => Promise<Case | null>;
  /** The owner's manual edit of summary/patient details; refused while a new summary is being generated. */
  saveSummaryEdit: (caseId: string, generation: number, edit: SummaryEdit) => Promise<Case | null>;
  regenerateSummary: (caseId: string) => Promise<Case | null>;
  refreshCase: (caseId: string) => Promise<Case | null>;
  archiveCase: (caseId: string) => Promise<Case>;
  unarchiveCase: (caseId: string) => Promise<Case | null>;
  createMTB: (name: string) => Promise<void>;
  joinMTB: (joinCode: string) => Promise<void>;
  leaveMTB: (mtbId: string) => Promise<void>;
  addCaseToMTB: (mtbId: string, caseId: string) => Promise<void>;
  addCaseToMTBs: (caseId: string, mtbIds: string[]) => Promise<void>;
  removeCaseFromMTB: (mtbId: string, caseId: string) => Promise<void>;
  updateMTBName: (mtbId: string, newName: string) => Promise<void>;
  updateMTBNotification: (mtbId: string, enabled: boolean) => Promise<void>;
  addOpinion: (caseId: string, content: string, questionId?: string | null, parentId?: string | null, mtbId?: string | null) => Promise<Opinion>;
  updateOpinion: (opinionId: string, content: string) => Promise<void>;
  addFollowUp: (caseId: string, followUp: string) => Promise<void>;
  getCaseById: (id: string, options?: GetCaseByIdOptions) => Promise<Case | null>;
  getCaseOpinions: (caseId: string, mtbId: string) => Promise<Opinion[]>;
  /** Push a board's authoritative case-id list back into context after a refetch. */
  syncMtbCaseIds: (mtbId: string, caseIds: string[]) => void;
}

const CasesContext = createContext<CasesContextType | undefined>(undefined);

interface CaseRow {
  id: string;
  case_name: string;
  patient_name?: string;
  patient_age: number | null;
  patient_sex: string | null;
  cancer_type: string;
  created_at: string;
  summary?: string | null;
  summary_status?: SummaryStatus | null;
  report_status?: ReportStatus | null;
  first_verified_at?: string | null;
  summary_regeneration_count?: number | null;
  archived_at?: string | null;
  content_generation?: number | null;
  summary_generation?: number | null;
  verified_generation?: number | null;
  verified_snapshot?: VerifiedSnapshot | null;
  request_id?: string | null;
  treatment_plan?: unknown;
  owner_id?: string;
}

export interface OpinionRow {
  id: string;
  case_id: string;
  question_id: string | null;
  parent_id: string | null;
  mtb_id: string | null;
  user_id: string;
  opinion_text: string;
  created_at: string;
}

// Maps only the `cases` row's own columns. Relation fields (questions,
// opinions, documents, followUps) are deliberately absent -- not undefined --
// so `{ ...existingCase, ...mapCaseRow(row) }` refreshes the row without
// wiping relations that were loaded separately.
const mapCaseRow = (row: CaseRow): Case => ({
  id: row.id,
  caseName: row.case_name,
  patientName: row.patient_name,
  age: row.patient_age,
  sex: row.patient_sex,
  cancerType: row.cancer_type,
  createdDate: row.created_at.split('T')[0],
  createdAt: row.created_at,
  summary: row.summary,
  summaryStatus: row.summary_status || 'processing',
  reportStatus: row.report_status || 'not_ready',
  firstVerifiedAt: row.first_verified_at,
  summaryRegenerationCount: row.summary_regeneration_count ?? 0,
  archivedAt: row.archived_at ?? null,
  contentGeneration: row.content_generation ?? 0,
  summaryGeneration: row.summary_generation ?? 0,
  verifiedGeneration: row.verified_generation ?? null,
  verifiedSnapshot: row.verified_snapshot ?? null,
  requestId: row.request_id || null,
  treatmentPlan: row.treatment_plan,
  ownerId: row.owner_id,
});

export const mapOpinionRow = (o: OpinionRow): Opinion => ({
  id: o.id,
  caseId: o.case_id,
  questionId: o.question_id || null,
  parentId: o.parent_id || null,
  mtbId: o.mtb_id || null,
  authorUserId: o.user_id,
  content: o.opinion_text,
  createdAt: o.created_at,
});

export function CasesProvider({ children }: { children: ReactNode }) {
  const { user, role, effectiveOwnerId } = useAuth();
  // For a clinician/mtb_expert this is just their own id; for a
  // site_data_coordinator it's the linked clinician's id, so every
  // case/MTB read+write below lands on and reads as the clinician's own
  // data. MTB *membership* (joinMTB/leaveMTB) is a personal relationship,
  // not a clinician-delegated one, so those two call sites deliberately
  // use `ownUserId` instead -- see the comments at each site.
  const userId = effectiveOwnerId;
  const ownUserId = user?.id ?? null;
  const [cases, setCases] = useState<Case[]>([]);
  const [mtbs, setMTBs] = useState<MTB[]>([]);
  const [casesLoading, setCasesLoading] = useState(false);
  const [mtbsLoading, setMtbsLoading] = useState(false);
  const casesLoadedFor = useRef<string | null>(null);
  const mtbsLoadedFor = useRef<string | null>(null);
  const casesRef = useRef<Case[]>([]);
  casesRef.current = cases;
  const mtbsRef = useRef<MTB[]>([]);
  mtbsRef.current = mtbs;

  // Replace one case in the owner's list with a freshly read row, keeping any
  // fields the row doesn't carry.
  const mergeCaseIntoList = useCallback((updated: Case) => {
    setCases(prev => prev.map(c => (c.id === updated.id ? { ...c, ...updated } : c)));
  }, []);

  const fetchCaseRow = useCallback(async (id: string): Promise<Case | null> => {
    // cases_viewer_safe (not the raw table): the caller here isn't
    // necessarily the case's owner (this backs ViewCase's poll-refresh for
    // any viewer, owner or MTB member), and patient_name must never reach a
    // non-owner's browser -- see 20260922_cases_patient_name_read_guard.sql.
    const { data, error } = await supabase.from('cases_viewer_safe').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? mapCaseRow(data) : null;
  }, []);

  const refetchCases = useCallback(async () => {
    if (!userId) { setCases([]); return; }
    const isFirstLoad = casesLoadedFor.current !== userId;
    if (isFirstLoad) setCasesLoading(true);
    try {
      const { data, error } = await supabase
        .from('cases')
        .select('*')
        .eq('owner_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      setCases((data || []).map(mapCaseRow));
      casesLoadedFor.current = userId;
    } catch (err) {
      console.error('Failed to fetch cases:', err);
    } finally {
      if (isFirstLoad) setCasesLoading(false);
    }
  }, [userId]);

  // Lightweight refresh: only fetch cases that are processing in local state
  const refreshProcessingCases = useCallback(async () => {
    if (!userId) return;
    const processingCaseIds = casesRef.current
      .filter(c => c.summaryStatus === 'processing')
      .map(c => c.id);

    if (processingCaseIds.length === 0) return;

    // Fetch current status of these cases (regardless of their DB status)
    const { data, error } = await supabase
      .from('cases')
      .select('*')
      .eq('owner_id', userId)
      .in('id', processingCaseIds);

    if (error) {
      console.error('Failed to refresh processing cases:', error);
      return;
    }

    if (!data || data.length === 0) return;

    // Update local state with new data (status may have changed to unverified/verified/failed)
    setCases(prev => prev.map(c => {
      const updated = data.find(row => row.id === c.id);
      return updated ? { ...c, ...mapCaseRow(updated) } : c;
    }));
  }, [userId]);

  const refetchMTBs = useCallback(async () => {
    if (!userId) { setMTBs([]); return; }
    const isFirstLoad = mtbsLoadedFor.current !== userId;
    if (isFirstLoad) setMtbsLoading(true);
    try {
      // Fetch MTBs where user is owner
      const { data: ownedMTBs, error: ownedError } = await supabase
        .from('mtbs')
        .select('*')
        .eq('owner_id', userId);
      if (ownedError) throw ownedError;

      // Fetch MTBs where the signed-in user personally is a member -- a
      // membership row is a personal relationship (see joinMTB/leaveMTB),
      // not something an SDC's linked clinician acquires by proxy, so this
      // reads ownUserId, not the effective-owner userId above. An SDC's MTB
      // list is therefore the union of "MTBs the linked clinician owns"
      // (the query above) and "MTBs the SDC personally joined" (below).
      const { data: memberMTBs, error: memberError } = await supabase
        .from('mtb_members')
        .select('mtb_id')
        .eq('user_id', ownUserId);
      if (memberError) throw memberError;

      const memberMtbIds = (memberMTBs || []).map(m => m.mtb_id);
      let joinedMTBs: any[] = [];
      if (memberMtbIds.length > 0) {
        const { data, error } = await supabase.from('mtbs').select('*').in('id', memberMtbIds);
        if (error) throw error;
        joinedMTBs = data || [];
      }

      // Merge and deduplicate
      const allMTBs = [...(ownedMTBs || []), ...joinedMTBs];
      const uniqueMTBs = Array.from(new Map(allMTBs.map(m => [m.id, m])).values());

      // For each MTB, count members and cases
      const mtbsWithCounts = await Promise.all(uniqueMTBs.map(async (mtb) => {
        const { count: memberCount } = await supabase.from('mtb_members').select('*', { count: 'exact', head: true }).eq('mtb_id', mtb.id);
        // Every case already shared into this MTB counts, regardless of
        // current summary_status — a case doesn't stop being a member of
        // the MTB just because an edit put its summary back into
        // 'processing'/'unverified'. Verified-only enforcement still
        // applies separately to which cases are eligible to be ADDED in
        // the first place (see MTBDetail.tsx's availableCases filter).
        const { data: mtbCases } = await supabase
          .from('mtb_cases')
          .select('case_id')
          .eq('mtb_id', mtb.id);
        return {
          id: mtb.id,
          name: mtb.name,
          experts: (memberCount || 0) + 1,
          cases: (mtbCases || []).map(c => c.case_id),
          ownerId: mtb.owner_id,
          joinCode: mtb.join_code,
          notificationEnabled: mtb.notification_enabled ?? true,
        };
      }));

      setMTBs(mtbsWithCounts);
      mtbsLoadedFor.current = userId;
    } catch (err) {
      console.error('Failed to fetch MTBs:', err);
    } finally {
      if (isFirstLoad) setMtbsLoading(false);
    }
  }, [userId, ownUserId]);

  // Keyed on the user id, not the user object: auth events that re-deliver
  // the same user must not refetch everything.
  useEffect(() => {
    if (userId) {
      refetchCases();
      refetchMTBs();
    } else {
      setCases([]);
      setMTBs([]);
      casesLoadedFor.current = null;
      mtbsLoadedFor.current = null;
    }
  }, [userId, refetchCases, refetchMTBs]);

  // Realtime delivers nothing for the window a socket was down and never
  // backfills it, so each subscription below resyncs through the same fetch
  // that loaded it in the first place -- on reconnect, and when the tab
  // becomes visible again. Three separate hooks rather than one shared
  // callback so a reconnect on the boards feed doesn't also refetch cases.
  const onCasesResync = useRealtimeResync(refetchCases);
  const onMtbsResync = useRealtimeResync(refetchMTBs);
  const onMtbDetailsResync = useRealtimeResync(refetchMTBs);
  // Every subscription below waits for this. A channel that joins before the
  // socket has the user's JWT is stuck with anon claims for good, which for
  // the RLS-enabled tables (mtb_cases, mtbs) means it silently receives
  // nothing -- see useRealtimeAuth.
  const realtimeToken = useRealtimeAuthToken();

  // Upsert one row into the list: the same shape for an INSERT and an UPDATE,
  // and id-keyed so a user's own optimistic write echoing back doesn't
  // duplicate it.
  const applyCaseRow = useCallback((row: CaseRow) => {
    const updated = mapCaseRow(row);
    setCases(prev => (
      prev.some(c => c.id === updated.id)
        ? prev.map(c => (c.id === updated.id ? { ...c, ...updated } : c))
        : [updated, ...prev]
    ));
  }, []);

  // The authoritative case-id list for one board, pushed back from whoever
  // just re-read it. Removals can't be derived from a Realtime DELETE (see
  // the mtb_cases subscription below), so the component that refetched the
  // board is the only place that knows the truth -- without this, a removed
  // case would keep counting towards the board's total on the MTBs list and
  // stay excluded from "add case" until the next full refetch.
  const syncMtbCaseIds = useCallback((mtbId: string, caseIds: string[]) => {
    setMTBs(prev => prev.map(m => {
      if (m.id !== mtbId) return m;
      const same = m.cases.length === caseIds.length && m.cases.every(id => caseIds.includes(id));
      return same ? m : { ...m, cases: caseIds };
    }));
  }, []);

  // Live cases: a linked coordinator adding/archiving a case, or their
  // clinician doing the same, shows up for the other side without a reload.
  // One filter value (owner_id = effectiveOwnerId) already covers both
  // directions, since a clinician and their coordinator resolve to the same
  // userId here -- see the comment on `userId` above.
  //
  // Security note: `cases` has RLS off (docs/DATABASE_SCHEMA.md), so this
  // filter is a delivery convenience, not an access boundary -- but the
  // table is already fully readable via a direct REST call today regardless
  // (same doc), so this subscription adds no exposure beyond that standing,
  // separately-tracked gap. It also can't route through `cases_viewer_safe`
  // (Realtime only fires off base-table writes, not views), so the payload
  // carries raw `patient_name` -- fine here because every subscriber under
  // this exact filter (the owner, or their linked coordinator) already has
  // full access to their own patient_name through every other read path.
  // Do not reuse this filter shape for an MTB-member subscription without
  // adding the same masking the view provides.
  useEffect(() => {
    if (!userId || !realtimeToken) return;
    const channel = supabase
      .channel(`cases-${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'cases', filter: `owner_id=eq.${userId}` },
        (payload) => applyCaseRow(payload.new as CaseRow)
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'cases', filter: `owner_id=eq.${userId}` },
        (payload) => applyCaseRow(payload.new as CaseRow)
      )
      // DELETE is a separate, deliberately unfiltered subscription. A delete's
      // old row carries only the replica identity, which for `cases` is the
      // default (primary key) -- so `owner_id` isn't in it, the
      // `owner_id=eq.` filter above can't match, and a filtered DELETE is
      // never delivered at all. Unfiltered it arrives, and it is safe to take
      // unfiltered precisely because it is PK-only: the payload is one uuid,
      // no case data of any kind. An id for a case we don't hold just filters
      // nothing out.
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'cases' },
        (payload) => {
          const oldId = (payload.old as { id?: string })?.id;
          if (oldId) setCases(prev => prev.filter(c => c.id !== oldId));
        }
      )
      .subscribe(onCasesResync);
    return () => { supabase.removeChannel(channel); };
  }, [userId, realtimeToken, onCasesResync, applyCaseRow]);

  // Live board membership: a case shared into (or removed from) any board
  // this user can see. Patching `mtbs[].cases` is all this needs to do --
  // MTBDetail's own fetch is keyed on that list (its `mtbCaseKey`), so the
  // board's case table re-reads itself, and it re-reads through
  // `cases_viewer_safe`. That's why this is the safe shape where a `cases`
  // subscription wouldn't be: the payload here is two foreign keys and no
  // patient data, and the masked view stays on the path that renders.
  //
  // Deliberately unfiltered: mtb_cases has RLS enabled (verified live
  // 2026-09-29) with owner- and member-scoped SELECT policies, so Realtime
  // evaluates them per subscriber and the server decides what this client
  // may see. A client-side mtb_id filter would have to be rebuilt every time
  // the user's board list changed, and would add nothing to that.
  //
  // INSERT only, and that is a hard limit rather than a choice. For an
  // RLS-enabled table, realtime.apply_rls() strips a DELETE's old_record down
  // to primary-key columns ("if RLS enabled, we can't secure deletes so filter
  // to pkey") no matter what the replica identity is. mtb_cases's primary key
  // is a surrogate `id`, so a removal arrives as one opaque uuid naming
  // neither the board nor the case -- there is nothing this handler could do
  // with it. Removals are handled where the board id is already known, by the
  // mtb_id-filtered subscription in MTBDetail, which calls syncMtbCaseIds to
  // push the authoritative list back here.
  useEffect(() => {
    if (!userId || !realtimeToken) return;
    const channel = supabase
      .channel(`mtb-cases-${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'mtb_cases' },
        (payload) => {
          const row = payload.new as { mtb_id?: string; case_id?: string };
          if (!row?.mtb_id || !row?.case_id) return;
          const { mtb_id: mtbId, case_id: caseId } = row;
          setMTBs(prev => prev.map(m => (
            m.id === mtbId && !m.cases.includes(caseId) ? { ...m, cases: [...m.cases, caseId] } : m
          )));
        }
      )
      .subscribe(onMtbsResync);
    return () => { supabase.removeChannel(channel); };
  }, [userId, realtimeToken, onMtbsResync]);

  // Live board details: a rename or a notification toggle made in another
  // session. Unfiltered for the same reason as mtb_cases above -- mtbs has
  // RLS enabled, so the server scopes delivery to boards this user owns or
  // belongs to.
  //
  // An INSERT is a board this user owns, created in another session or tab
  // (anyone else's is hidden by RLS until they join, and joining refetches).
  // It refetches rather than patching, because a board's `experts`/`cases`
  // counts are computed by refetchMTBs, not carried on the row -- and a new
  // board is rare enough that precision isn't worth the extra bookkeeping.
  // There is no delete-a-board path in the app at all (no deleteMTB anywhere
  // in src/), so there is no DELETE to handle.
  useEffect(() => {
    if (!userId || !realtimeToken) return;
    const channel = supabase
      .channel(`mtbs-${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'mtbs' },
        (payload) => {
          const row = payload.new as { id?: string };
          if (!row?.id || mtbsRef.current.some(m => m.id === row.id)) return;
          void refetchMTBs();
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'mtbs' },
        (payload) => {
          const row = payload.new as { id?: string; name?: string; notification_enabled?: boolean | null };
          if (!row?.id) return;
          setMTBs(prev => prev.map(m => (
            m.id === row.id
              ? { ...m, name: row.name ?? m.name, notificationEnabled: row.notification_enabled ?? true }
              : m
          )));
        }
      )
      .subscribe(onMtbDetailsResync);
    return () => { supabase.removeChannel(channel); };
  }, [userId, realtimeToken, onMtbDetailsResync, refetchMTBs]);

  const createCase = useCallback(async (
    caseData: Omit<Case, 'id' | 'createdDate' | 'ownerId'> & { requestId?: string },
    documents: Document[],
    questions: string[],
    shareWithMtbIds: string[] = [],
  ): Promise<{ caseId: string; createdAt: string }> => {
    if (!userId) throw new Error('User not authenticated');
    const { data, error } = await supabase
      .from('cases')
      .insert({
        owner_id: userId,
        case_name: caseData.caseName,
        patient_name: caseData.patientName,
        patient_age: caseData.age,
        patient_sex: caseData.sex,
        cancer_type: caseData.cancerType,
        summary: caseData.summary ?? null,
        summary_status: 'processing',
        request_id: caseData.requestId ?? null,
      })
      .select()
      .single();
    if (error) throw error;

    const caseId = data.id;

    // Insert documents
    if (documents.length > 0) {
      const docsToInsert = documents.map(doc => ({
        case_id: caseId,
        type: doc.type,
        file_name: doc.name,
        size: doc.size,
        storage_path: doc.storagePath || '',
      }));
      const { error: docsError } = await supabase.from('case_documents').insert(docsToInsert);
      if (docsError) throw docsError;
    }

    // Insert questions
    if (questions.length > 0) {
      const questionsToInsert = questions.map(q => ({ case_id: caseId, question_text: q }));
      const { error: qError } = await supabase.from('case_questions').insert(questionsToInsert);
      if (qError) throw qError;
    }

    // Share with selected MTBs in one batch
    if (shareWithMtbIds.length > 0) {
      const shareRows = shareWithMtbIds.map(mtbId => ({ case_id: caseId, mtb_id: mtbId }));
      const { error: shareError } = await supabase.from('mtb_cases').insert(shareRows);
      if (shareError) throw shareError;
    }

    setCases(prev => [mapCaseRow(data), ...prev.filter(c => c.id !== caseId)]);
    if (shareWithMtbIds.length > 0) {
      setMTBs(prev => prev.map(m => (
        shareWithMtbIds.includes(m.id) && !m.cases.includes(caseId) ? { ...m, cases: [...m.cases, caseId] } : m
      )));
    }

    return { caseId, createdAt: data.created_at };
  }, [userId]);

  const updateCase = useCallback(async (id: string, updates: Partial<Case>): Promise<Case | null> => {
    if (!userId) throw new Error('User not authenticated');
    const dbUpdates: any = {};
    if (updates.caseName !== undefined) dbUpdates.case_name = updates.caseName;
    if (updates.patientName !== undefined) dbUpdates.patient_name = updates.patientName;
    if (updates.age !== undefined) dbUpdates.patient_age = updates.age;
    if (updates.sex !== undefined) dbUpdates.patient_sex = updates.sex;
    if (updates.cancerType !== undefined) dbUpdates.cancer_type = updates.cancerType;
    if (updates.summary !== undefined) dbUpdates.summary = updates.summary;
    if (updates.treatmentPlan !== undefined) dbUpdates.treatment_plan = updates.treatmentPlan;

    // Returning the written row (post any DB defaults/triggers) lets callers
    // update just this case instead of refetching everything.
    const { data, error } = await supabase
      .from('cases')
      .update(dbUpdates)
      .eq('id', id)
      .eq('owner_id', userId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const updated = mapCaseRow(data);
    mergeCaseIntoList(updated);
    return updated;
  }, [userId, mergeCaseIntoList]);

  const deleteCase = useCallback(async (id: string) => {
    if (!userId) throw new Error('User not authenticated');
    // A coordinator passes the owner check below (they act as the owner), so
    // this is the only thing separating "can archive" from "can delete" on
    // the client. Enforced server-side too, by trg_cases_delete_role.
    if (role === 'site_data_coordinator') throw new Error('Site Data Coordinators cannot delete a case');

    // Verify ownership
    const { data: caseData, error: fetchError } = await supabase
      .from('cases')
      .select('owner_id')
      .eq('id', id)
      .single();

    if (fetchError || !caseData) throw new Error('Case not found');
    if (caseData.owner_id !== userId) throw new Error('Only the owner can delete this case');

    // Delete related data in correct order (respecting foreign keys)
    // 1. Delete opinions
    await supabase.from('case_opinions').delete().eq('case_id', id);
    // 2. Delete questions
    await supabase.from('case_questions').delete().eq('case_id', id);
    // 3. Delete documents metadata
    await supabase.from('case_documents').delete().eq('case_id', id);
    // 4. Remove from all MTBs
    await supabase.from('mtb_cases').delete().eq('case_id', id);
    // 5. Delete the case itself
    const { error } = await supabase.from('cases').delete().eq('id', id).eq('owner_id', userId);
    if (error) throw error;

    setCases(prev => prev.filter(c => c.id !== id));
    setMTBs(prev => prev.map(m => (m.cases.includes(id) ? { ...m, cases: m.cases.filter(cid => cid !== id) } : m)));
  }, [userId, role]);

  // Verification goes through verify_case_summary(): it refuses while a new
  // summary is being generated, and refuses if the case changed after the
  // version the user reviewed (another tab, or an edit still processing).
  const verifySummary = useCallback(async (caseId: string, generation: number): Promise<Case | null> => {
    if (!userId) throw new Error('User not authenticated');
    const row = await verifyCaseSummary(caseId, generation);
    if (!row) return null;
    const updated = mapCaseRow(row as unknown as CaseRow);
    mergeCaseIntoList(updated);
    return updated;
  }, [userId, mergeCaseIntoList]);

  const saveSummaryEdit = useCallback(async (caseId: string, generation: number, edit: SummaryEdit): Promise<Case | null> => {
    if (!userId) throw new Error('User not authenticated');
    const row = await saveCaseSummaryEdit(caseId, generation, edit);
    if (!row) return null;
    const updated = mapCaseRow(row as unknown as CaseRow);
    mergeCaseIntoList(updated);
    return updated;
  }, [userId, mergeCaseIntoList]);

  // start_regeneration() enforces the 5-per-case cap and refuses while an
  // update is in progress (that update produces a new summary anyway). It
  // only re-summarizes: the documents don't need re-anonymizing.
  const regenerateSummary = useCallback(async (caseId: string): Promise<Case | null> => {
    if (!userId) throw new Error('User not authenticated');
    const run = await startRegeneration(caseId, newRequestId());
    try {
      await startRun(run.id);
    } catch (err) {
      // Saved but not started: the case's status strip offers "Start processing".
      if (!(err instanceof PipelineError)) throw err;
    }
    const updated = await fetchCaseRow(caseId);
    if (updated) mergeCaseIntoList(updated);
    return updated;
  }, [userId, fetchCaseRow, mergeCaseIntoList]);

  const refreshCase = useCallback(async (caseId: string): Promise<Case | null> => {
    const updated = await fetchCaseRow(caseId);
    if (updated) mergeCaseIntoList(updated);
    return updated;
  }, [fetchCaseRow, mergeCaseIntoList]);

  // Archiving also removes the case from every MTB (server-side, atomically --
  // see archive_case() in 20260916_case_archive_and_feedback_voice.sql).
  const archiveCase = useCallback(async (caseId: string): Promise<Case> => {
    if (!userId) throw new Error('User not authenticated');
    const { data, error } = await supabase.rpc('archive_case', { p_case_id: caseId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('Only the owner can archive this case');
    const updated = mapCaseRow(row);
    mergeCaseIntoList(updated);
    setMTBs(prev => prev.map(m => (m.cases.includes(caseId) ? { ...m, cases: m.cases.filter(cid => cid !== caseId) } : m)));
    return updated;
  }, [userId, mergeCaseIntoList]);

  const unarchiveCase = useCallback(async (caseId: string): Promise<Case | null> => {
    if (!userId) throw new Error('User not authenticated');
    const { data, error } = await supabase
      .from('cases')
      .update({ archived_at: null })
      .eq('id', caseId)
      .eq('owner_id', userId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const updated = mapCaseRow(data);
    mergeCaseIntoList(updated);
    return updated;
  }, [userId, mergeCaseIntoList]);

  const createMTB = useCallback(async (name: string) => {
    if (!userId) throw new Error('User not authenticated');
    // Defense-in-depth alongside the RESTRICTIVE RLS policy on mtbs -- an
    // MTB Expert has no case-creation/board-ownership role in this product.
    if (role === 'mtb_expert') throw new Error('MTB Experts cannot create MTBs');
    const joinCode = Math.random().toString(36).substring(2, 10).toUpperCase();
    const { data, error } = await supabase
      .from('mtbs')
      .insert({
        owner_id: userId,
        name,
        join_code: joinCode,
      })
      .select()
      .single();
    if (error) {
      // Check if it's a unique constraint violation for the name
      if (error.code === '23505' && error.message.includes('name')) {
        throw new Error('This MTB name is already taken. Please choose a different name.');
      }
      throw error;
    }
    setMTBs(prev => [...prev, {
      id: data.id,
      name: data.name,
      experts: 1,
      cases: [],
      ownerId: data.owner_id,
      joinCode: data.join_code,
      notificationEnabled: data.notification_enabled ?? true,
    }]);
  }, [userId, role]);

  const joinMTB = useCallback(async (joinCode: string) => {
    if (!userId) throw new Error('User not authenticated');
    const { data: mtb, error: mtbError } = await supabase
      .from('mtbs')
      .select('id, owner_id')
      .eq('join_code', joinCode)
      .maybeSingle();
    if (mtbError) throw mtbError;
    if (!mtb) throw new Error('Invalid join code');

    // Prevent owner from joining their own MTB (userId here is the
    // effective owner, so this correctly also blocks an SDC from "joining"
    // an MTB their own linked clinician owns).
    if (mtb.owner_id === userId) {
      throw new Error('You cannot join your own MTB');
    }

    // Membership is a personal relationship, not clinician-delegated (see
    // the ownUserId comment above CasesProvider) -- an SDC joining an MTB
    // by typing in a join code shouldn't silently enroll the clinician,
    // who may not know about it. Use ownUserId, not the effective userId.
    const { error } = await supabase.from('mtb_members').insert({ mtb_id: mtb.id, user_id: ownUserId });
    if (error) throw error;
    // Member and case counts for the joined board aren't known locally.
    await refetchMTBs();
  }, [userId, ownUserId, refetchMTBs]);

  const leaveMTB = useCallback(async (mtbId: string) => {
    if (!ownUserId) throw new Error('User not authenticated');

    // Remove user from mtb_members -- ownUserId to match the personal-
    // membership insert in joinMTB above.
    const { error } = await supabase
      .from('mtb_members')
      .delete()
      .eq('mtb_id', mtbId)
      .eq('user_id', ownUserId);

    if (error) throw error;
    setMTBs(prev => prev.filter(m => m.id !== mtbId));
  }, [ownUserId]);

  const addCaseToMTB = useCallback(async (mtbId: string, caseId: string) => {
    // Defense-in-depth alongside the RESTRICTIVE RLS policy on mtb_cases.
    if (role === 'mtb_expert') throw new Error('MTB Experts cannot add cases to an MTB');
    const { error } = await supabase.from('mtb_cases').insert({ mtb_id: mtbId, case_id: caseId });
    if (error) throw error;
    setMTBs(prev => prev.map(m => (
      m.id === mtbId && !m.cases.includes(caseId) ? { ...m, cases: [...m.cases, caseId] } : m
    )));
  }, [role]);

  // One batch insert; the mtb_cases insert trigger notifies each MTB's members.
  const addCaseToMTBs = useCallback(async (caseId: string, mtbIds: string[]) => {
    if (mtbIds.length === 0) return;
    if (role === 'mtb_expert') throw new Error('MTB Experts cannot add cases to an MTB');
    const { error } = await supabase
      .from('mtb_cases')
      .insert(mtbIds.map(mtbId => ({ mtb_id: mtbId, case_id: caseId })));
    if (error) throw error;
    setMTBs(prev => prev.map(m => (
      mtbIds.includes(m.id) && !m.cases.includes(caseId) ? { ...m, cases: [...m.cases, caseId] } : m
    )));
  }, [role]);

  const removeCaseFromMTB = useCallback(async (mtbId: string, caseId: string) => {
    const { error } = await supabase
      .from('mtb_cases')
      .delete()
      .eq('mtb_id', mtbId)
      .eq('case_id', caseId);
    if (error) throw error;
    setMTBs(prev => prev.map(m => (m.id === mtbId ? { ...m, cases: m.cases.filter(cid => cid !== caseId) } : m)));
  }, []);

  const updateMTBName = useCallback(async (mtbId: string, newName: string) => {
    if (!userId) throw new Error('User not authenticated');
    const { error } = await supabase
      .from('mtbs')
      .update({ name: newName })
      .eq('id', mtbId)
      .eq('owner_id', userId);
    if (error) throw error;
    setMTBs(prev => prev.map(m => (m.id === mtbId ? { ...m, name: newName } : m)));
  }, [userId]);

  const updateMTBNotification = useCallback(async (mtbId: string, enabled: boolean) => {
    if (!userId) throw new Error('User not authenticated');
    const { error } = await supabase
      .from('mtbs')
      .update({ notification_enabled: enabled })
      .eq('id', mtbId);
    if (error) throw error;
    // Update local state immediately for responsive UI
    setMTBs(prev => prev.map(m =>
      m.id === mtbId ? { ...m, notificationEnabled: enabled } : m
    ));
  }, [userId]);

  const addOpinion = useCallback(async (
    caseId: string,
    content: string,
    questionId: string | null = null,
    parentId: string | null = null,
    mtbId: string | null = null
  ): Promise<Opinion> => {
    if (!userId) throw new Error('User not authenticated');
    // Defense-in-depth alongside the RESTRICTIVE RLS policy on
    // case_opinions -- a Site Data Coordinator never posts opinions.
    if (role === 'site_data_coordinator') throw new Error('Site Data Coordinators cannot post opinions');

    let opinionMtbId = mtbId ?? null;
    if (parentId) {
      const { data: parentOpinion, error: parentError } = await supabase
        .from('case_opinions')
        .select('mtb_id')
        .eq('id', parentId)
        .eq('case_id', caseId)
        .maybeSingle();

      if (parentError) throw parentError;
      if (!parentOpinion) throw new Error('Parent opinion not found');
      if (!parentOpinion.mtb_id) {
        throw new Error('Replies to legacy opinions without MTB context are not allowed');
      }
      opinionMtbId = parentOpinion.mtb_id;
    }

    if (!opinionMtbId) {
      throw new Error('MTB context is required to post opinions');
    }

    const { data, error } = await supabase
      .from('case_opinions')
      .insert({
        case_id: caseId,
        user_id: userId,
        opinion_text: content,
        question_id: questionId,
        parent_id: parentId,
        mtb_id: opinionMtbId,
      })
      .select()
      .single();
    if (error) throw error;
    return mapOpinionRow(data);
  }, [userId, role]);

  const updateOpinion = useCallback(async (opinionId: string, content: string) => {
    const { error } = await supabase
      .from('case_opinions')
      .update({ opinion_text: content })
      .eq('id', opinionId);
    if (error) throw error;
  }, []);

  const addFollowUp = useCallback(async (caseId: string, followUp: string) => {
    if (!userId) throw new Error('User not authenticated');
    const { error } = await supabase.from('case_follow_ups').insert({
      case_id: caseId,
      follow_up: followUp,
      created_by: userId,
    });
    if (error) throw error;
  }, [userId]);

  const getCaseOpinions = useCallback(async (caseId: string, mtbId: string): Promise<Opinion[]> => {
    const { data, error } = await supabase
      .from('case_opinions')
      .select('*')
      .eq('case_id', caseId)
      .eq('mtb_id', mtbId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data || []).map(mapOpinionRow);
  }, []);

  const getCaseById = useCallback(async (id: string, options: GetCaseByIdOptions = {}): Promise<Case | null> => {
    const fetchOpinions = async (): Promise<OpinionRow[]> => {
      if (options.mtbId) {
        const { data: mtbOpinions } = await supabase
          .from('case_opinions')
          .select('*')
          .eq('case_id', id)
          .eq('mtb_id', options.mtbId)
          .order('created_at', { ascending: true });

        if ((mtbOpinions || []).length === 0 && options.includeLegacyWhenNoMtbSpecific) {
          const { data: legacyOpinions } = await supabase
            .from('case_opinions')
            .select('*')
            .eq('case_id', id)
            .is('mtb_id', null)
            .order('created_at', { ascending: true });
          return legacyOpinions || [];
        }
        return mtbOpinions || [];
      }
      const { data: allOpinions } = await supabase
        .from('case_opinions')
        .select('*')
        .eq('case_id', id)
        .order('created_at', { ascending: true });
      return allOpinions || [];
    };

    // Independent reads -- run them together rather than one after another.
    // cases_viewer_safe, not the raw table: this is the read path for every
    // case detail view, including a non-owner viewing via an MTB -- see
    // 20260922_cases_patient_name_read_guard.sql.
    const [caseResult, docsResult, questionsResult, opinions, followUpsResult] = await Promise.all([
      supabase.from('cases_viewer_safe').select('*').eq('id', id).maybeSingle(),
      supabase.from('case_documents').select('*').eq('case_id', id),
      supabase.from('case_questions').select('*').eq('case_id', id),
      fetchOpinions(),
      supabase.from('case_follow_ups').select('*').eq('case_id', id).order('created_at', { ascending: false }),
    ]);
    const caseRow = caseResult.data;
    if (caseResult.error || !caseRow) return null;

    return {
      ...mapCaseRow(caseRow),
      documents: (docsResult.data || []).map(d => ({
        id: d.id,
        name: d.file_name,
        size: d.size,
        type: d.type,
        storagePath: d.storage_path,
        mimeType: d.mime_type,
      })),
      questions: (questionsResult.data || []).map(q => ({
        id: q.id,
        text: q.question_text,
      })),
      opinions: opinions.map(mapOpinionRow),
      followUps: (followUpsResult.data || []).map(f => ({
        id: f.id,
        caseId: f.case_id,
        followUp: f.follow_up,
        createdAt: f.created_at,
        createdBy: f.created_by,
      })),
    };
  }, []);

  const value = useMemo<CasesContextType>(() => ({
    cases,
    mtbs,
    casesLoading,
    mtbsLoading,
    refetchCases,
    refetchMTBs,
    createCase,
    updateCase,
    deleteCase,
    verifySummary,
    saveSummaryEdit,
    regenerateSummary,
    refreshCase,
    archiveCase,
    unarchiveCase,
    createMTB,
    joinMTB,
    leaveMTB,
    addCaseToMTB,
    addCaseToMTBs,
    removeCaseFromMTB,
    updateMTBName,
    updateMTBNotification,
    addOpinion,
    updateOpinion,
    addFollowUp,
    getCaseById,
    getCaseOpinions,
    refreshProcessingCases,
    syncMtbCaseIds,
  }), [
    cases, mtbs, casesLoading, mtbsLoading, refetchCases, refetchMTBs, createCase, updateCase,
    deleteCase, verifySummary, saveSummaryEdit, regenerateSummary, refreshCase, archiveCase, unarchiveCase, createMTB, joinMTB, leaveMTB,
    addCaseToMTB, addCaseToMTBs, removeCaseFromMTB, updateMTBName, updateMTBNotification, addOpinion,
    updateOpinion, addFollowUp, getCaseById, getCaseOpinions, refreshProcessingCases, syncMtbCaseIds,
  ]);

  return (
    <CasesContext.Provider value={value}>
      {children}
    </CasesContext.Provider>
  );
}

export function useCases() {
  const context = useContext(CasesContext);
  if (context === undefined) {
    throw new Error('useCases must be used within a CasesProvider');
  }
  return context;
}
