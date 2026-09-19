/**
 * Manual anonymization editor — API + Supabase access for
 * case_document_redactions / case_document_versions.
 *
 * Structured like voiceTranscriptionService.ts: small single-purpose
 * functions, typed interfaces, [RedactionService] stage logging. Reads go
 * straight to Supabase (RLS-scoped to case owner/MTB members, same as every
 * other table CasesContext reads); writes always go through the AWS Lambda
 * trigger routes, never directly to Supabase, since a write must also touch
 * S3 (regenerate the PDF) and the two must never desync.
 */

const API_BASE = 'https://gzgrswe52e.execute-api.ap-south-1.amazonaws.com/dev';

// Matches the ANONYMIZED_PREFIX constant in VMTB-OCR2ANO-V2 / the new
// redaction Lambdas. Kept here (not imported — this is a separate language
// and build) so the frontend can derive the same `document_name` the
// backend uses as the DB key from the plain filename VMTB-GET-REPORTS
// returns (e.g. "ANO_NNCMFAGSSS_22246_SomeDoc.pdf" -> "SomeDoc").
const ANONYMIZED_PREFIX_RE = /^ANO_NNCMFAGSSS_\d+_/;

export function toDocumentName(filename: string): string {
  return filename.replace(ANONYMIZED_PREFIX_RE, '').replace(/\.pdf$/i, '');
}

function log(stage: string, ...args: unknown[]) {
  console.log(`[RedactionService] ${stage}`, ...args);
}

/**
 * Normalized [0,1] coordinates (top-left origin), relative to the page
 * regardless of its actual pixel resolution — same convention
 * VMTB-OCR2ANO-V2 already uses for visual-PII detection. The backend
 * converts to pixel coordinates against whatever resolution the retained
 * original page image actually is at redraw time, so the editor never needs
 * to know or match that resolution.
 */
export interface RedactionBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type RedactionStyle = 'blur' | 'whiteout' | 'blackout';
export type RedactionSource = 'automated_text' | 'automated_visual' | 'manual';

export interface RedactionRecord {
  id: string;
  case_id: string;
  request_id: string;
  document_name: string;
  page_number: number;
  bbox: RedactionBBox;
  category: string | null;
  confidence: number | null;
  style: RedactionStyle;
  source: RedactionSource;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  removed_at: string | null;
  removed_by: string | null;
}

/** All redactions (active and removed) for one document, oldest page first — the editor filters to is_active itself so it can also show a "removed" audit view later if needed. */
export async function fetchRedactions(caseId: string, documentName: string): Promise<RedactionRecord[]> {
  const { supabase } = await import('../Supabase/client');
  const { data, error } = await supabase
    .from('case_document_redactions')
    .select('*')
    .eq('case_id', caseId)
    .eq('document_name', documentName)
    .order('page_number', { ascending: true });

  if (error) {
    log('fetchRedactions failed', error);
    throw new Error(`Couldn't load its redactions (${error.message}).`);
  }
  return (data || []) as RedactionRecord[];
}

export interface OriginalPage {
  pageNumber: number;
  url: string;
}

/**
 * The retained unredacted page images for a document — what the editor
 * renders against (never the anonymized file), so removing a redaction
 * reveals the real content instantly, client-side. Returns an empty array
 * once the document's 30-day retention window has closed (or if it
 * predates this feature and never had originals retained at all) — callers
 * must treat that as "editing unavailable for this document", not an error.
 */
export async function fetchOriginalPages(requestId: string, documentFilename: string): Promise<OriginalPage[]> {
  log('Stage: fetch original pages', { requestId, documentFilename });
  const response = await fetch(
    `${API_BASE}/get-originals?request_id=${encodeURIComponent(requestId)}&document_name=${encodeURIComponent(documentFilename)}`
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Couldn't load its original pages (HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ''}).`);
  }
  const data: { pages: { page_number: number; url: string }[] } = await response.json();
  return (data.pages || []).map((p) => ({ pageNumber: p.page_number, url: p.url }));
}

export type RedactionChange =
  | { action: 'add'; pageNumber: number; bbox: RedactionBBox; style: RedactionStyle }
  | { action: 'remove'; redactionId: string };

// ============================================================
// Reports listing
// ============================================================

export interface ReportFile {
  filename: string;
  url: string;
}

/** Lambda-side URL_EXPIRATION in VMTB-GET-REPORTS. */
export const REPORT_URL_TTL_MS = 15 * 60 * 1000;

/**
 * Every user-facing document for a request with freshly signed URLs. The URLs
 * expire after REPORT_URL_TTL_MS — never hold on to one past that, and never
 * open a document with a URL from an earlier listing (see fetchFreshReportUrl).
 */
export async function fetchReportFiles(requestId: string): Promise<ReportFile[]> {
  const response = await fetch(`${API_BASE}/get-reports?request_id=${encodeURIComponent(requestId)}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch reports (HTTP ${response.status})`);
  }
  const data: { files?: ReportFile[] } = await response.json();
  return data.files || [];
}

/**
 * A just-signed URL for one document, requested at the moment it is opened.
 * The Reports tab stays mounted for the whole page visit, so a URL from its
 * initial listing is routinely older than its 15-minute expiry by the time a
 * document gets opened — which S3 answers with 403 AccessDenied.
 */
export async function fetchFreshReportUrl(requestId: string, filename: string): Promise<string> {
  const response = await fetch(
    `${API_BASE}/get-reports?request_id=${encodeURIComponent(requestId)}&filename=${encodeURIComponent(filename)}`
  );
  if (response.status === 404) {
    throw new Error('This document no longer exists. It may have been removed.');
  }
  if (!response.ok) {
    throw new Error(`Couldn't get access to this document (HTTP ${response.status}).`);
  }
  const data: { files?: ReportFile[] } = await response.json();
  // Match by name rather than taking the first entry, so this stays correct
  // against a GET-REPORTS deployment that ignores the filename filter.
  const file = data.files?.find((f) => f.filename === filename);
  if (!file) throw new Error('This document no longer exists. It may have been removed.');
  return file.url;
}

/**
 * Freshly signed URLs for specific document keys (only this request's data/
 * and versions/ — the Lambda refuses anything else). Used to show MTB members
 * the document versions from the case's last verified state.
 */
export async function fetchSignedKeys(requestId: string, keys: string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  const response = await fetch(
    `${API_BASE}/get-reports?request_id=${encodeURIComponent(requestId)}&version_keys=${encodeURIComponent(keys.join(','))}`
  );
  if (!response.ok) {
    throw new Error(`Couldn't get access to these documents (HTTP ${response.status}).`);
  }
  const data: { files?: { key: string; url: string }[] } = await response.json();
  return Object.fromEntries((data.files || []).map((f) => [f.key, f.url]));
}
