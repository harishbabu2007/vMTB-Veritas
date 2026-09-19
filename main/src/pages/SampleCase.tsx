import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Archive, CheckCircle, Edit2, FileText, FlaskConical, Lock, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { Layout } from '../components/Layout';
import { VerifyModal } from '../components/VerifyModal';
import { InlineOpinionInput } from '../components/InlineOpinionInput';
import { EditorToolbar } from '../components/EditorToolbar';
import { SamplePdf } from '../components/onboarding/SamplePdf';
import { useAuth } from '../context/AuthContext';
import { useCaseCreation } from '../context/CaseCreationContext';
import { useOnboarding } from '../context/OnboardingContext';
import { useIsMobile } from '../hooks/useMobile';
import { useTourAction, useTourGroup } from '../hooks/useTourGroup';
import { showToast } from '../utils/toast';
import { getSummaryStatusMeta } from '../utils/summaryStatus';
import {
  SAMPLE_AGE,
  SAMPLE_FILE_NAME,
  SAMPLE_SEED_OPINION,
  SAMPLE_SEX,
  SAMPLE_SUMMARY,
  SAMPLE_TREATMENT_PLAN,
  SampleOpinion,
} from '../onboarding/sampleCase';

// The walkthrough's sample case. Everything here is local to this page:
// nothing is uploaded, saved or shared, and no pipeline runs. It opens "In
// Progress" and the walkthrough marks it ready at once (a real case takes
// 1–2 minutes). Dictation (the mic on the opinion box) is the one real call,
// on purpose, so users hear it work.

type Tab = 'summary' | 'reports' | 'opinions' | 'treatment' | 'settings';

const TABS: { id: Tab; label: string; mobileLabel: string }[] = [
  { id: 'summary', label: 'Case Summary', mobileLabel: 'Summary' },
  { id: 'reports', label: 'Reports', mobileLabel: 'Reports' },
  { id: 'opinions', label: 'Opinions', mobileLabel: 'Opinions' },
  { id: 'treatment', label: 'Treatment Plan & Follow-Up', mobileLabel: 'Treatment' },
  { id: 'settings', label: 'Settings', mobileLabel: 'Settings' },
];

// Without the walkthrough to mark it ready (it was skipped, or its step
// couldn't show), the sample doesn't stay "In Progress" for long.
const READY_FALLBACK_MS = 5000;

const toHtml = (markdown: string) => DOMPurify.sanitize(marked.parse(markdown, { gfm: true, breaks: true }) as string);

