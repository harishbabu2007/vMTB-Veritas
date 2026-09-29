import type { UserRole } from '../context/AuthContext';

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
  'case-create-sample',
  'sample-verify',
]);

// The case section's guided groups, cleared together when it restarts.
export const CASE_SECTION_GROUPS: TourGroupId[] = ['case_resume', 'step1', 'step2', 'sample_status', 'sample_tabs'];

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
  // Roles that see this step. Undefined = every role. For a step whose
  // target only exists for some roles, the missing-target skip in
  // TourOverlay already handles it -- this is for a step (like a `run`
  // step with no target) that would otherwise show and act regardless.
  allowedRoles?: UserRole[];
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
  // Roles this group applies to at all. Undefined = every role. A role
  // excluded here never requests/starts the group, and (see
  // isKeySatisfied below) any other group that `requires` a key this one
  // `completes` treats that key as vacuously satisfied for this role.
  allowedRoles?: UserRole[];
}

// MTB Expert never owns a case (no My Cases/case-creation route at all,
// App.tsx) -- every group gated on owning or creating one excludes it.
const CASE_CAPABLE_ROLES: UserRole[] = ['clinician', 'site_data_coordinator'];
const CASE_SECTION = {
  requires: ['welcome'] as OnboardingKey[],
  blockedBy: ['case_flow'] as OnboardingKey[],
  allowedRoles: CASE_CAPABLE_ROLES,
};
const MTB_SECTION = { requires: ['case_flow'] as OnboardingKey[], blockedBy: ['mtb_flow'] as OnboardingKey[] };

export const TOUR_GROUPS: Record<TourGroupId, TourGroup> = {
  // ─── Guided: welcome ──────────────────────────────────────────────────
  welcome: {
    kind: 'guided',
    completes: ['welcome'],
    // The user is on their way into the case section; don't point them there
    // again on the way out of My Cases.
    alsoFinishes: ['case_resume'],
    allowedRoles: CASE_CAPABLE_ROLES,
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
        body: 'Only you can ever see this — not MTB members, not anyone you share the case with. Leave it blank if you don’t need it at all.',
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
        // Exactly one of these two targets exists: the sample's Create Case
        // can be clicked through the tour, a real one is only pointed at.
        target: 'case-create-sample',
        act: true,
        title: 'Create the case',
        body: 'Click Create Case.',
      },
      {
        target: 'case-create',
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
    // Only ever requested from My Cases (MyCases.tsx), which MTB Expert has
    // no route to at all -- explicit here anyway so isKeySatisfied's
    // "inapplicable, therefore vacuously done" logic is correct for it.
    allowedRoles: CASE_CAPABLE_ROLES,
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
  // No allowedRoles: /mtb-exp/mtbs is MTB Expert's own home, and this
  // group's Create-MTB step already self-skips for that role via the
  // existing missing-target check (the button itself is role-gated,
  // MTBs.tsx).
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
        // No /mtb-exp/sample-board route exists -- unlike the other
        // per-role exclusions here, this step's target is `null` (a
        // centred "run" card), so there's no missing-DOM-element for the
        // usual auto-skip to catch; it needs to be explicit.
        allowedRoles: CASE_CAPABLE_ROLES,
      },
    ],
  },
  sample_board: {
    kind: 'guided',
    ...MTB_SECTION,
    // No /mtb-exp/sample-board route (App.tsx) -- this group can never be
    // reached by MTB Expert regardless, but explicit for isKeySatisfied.
    allowedRoles: CASE_CAPABLE_ROLES,
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
    allowedRoles: CASE_CAPABLE_ROLES,
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
    allowedRoles: CASE_CAPABLE_ROLES,
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
    allowedRoles: CASE_CAPABLE_ROLES,
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
    allowedRoles: CASE_CAPABLE_ROLES,
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
    allowedRoles: CASE_CAPABLE_ROLES,
    steps: [
      {
        target: 'redact-tools',
        title: 'Hide what’s left',
        body: ({ isMobile }) => (isMobile ? 'Drag a box or draw over it. Undo is at the end.' : 'Drag a box or draw over it. Ctrl+Z undoes.'),
      },
      {
        target: 'redact-panel',
        title: 'Everything masked',
        body: 'Open this to see every automatic mask and yours, and reveal one if it hid something it shouldn’t have. Nothing changes until you save.',
      },
    ],
  },
  opinions: {
    kind: 'tip',
    // Inverse of every other case tip: Site Data Coordinator is the one
    // role that can't post opinions (canPostOpinions, ViewCase.tsx) --
    // MTB Expert can. The "Ask the board" step still self-skips for MTB
    // Expert via the existing missing-target check (isOwner-gated).
    allowedRoles: ['clinician', 'mtb_expert'],
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
    allowedRoles: CASE_CAPABLE_ROLES,
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
    allowedRoles: CASE_CAPABLE_ROLES,
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
    // No allowedRoles on the group itself -- unlike sample_board, an MTB
    // Expert does reach a real board (their own home route) and needs this
    // tip too. The meeting step is split in two below because, per
    // MTBDetail.tsx, an MTB Expert can only ever join a meeting someone else
    // started, never start one -- one shared "Start or join" body would be
    // wrong for that role.
    steps: [
      {
        target: 'mtb-add-case',
        title: 'Add a case',
        body: 'Share one of your verified cases so board members can review it.',
      },
      {
        target: 'mtb-meeting',
        title: 'Meetings',
        body: 'Join this board’s video meeting once someone starts it.',
        allowedRoles: ['mtb_expert'],
      },
      {
        target: 'mtb-meeting',
        title: 'Meetings',
        body: 'Start or join this board’s video meeting, and notify members when it starts.',
        allowedRoles: ['clinician', 'site_data_coordinator'],
      },
    ],
  },
};

