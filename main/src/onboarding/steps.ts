// The first-time walkthrough.
//
// Guided part: a welcome on My Cases, then a hands-on case section (the
// wizard with the sample report, then the sample case) and an MTB section
// (the MTBs page, then a sample board). Each screen offers its group; the
// user clicks the real Continue/Create buttons to move on ("act" steps), and
// the tour itself only drops in the sample report and marks the sample case
// ready ("run" steps). Guided groups are remembered for the session only;
// finishing a section saves its milestone, so an interrupted section restarts
// from its start.
//
// Tips: short groups shown the first time the user opens something on a
// real case or board, saved as soon as they're finished or closed.
//
// Targets are `data-tour` attributes on the real controls.

export type TourGroupId =
  // Guided
  | 'welcome'
  | 'case_resume'
  | 'step1'
  | 'step2'
  | 'review'
  | 'sample_status'
  | 'sample_tabs'
  | 'mtb_intro'
  | 'mtbs'
  | 'sample_board'
  // Tips
  | 'case_status'
  | 'case_review'
  | 'reports'
  | 'document_viewer'
  | 'redact'
  | 'opinions'
  | 'treatment'
  | 'case_settings'
  | 'mtb_board';

// Keys saved in profiles.onboarding_seen: the welcome, the two section
// milestones, and the tips.
export type OnboardingKey = TourGroupId | 'case_flow' | 'mtb_flow';

// Things a "run" step's primary button does. Page actions are registered by
// the screen that owns the state (useTourAction); navigation ones by the
// overlay.
export type TourActionName =
  | 'sample-drop'
  | 'sample-ready'
  | 'go-mtbs'
  | 'go-sample-board'
  | 'go-new-case';

// The only controls an "act" step lets the user click through the tour. None
// of them has a side effect outside the browser: they navigate, or open the
// sample case's local Verify dialog. Never add a control that starts a
// meeting, creates or joins a board, or creates a real case.
export const ACT_TARGETS: ReadonlySet<string> = new Set([
  'add-case',
  'step1-continue',
  'step2-continue',
  'review-create-sample',
  'sample-verify',
]);

// The case section's guided groups, cleared together when it restarts.
export const CASE_SECTION_GROUPS: TourGroupId[] = ['case_resume', 'step1', 'step2', 'review', 'sample_status', 'sample_tabs'];

// Once every one of these is saved, the walkthrough is over for the user.
export const ALL_SAVED_KEYS: OnboardingKey[] = [
  'welcome',
  'case_flow',
  'mtb_flow',
  'case_status',
  'case_review',
  'reports',
  'document_viewer',
  'redact',
  'opinions',
  'treatment',
  'case_settings',
  'mtb_board',
];

// When several groups could start at once, the earlier one wins.
export const TOUR_GROUP_ORDER: TourGroupId[] = [
  'welcome',
  'case_resume',
  'step1',
  'step2',
  'review',
  'sample_status',
  'sample_tabs',
  'mtb_intro',
  'mtbs',
  'sample_board',
  'case_status',
  'case_review',
  'reports',
  'document_viewer',
  'redact',
  'opinions',
  'treatment',
  'case_settings',
  'mtb_board',
];

export interface TourContext {
  firstName: string | null;
  isMobile: boolean;
  target: HTMLElement | null;
}

type Text = string | ((ctx: TourContext) => string);

export interface TourStep {
  // `null` is a centred card. An object picks a different target at phone
  // width, where the desktop control is hidden (e.g. in the drawer).
  target: string | { desktop: string; mobile: string } | null;
  title: Text;
  body?: Text;
  // The user clicks the highlighted control to go on (see ACT_TARGETS).
  act?: boolean;
  // The primary button runs this, then moves on.
  run?: TourActionName;
  primaryLabel?: string;
  // A second button on the last step: finishes, then runs `secondaryRun`.
  secondaryLabel?: string;
  secondaryRun?: TourActionName;
}