export function SampleCase() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { user } = useAuth();
  const { sampleDemo, setSampleDemo, clearAll: clearCaseDraft } = useCaseCreation();
  const { activeGroup, caseSectionRunning, complete } = useOnboarding();

  const [ready, setReady] = useState(false);
  const [verified, setVerified] = useState(false);
  const [showVerify, setShowVerify] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('summary');
  const [opinions, setOpinions] = useState<SampleOpinion[]>([SAMPLE_SEED_OPINION]);
  const [summaryHtml, setSummaryHtml] = useState(() => toHtml(SAMPLE_SUMMARY));
  const [editing, setEditing] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);

  // Held in memory only: a refresh (or arriving here directly) has nothing
  // to show.
  useEffect(() => {
    if (!sampleDemo) navigate('/my-cases', { replace: true });
  }, [sampleDemo, navigate]);

  // The wizard draft that made the sample is done with; leaving the page
  // discards the sample itself.
  useEffect(() => {
    clearCaseDraft();
    return () => setSampleDemo(null);
  }, [clearCaseDraft, setSampleDemo]);

  // The walkthrough's "Show it" button: the case is ready now.
  useTourAction('sample-ready', async () => setReady(true));

  useEffect(() => {
    if (ready || activeGroup === 'sample_status') return;
    const timer = window.setTimeout(() => setReady(true), caseSectionRunning ? READY_FALLBACK_MS : 0);
    return () => window.clearTimeout(timer);
  }, [ready, activeGroup, caseSectionRunning]);

  useTourGroup('sample_status', Boolean(sampleDemo) && !verified && activeTab === 'summary' && !editing);
  useTourGroup('sample_tabs', verified && !showVerify);

  const status = verified ? 'verified' : ready ? 'unverified' : 'processing';
  const statusMeta = getSummaryStatusMeta(status);

  const openTab = (tab: Tab) => {
    if (tab !== 'summary' && !verified) {
      showToast.error('Verify the case first to unlock this tab.');
      return;
    }
    setActiveTab(tab);
  };

  const handleFormat = (command: string, value?: string) => {
    document.execCommand(command, false, value);
    editorRef.current?.focus();
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  };

  const saveEdits = () => {
    if (editorRef.current) setSummaryHtml(DOMPurify.sanitize(editorRef.current.innerHTML));
    setEditing(false);
  };

  // Leaving the sample ends the walkthrough's case section either way.
  const leave = (to: string) => {
    complete(['case_flow', 'case_review']);
    navigate(to);
  };

  const authorName = user?.name?.trim() || 'You';
  const summaryContent = useMemo(() => ({ __html: summaryHtml }), [summaryHtml]);

  if (!sampleDemo) return null;

  return (
    <Layout wide>
      <div className="w-full">
        {/* Same tab bar as a real case: pinned under the top nav, and the
            other tabs locked until the summary is verified. */}
        <div className="case-tabs-sticky border-b border-border mb-4">
          <nav className={`-mb-px flex items-center ${isMobile ? 'overflow-x-auto no-scrollbar gap-1' : 'gap-6'}`}>
            {TABS.map(({ id, label, mobileLabel }) => {
              const locked = id !== 'summary' && !verified;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => openTab(id)}
                  aria-disabled={locked || undefined}
                  title={locked ? 'Verify the case first to unlock this tab' : undefined}
                  data-tour={`tab-${id}`}
                  className={`flex items-center gap-1.5 border-b-2 font-medium transition-colors whitespace-nowrap flex-shrink-0 ${
                    isMobile ? 'py-2.5 px-2 text-xs' : 'py-3 px-0.5 text-sm'
                  } ${
                    locked
                      ? 'border-transparent text-gray-300 dark:text-gray-600 cursor-not-allowed'
                      : activeTab === id
                      ? 'text-blue-600 border-blue-500'
                      : 'border-transparent text-text-muted hover:text-text hover:border-border'
                  }`}
                >
                  {locked && <Lock className="w-3 h-3" />}
                  {isMobile ? mobileLabel : label}
                </button>
              );
            })}
          </nav>
        </div>

        <div className={`mb-4 flex gap-3 px-4 py-3 rounded-lg border border-border bg-status-pending-bg ${isMobile ? 'flex-col' : 'items-center justify-between'}`}>
          <div className="flex items-center gap-2 text-sm text-status-pending-text">
            <FlaskConical className="w-4 h-4 flex-shrink-0" />
            <span>This is a sample case. Nothing here is uploaded or saved.</span>
          </div>
          <div className={`flex gap-2 flex-shrink-0 ${isMobile ? 'flex-col-reverse' : ''}`}>
            <button
              type="button"
              onClick={() => leave('/my-cases')}
              className="px-3 py-1.5 text-sm font-medium rounded-lg border border-border bg-surface text-text hover:bg-bg transition-colors"
            >
              Exit sample
            </button>
            {caseSectionRunning && (
              <button
                type="button"
                onClick={() => leave('/mtbs')}
                data-tour="sample-continue"
                className="px-3 py-1.5 text-sm font-medium rounded-lg text-white bg-primary hover:bg-primary-hover transition-colors"
              >
                Continue to MTBs
              </button>
            )}
          </div>
        </div>

        <div className={isMobile ? 'space-y-4' : 'space-y-6'}>
          {activeTab === 'summary' && (
            <div className="bg-surface rounded-xl shadow-sm border border-border p-6">
              <div className="flex items-start justify-between gap-4 flex-wrap pb-4 mb-4 border-b border-border">
                <div className="flex flex-wrap gap-x-6 gap-y-3">
                  <Field label="Case" value={sampleDemo.caseName} className="w-40" strong />
                  <Field label="Patient" value={sampleDemo.patientName || 'Anonymous'} className="w-32" />
                  <Field label="Age" value={ready ? String(SAMPLE_AGE) : '—'} className="w-14" />
                  <Field label="Sex" value={ready ? SAMPLE_SEX : '—'} className="w-16" />
                  <Field label="Cancer Type" value={sampleDemo.cancerType} className="w-40" />
                </div>
                <div className="flex items-center gap-2 flex-wrap flex-shrink-0">
                  <span
                    key={status}
                    data-tour="case-status"
                    role="status"
                    className={`status-swap flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full ${statusMeta.bg} ${statusMeta.text}`}
                  >
                    {status === 'verified' && <CheckCircle className="w-3.5 h-3.5" />}
                    {statusMeta.label}
                  </span>
                  {ready && !verified && !editing && (
                    <>
                      <button
                        type="button"
                        onClick={() => setShowVerify(true)}
                        data-tour="sample-verify"
                        className="px-3 py-1.5 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity bg-primary"
                      >
                        Verify Case
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(true)}
                        data-tour="case-edit"
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg text-text-muted bg-bg border border-border hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                        <span>Edit</span>
                      </button>
                    </>
                  )}
                  {editing && (
                    <>
                      <button
                        type="button"
                        onClick={saveEdits}
                        className="px-4 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
                      >
                        Save Changes
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          saveEdits();
                          setShowVerify(true);
                        }}
                        className="flex items-center gap-1.5 px-4 py-1.5 text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity bg-primary"
                      >
                        <CheckCircle className="w-3.5 h-3.5" />
                        <span>Save &amp; Verify</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(false)}
                        className="px-4 py-1.5 border border-border text-sm text-text rounded-lg hover:bg-bg transition-colors"
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div data-tour="case-summary">
                {ready ? (
                  <div className="content-reveal">
                    {editing && <EditorToolbar onFormat={handleFormat} />}
                    <div
                      // Remount when editing starts or stops, so React never
                      // fights the browser over the editable content.
                      key={editing ? 'editing' : 'reading'}
                      ref={editorRef}
                      contentEditable={editing}
                      suppressContentEditableWarning
                      onPaste={editing ? handlePaste : undefined}
                      className={`summary-editor bg-bg p-6 rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[200px] ${
                        editing ? 'rounded-t-none cursor-text' : ''
                      }`}
                      dangerouslySetInnerHTML={summaryContent}
                    />
                    {verified && (
                      <p className="mt-5 pt-4 border-t border-border text-xs text-gray-400">
                        Verified by <span className="text-text-muted font-medium">you</span>
                      </p>
                    )}
                  </div>
                ) : (
                  <SummarySkeleton />
                )}
              </div>
            </div>
          )}

          {activeTab === 'reports' && (
            <>
              <div className="bg-surface rounded-xl shadow-sm border border-border p-6">
                <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-text">Documents</h3>
                    <p className="text-xs text-text-muted mt-0.5">The copy the board sees, with patient identifiers masked.</p>
                  </div>
                  <span className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-status-verified-bg text-status-verified-text">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Identifiers masked
                  </span>
                </div>
                <div className="flex items-center gap-3 bg-bg rounded-lg p-3 border border-border mb-4">
                  <FileText className="w-5 h-5 text-text-muted flex-shrink-0" />
                  <p className="text-sm font-medium text-text truncate">{SAMPLE_FILE_NAME}</p>
                </div>
                <SamplePdf />
              </div>

              <div className="bg-surface rounded-xl shadow-sm border border-border p-6">
                <h3 className="text-lg font-semibold text-text mb-3">Case Explanation</h3>
                <div className="bg-bg rounded-lg p-4 border border-border">
                  {sampleDemo.explanation.trim() ? (
                    <p className="text-sm text-text whitespace-pre-wrap">{sampleDemo.explanation}</p>
                  ) : (
                    <p className="text-sm text-text-muted italic">
                      No notes added. In step 2 of a new case you can type them or dictate them.
                    </p>
                  )}
                </div>
              </div>
            </>
          )}

          {activeTab === 'opinions' && (
            <div className={isMobile ? 'flex flex-col gap-4' : 'grid gap-6'} style={!isMobile ? { gridTemplateColumns: '3fr 2fr' } : undefined}>
              <div className="flex flex-col gap-4">
                <h3 className="text-base font-semibold text-text-muted">General Opinions</h3>
                <InlineOpinionInput
                  onSubmit={async (content) => {
                    setOpinions(prev => [
                      ...prev,
                      { id: `local-${Date.now()}`, author: authorName, role: 'You', content, createdAt: new Date().toISOString() },
                    ]);
                  }}
                  placeholder="Write your opinion..."
                  variant="card"
                  source="general_opinion"
                />
                <div className="space-y-3">
                  {opinions.map(op => (
                    <div key={op.id} className="bg-surface rounded-xl border border-border p-4">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-sm font-semibold text-text">{op.author}</span>
                        <span className="text-xs text-text-muted">{op.role}</span>
                      </div>
                      <p className="text-sm text-text whitespace-pre-wrap">{op.content}</p>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-4">
                <h3 className="text-base font-semibold text-text-muted">Specific Questions</h3>
                {sampleDemo.questions.length > 0 ? (
                  <div className="space-y-3">
                    {sampleDemo.questions.map((q, i) => (
                      <div key={i} className="bg-surface rounded-xl border border-border p-4">
                        <p className="text-sm font-medium text-text">{q}</p>
                        <p className="text-xs text-text-muted mt-1">No answers yet</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="bg-surface rounded-xl border border-border p-4">
                    <p className="text-sm text-text-muted">
                      Questions you add when creating a case appear here for the board to answer.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'treatment' && (
            <div className="bg-surface rounded-xl shadow-sm border border-border p-6 space-y-5">
              <div>
                <h3 className="text-lg font-semibold text-text">Treatment Plan</h3>
                <p className="text-xs text-text-muted mt-0.5">
                  In a real case, you record the board’s plan and follow-ups here.
                </p>
              </div>
              <div className={`grid gap-4 ${isMobile ? 'grid-cols-1' : 'grid-cols-2'}`}>
                <Detail label="Discussion" value={SAMPLE_TREATMENT_PLAN.discussionDate} />
                <Detail label="Predominant pathway" value={SAMPLE_TREATMENT_PLAN.pathway} />
                <Detail label="Therapy recommendation" value={SAMPLE_TREATMENT_PLAN.recommendation} wide={!isMobile} />
                <Detail label="AMP level of evidence" value={SAMPLE_TREATMENT_PLAN.ampLevel} />
                <Detail label="ESCAT level" value={SAMPLE_TREATMENT_PLAN.escatLevel} />
                <Detail label="Overall evidence strength" value={SAMPLE_TREATMENT_PLAN.evidence} />
              </div>
              <div className="pt-5 border-t border-border">
                <h4 className="text-sm font-semibold text-text mb-3">Follow-Up</h4>
                <div className="bg-bg rounded-lg border border-border p-4 space-y-1">
                  <p className="text-sm font-medium text-text">{SAMPLE_TREATMENT_PLAN.followUp.label}</p>
                  <p className="text-sm text-text-muted">{SAMPLE_TREATMENT_PLAN.followUp.status}</p>
                  <p className="text-sm text-text-muted">{SAMPLE_TREATMENT_PLAN.followUp.notes}</p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="max-w-3xl space-y-6">
              <p className="text-sm text-text-muted">A sample can’t be shared, archived or deleted. On a real case these work as described.</p>
              <SettingRow
                title="MTB sharing"
                body="Choose which MTBs can view and discuss the case."
                action={<><Plus className="w-4 h-4" /><span>Add to MTBs</span></>}
                primary
              />
              <SettingRow
                title="Archive case"
                body="Hide the case from My Cases and remove it from all MTBs. You can restore it anytime."
                action={<><Archive className="w-4 h-4" /><span>Archive</span></>}
              />
              <SettingRow
                title="Danger zone"
                body="Permanently delete the case and all its documents, opinions and questions."
                action={<><Trash2 className="w-4 h-4" /><span>Delete case</span></>}
                danger
              />
            </div>
          )}
        </div>
      </div>

      <VerifyModal
        isOpen={showVerify}
        onCancel={() => setShowVerify(false)}
        onConfirm={() => {
          setVerified(true);
          setShowVerify(false);
          showToast.success('Sample case verified');
        }}
        isLoading={false}
        description="Once you verify this summary, the case:"
        bullets={[
          'Unlocks Reports, Opinions and Treatment plan',
          'Is shared with the MTBs you chose (in a real case)',
        ]}
        footerNote="This is a sample, so nothing is saved."
        confirmLabel="Verify"
      />
    </Layout>
  );
}

function Field({ label, value, className = '', strong = false }: { label: string; value: string; className?: string; strong?: boolean }) {
  return (
    <div className={className}>
      <p className="text-xs text-gray-400">{label}</p>
      <p className={`text-sm truncate text-text-muted ${strong ? 'font-semibold' : 'font-medium'}`} title={value}>{value}</p>
    </div>
  );
}

function Detail({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`bg-bg rounded-lg p-3 border border-border ${wide ? 'col-span-2' : ''}`}>
      <p className="text-xs text-text-muted mb-1">{label}</p>
      <p className="text-sm font-medium text-text">{value}</p>
    </div>
  );
}

// A disabled copy of one of the real Settings rows.
function SettingRow({ title, body, action, primary = false, danger = false }: {
  title: string;
  body: string;
  action: React.ReactNode;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <section className={`bg-surface rounded-xl shadow-sm border p-6 flex items-start justify-between gap-4 ${danger ? 'border-red-200 dark:border-red-900' : 'border-border'}`}>
      <div className="min-w-0">
        <h3 className={`text-base font-semibold ${danger ? 'text-red-700 dark:text-red-400' : 'text-text-muted'}`}>{title}</h3>
        <p className="text-sm text-text-muted mt-1">{body}</p>
      </div>
      <button
        type="button"
        disabled
        title="Not available on the sample"
        className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg flex-shrink-0 opacity-50 cursor-not-allowed ${
          danger ? 'bg-red-600 text-white' : primary ? 'bg-primary text-white' : 'border border-border text-text'
        }`}
      >
        {action}
      </button>
    </section>
  );
}

// Where the summary will appear, while the case is "In Progress".
function SummarySkeleton() {
  return (
    <div className="bg-bg rounded-lg border border-border p-6 min-h-[200px]" aria-hidden="true">
      <div className="space-y-3 animate-pulse motion-reduce:animate-none">
        <div className="h-4 w-40 rounded bg-border" />
        <div className="h-3 w-full rounded bg-border" />
        <div className="h-3 w-11/12 rounded bg-border" />
        <div className="h-4 w-32 rounded bg-border mt-6" />
        <div className="h-3 w-full rounded bg-border" />
        <div className="h-3 w-4/5 rounded bg-border" />
      </div>
    </div>
  );
}