export const isGroupApplicable = (id: TourGroupId, role: UserRole): boolean => {
  const allowed = TOUR_GROUPS[id].allowedRoles;
  return !allowed || allowed.includes(role);
};

// Does `key` apply to this role at all? For the two milestone keys that
// aren't themselves a TourGroupId, applicability is inherited from the one
// group whose last step actually marks them seen (SampleCase.tsx's
// `complete(['case_flow', 'case_review'])` for case_flow;
// sample_board's `completes: ['mtb_flow', 'mtb_board']` for mtb_flow) --
// otherwise a role that can never reach that group (no route to it) would
// be permanently blocked by every other group whose `requires` names it.
export const isKeyApplicable = (key: OnboardingKey, role: UserRole): boolean => {
  if (key === 'welcome') return isGroupApplicable('welcome', role);
  if (key === 'case_flow') return isGroupApplicable('sample_tabs', role);
  if (key === 'mtb_flow') return isGroupApplicable('sample_board', role);
  return isGroupApplicable(key as TourGroupId, role);
};

// A `requires` dependency counts as met if the key was genuinely seen, or
// if it can never be seen by this role in the first place. Deliberately
// NOT used for `blockedBy`: "blocked by X" must stay a literal seen[X]
// check, or a role for whom X is vacuously "satisfied" would also be
// wrongly treated as having already run (and so skip) the group X blocks.
export const isKeySatisfied = (key: OnboardingKey, role: UserRole, seen: Partial<Record<OnboardingKey, string>>): boolean =>
  Boolean(seen[key]) || !isKeyApplicable(key, role);

// The role-relevant subset of ALL_SAVED_KEYS -- the walkthrough is over
// once every key that actually applies to this role has been seen. Without
// this filter, a key no group ever sets for a given role (e.g. `opinions`
// for a Site Data Coordinator, or any isOwner-gated tip for an MTB Expert)
// would keep the walkthrough "not finished" forever.
export const applicableSavedKeys = (role: UserRole): OnboardingKey[] =>
  ALL_SAVED_KEYS.filter(key => isKeyApplicable(key, role));

export const resolveText = (text: Text | undefined, ctx: TourContext): string | undefined =>
  typeof text === 'function' ? text(ctx) : text;

// Target names to try, preferred first. The other variant is the fallback:
// phone landscape counts as mobile for layout but still shows the desktop nav.
export const targetNames = (step: TourStep, isMobile: boolean): string[] => {
  if (step.target === null) return [];
  if (typeof step.target === 'string') return [step.target];
  return isMobile ? [step.target.mobile, step.target.desktop] : [step.target.desktop, step.target.mobile];
};