export interface TourGroup {
  kind: 'guided' | 'tip';
  steps: TourStep[];
  // Keys that must all be saved before the group can show.
  requires?: OnboardingKey[];
  // Keys that stop the group once any is saved.
  blockedBy?: OnboardingKey[];
  // Keys saved when the group finishes.
  completes?: OnboardingKey[];
  // Guided groups that finishing this one makes unnecessary this session.
  alsoFinishes?: TourGroupId[];
  // Coming back to this screen after finishing its group (browser Back
  // mid-section) shows only this step: the one that moves on.
  resumeStep?: number;
}

const CASE_SECTION = { requires: ['welcome'] as OnboardingKey[], blockedBy: ['case_flow'] as OnboardingKey[] };
const MTB_SECTION = { requires: ['case_flow'] as OnboardingKey[], blockedBy: ['mtb_flow'] as OnboardingKey[] };

export const TOUR_GROUPS: Record<TourGroupId, TourGroup> = {
  // ─── Guided: welcome ──────────────────────────────────────────────────
  welcome: {
    kind: 'guided',
    completes: ['welcome'],
    // The user is on their way into the case section; don't point them there
    // again on the way out of My Cases.
    alsoFinishes: ['case_resume'],
    steps: [
      {
        target: null,
        title: ({ firstName }) => (firstName ? `Welcome to vMTB, ${firstName}` : 'Welcome to vMTB'),
        body: 'Here’s a quick look around. Then we’ll build a sample case together.',
        primaryLabel: 'Show me around',
      },
      {
        target: { desktop: 'nav-my-cases', mobile: 'my-cases-heading' },
        title: 'Your cases',
        body: 'Every case you create is listed here with its summary status.',
      },
      {
        target: { desktop: 'nav-mtbs', mobile: 'mobile-menu' },
        title: 'Tumor boards',
        body: ({ target }) =>
          target?.dataset.tour === 'mobile-menu'
            ? 'Create a board or join one with an invite code to discuss cases with other experts. They’re in this menu.'
            : 'Create a board or join one with an invite code to discuss cases with other experts.',
      },
      {
        target: 'add-case',
        act: true,
        title: 'Add a case',
        body: 'Click Add New Case. We’ll build a sample case together.',
      },
    ],
  },
  case_resume: {
    kind: 'guided',
    ...CASE_SECTION,
    steps: [
      {
        target: 'add-case',
        act: true,
        title: 'Continue the tour',
        body: 'Click Add New Case to pick up where you left off.',
      },
    ],
  },

  // ─── Guided: case section ─────────────────────────────────────────────
  step1: {
    kind: 'guided',
    ...CASE_SECTION,
    resumeStep: 5,
    steps: [
      {
        target: 'patient-name',
        title: 'Patient name (optional)',
        body: 'Leave it blank to keep the case anonymous.',
      },
      {
        target: 'cancer-type',
        title: 'Cancer type',
        body: 'Required. Search by name or abbreviation; it names the case.',
      },
      {
        target: 'upload-documents',
        title: 'Upload documents',
        body: 'Click here or drag files in: PDFs, images, Word, PowerPoint or text.',
      },
      {
        target: 'sample-drop',
        run: 'sample-drop',
        primaryLabel: 'Drop it in',
        title: 'Try it with a sample',
        body: 'We’ll drop in a fictional patient’s report for this demo.',
      },
      {
        target: 'sample-preview',
        title: 'The sample report',
        body: 'A fictional patient’s pathology, genomics and CT report. This is what the AI reads.',
      },
      {
        target: 'step1-continue',
        act: true,
        title: 'Continue',
        body: 'Click Continue to add your notes.',
      },
    ],
  },
  step2: {
    kind: 'guided',
    ...CASE_SECTION,
    resumeStep: 2,
    steps: [
      {
        target: 'explanation',
        title: 'Explain the case',
        body: 'History, findings and your questions, as you’d present them to a board. Optional.',
      },
      {
        target: 'dictate',
        title: 'Or dictate it',
        body: 'Click Dictate and speak; your words are typed in. Try it on a real case.',
      },
      {
        target: 'step2-continue',
        act: true,
        title: 'Continue',
        body: 'Click Continue to Review.',
      },
    ],
  },
  review: {
    kind: 'guided',
    ...CASE_SECTION,
    resumeStep: 4,
    steps: [
      {
        target: 'review-details',
        title: 'Check the details',
        body: 'Case name, patient and cancer type. Use Edit to change anything.',
      },
      {
        target: 'review-documents',
        title: 'Documents and notes',
        body: 'Everything the AI will read to write the summary.',
      },
      {
        target: 'review-questions',
        title: 'Questions for the board',
        body: 'Add questions for the experts. Optional.',
      },
      {
        // Real case only: the sample isn't shared.
        target: 'review-share',
        title: 'Share with MTBs',
        body: 'Pick boards to share with. They see it once you verify.',
      },
      {
        // Exactly one of these two targets exists: the sample's Create Case
        // can be clicked through the tour, a real one is only pointed at.
        target: 'review-create-sample',
        act: true,
        title: 'Create the case',
        body: 'Click Create Case.',
      },
      {
        target: 'review-create',
        title: 'Create the case',
        body: 'Click Create Case when you’re ready. The summary takes 1–2 minutes.',
      },
    ],
  },
  sample_status: {
    kind: 'guided',
    ...CASE_SECTION,
    steps: [
      {
        target: 'case-status',
        run: 'sample-ready',
        primaryLabel: 'Show it',
        title: 'Creating your case',
        body: 'A real case takes 1–2 minutes to anonymize and summarize. For the demo, it’s ready now.',
      },
      {
        target: 'case-status',
        title: 'Ready to verify',
        body: 'Pending means the AI summary is ready for you to check.',
      },
      {
        target: 'case-summary',
        title: 'Check the summary',
        body: 'Compare diagnosis, stage and biomarkers with the report.',
      },
      {
        target: 'case-edit',
        title: 'Fix anything wrong',
        body: 'Click Edit to correct the text, then verify.',
      },
      {
        target: 'sample-verify',
        act: true,
        title: 'Verify the case',
        body: 'Click Verify Case. Verifying unlocks the other tabs.',
      },
    ],
  },
  sample_tabs: {
    kind: 'guided',
    ...CASE_SECTION,
    steps: [
      { target: 'tab-reports', title: 'Reports', body: 'The uploaded documents, anonymized.' },
      { target: 'tab-opinions', title: 'Opinions', body: 'The board’s opinions and answers to your questions.' },
      { target: 'tab-treatment', title: 'Treatment plan', body: 'The agreed plan and the patient’s follow-ups.' },
      { target: 'tab-settings', title: 'Settings', body: 'Sharing with MTBs, archiving and deleting.' },
      {
        target: 'sample-continue',
        title: 'Look around, then continue',
        body: 'Open any tab. Click Continue to MTBs when you’re ready.',
      },
    ],
  },

  // ─── Guided: MTB section ──────────────────────────────────────────────
  mtb_intro: {
    kind: 'guided',
    ...MTB_SECTION,
    steps: [
      {
        target: { desktop: 'nav-mtbs', mobile: 'mobile-menu' },
        run: 'go-mtbs',
        primaryLabel: 'Go to MTBs',
        title: 'Next: tumor boards',
        body: 'Boards are where you discuss cases with other experts.',
      },
    ],
  },
  mtbs: {
    kind: 'guided',
    ...MTB_SECTION,
    steps: [
      {
        target: 'create-mtb',
        title: 'Create a board',
        body: 'Start a board for your team. You’ll get an invite code to share.',
      },
      {
        target: 'join-mtb',
        title: 'Or join one',
        body: 'Got an invite code from a colleague? Enter it here.',
      },
      {
        target: null,
        run: 'go-sample-board',
        primaryLabel: 'Show sample board',
        title: 'See inside a board',
        body: 'Here’s a sample board, so you know where things are.',
      },
    ],
  },
  sample_board: {
    kind: 'guided',
    ...MTB_SECTION,
    completes: ['mtb_flow', 'mtb_board'],
    steps: [
      { target: 'mtb-add-case', title: 'Add a case', body: 'Share a verified case so members can review it.' },
      { target: 'mtb-invite', title: 'Invite colleagues', body: 'Share this code so others can join the board.' },
      {
        target: 'mtb-meeting',
        title: 'Meetings',
        body: 'Start or join the board’s video meeting, and notify members.',
      },
      {
        target: null,
        run: 'go-new-case',
        primaryLabel: 'Create a case',
        secondaryLabel: 'Done',
        secondaryRun: 'go-mtbs',
        title: 'You’re all set',
        body: 'Create your first case with your own reports whenever you’re ready.',
      },
    ],
  },

  // ─── Tips ─────────────────────────────────────────────────────────────
  case_status: {
    kind: 'tip',
    steps: [
      {
        target: 'case-pending',
        title: 'Summary ready',
        body: 'Pending means the AI summary is done. Open the case to check and verify it.',
      },
    ],
  },
  case_review: {
    kind: 'tip',
    steps: [
      {
        target: 'tab-summary',
        title: 'Case summary',
        body: 'Written by AI from your reports. Read it closely and edit anything that’s wrong.',
      },
      {
        target: 'case-verify',
        title: 'Verify when it’s right',
        body: 'Verifying unlocks the other tabs and lets you share the case with an MTB.',
      },
      {
        target: 'tab-reports',
        title: 'Reports',
        body: ({ target }) =>
          target?.getAttribute('aria-disabled') === 'true'
            ? 'Anonymized copies of the documents you uploaded. Opens once you verify.'
            : 'Anonymized copies of the documents you uploaded.',
      },
    ],
  },
  reports: {
    kind: 'tip',
    steps: [
      {
        target: 'report-card',
        title: 'Open a report',
        body: 'Click a report to view it full-screen and check what’s masked.',
      },
      {
        target: 'reports-add',
        title: 'Add documents',
        body: 'New files are anonymized like the rest.',
      },
    ],
  },
  document_viewer: {
    kind: 'tip',
    steps: [
      {
        target: 'viewer-mode',
        title: 'View or redact',
        body: 'Switch to Redact to hide anything the automatic masking missed.',
      },
    ],
  },
  redact: {
    kind: 'tip',
    steps: [
      {
        target: 'redact-tools',
        title: 'Hide what’s left',
        body: ({ isMobile }) => (isMobile ? 'Drag a box or draw over it. Undo is at the end.' : 'Drag a box or draw over it. Ctrl+Z undoes.'),
      },
      {
        target: 'redact-panel',
        title: 'Everything masked',
        body: 'The automatic masks and yours. Nothing changes until you save.',
      },
    ],
  },
  opinions: {
    kind: 'tip',
    steps: [
      {
        target: 'opinion-input',
        title: 'Add your opinion',
        body: 'Type, or use the mic to dictate. Everyone on this board can read and reply.',
      },
      {
        target: 'ask-question',
        title: 'Ask the board',
      },
    ],
  },
  treatment: {
    kind: 'tip',
    steps: [
      {
        target: 'treatment-plan',
        title: 'Record the board’s plan',
        body: 'Therapy, pathway and evidence levels once the board agrees.',
      },
      {
        target: 'add-follow-up',
        title: 'Track the patient',
        body: 'Add a follow-up after each visit.',
      },
    ],
  },
  case_settings: {
    kind: 'tip',
    steps: [
      {
        target: 'case-settings',
        title: 'Case settings',
        body: 'Choose which MTBs see this case, or archive or delete it.',
      },
    ],
  },
  mtb_board: {
    kind: 'tip',
    steps: [
      {
        target: 'mtb-add-case',
        title: 'Add a case',
        body: 'Share one of your verified cases so board members can review it.',
      },
      {
        target: 'mtb-meeting',
        title: 'Meetings',
        body: 'Start or join this board’s video meeting, and notify members when it starts.',
      },
    ],
  },
};

export const resolveText = (text: Text | undefined, ctx: TourContext): string | undefined =>
  typeof text === 'function' ? text(ctx) : text;

// Target names to try, preferred first. The other variant is the fallback:
// phone landscape counts as mobile for layout but still shows the desktop nav.
export const targetNames = (step: TourStep, isMobile: boolean): string[] => {
  if (step.target === null) return [];
  if (typeof step.target === 'string') return [step.target];
  return isMobile ? [step.target.mobile, step.target.desktop] : [step.target.desktop, step.target.mobile];
};
