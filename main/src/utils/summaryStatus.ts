import type { SummaryStatus } from '../context/CasesContext';

export interface SummaryStatusMeta {
  label: string;
  bg: string;
  text: string;
  description: string;
}

// Single source for how a summary status is shown: the My Cases badge and the
// status info tooltip both read from here so their labels and colours match.
export const SUMMARY_STATUS_META: Record<SummaryStatus, SummaryStatusMeta> = {
  processing: {
    label: 'In Progress',
    bg: 'bg-status-processing-bg',
    text: 'text-status-processing-text',
    description: 'AI is generating the summary from the uploaded documents. This usually takes a few minutes.',
  },
  unverified: {
    label: 'Pending',
    bg: 'bg-status-pending-bg',
    text: 'text-status-pending-text',
    description: 'The summary is ready. Open the case to review and verify it.',
  },
  verified: {
    label: 'Complete',
    bg: 'bg-status-verified-bg',
    text: 'text-status-verified-text',
    description: 'You verified the summary. The case can now be shared into MTBs.',
  },
  failed: {
    label: 'Failed',
    bg: 'bg-status-failed-bg',
    text: 'text-status-failed-text',
    description: 'Summary generation failed. Open the case to try again.',
  },
};

export const SUMMARY_STATUS_ORDER: SummaryStatus[] = ['processing', 'unverified', 'verified', 'failed'];

// Cases with no status yet are treated as pending, as before.
export const getSummaryStatusMeta = (status?: SummaryStatus): SummaryStatusMeta =>
  (status && SUMMARY_STATUS_META[status]) || SUMMARY_STATUS_META.unverified;

export interface MtbCaseStatusMeta {
  label: string;
  className: string;
  description: string;
}

/**
 * How a case shared into an MTB reads to board members while it isn't in a
 * verified state. A case only enters an MTB once verified, so here
 * 'unverified' always means "the owner changed it and hasn't re-verified" —
 * members must not mistake the pending summary for the one they reviewed.
 * Returns null for verified cases (the reviewed/not-reviewed badge applies).
 */
export function getMtbCaseStatusMeta(status?: SummaryStatus): MtbCaseStatusMeta | null {
  switch (status) {
    case 'verified':
      return null;
    case 'processing':
      return {
        label: 'Updating — documents changed',
        className: 'bg-status-processing-bg text-status-processing-text',
        description: 'The owner changed this case’s documents. A new summary is being generated.',
      };
    case 'failed':
      return {
        label: 'Update failed — awaiting owner',
        className: 'bg-status-failed-bg text-status-failed-text',
        description: 'Regenerating this case’s summary failed. The owner needs to retry it.',
      };
    default:
      return {
        label: 'Case updated — awaiting verification',
        className: 'bg-status-mtb-updated-bg text-status-mtb-updated-text',
        description: 'The owner changed this case. Its updated summary hasn’t been verified yet.',
      };
  }
}
