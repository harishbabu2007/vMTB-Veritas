-- Manual anonymization editor: persist automated + manual redaction regions
-- and a version history for the anonymized PDF each region set produces.
--
-- Context: today VMTB-OCR2ANO-V2 draws redactions in-memory and discards the
-- bbox/category/confidence the instant it finishes — nothing is persisted,
-- and the pre-redaction page image is hard-deleted. This migration adds the
-- two tables that make "see where automated redaction happened" and "undo
-- one specific redaction" possible going forward. It does not backfill any
-- existing document processed before this shipped (see
-- docs/DOCUMENT_AI_PIPELINE.md's Phase 3 section for the same precedent —
-- additive, not retroactive).
--
-- Both tables are keyed by (case_id, request_id, document_name) rather than
-- case_documents.id: case_documents tracks pre-conversion original file
-- metadata, while a redaction applies to the *derived* per-item anonymized
-- PDF, whose logical name (item_name in the Lambda pipeline) has no row of
-- its own anywhere in Postgres today.
--
-- Written by: main/Cloud Functions/AWS/VMTB-OCR2ANO-V2,
-- VMTB-APPLY-REDACTION-CHANGES-V2, using the same anon-key Supabase client
-- these Lambdas already use for cases.report_status/summary updates. Read
-- by: main/src/services/redactionService.ts, directly via the Supabase
-- client.
--
-- RLS is intentionally left OFF on all three tables below (see grants at
-- the bottom) — matching every other table in this schema except the 3
-- that already have it enabled. This is a deliberate, tracked decision, not
-- an oversight: this feature has no real users yet, so it carries no new
-- risk to relax to the app's existing baseline now and lock it down before
-- real users touch it. See docs/LEGACY_AND_KNOWN_ISSUES.md, which now
-- tracks this alongside the schema's other 16 already-open tables, and
-- main/supabase/migrations_deferred/ for the ready-to-run follow-up
-- migration that enables RLS + restricts writes to service-role-only
-- (requires pulling the Supabase service-role key into these Lambdas'
-- env vars first, which is deliberately deferred until then). The SELECT
-- policies below are kept in place now (inert while RLS is off) precisely
-- so that follow-up migration only has to flip RLS on and tighten grants —
-- not redefine the policies too.
--
-- Editing model (as of the second revision of this feature): the *original*
-- unredacted page images are retained in S3 (uploads/{request_id}/originals/)
-- for a bounded 30-day window after first anonymization, and the editor UI
-- renders directly against them (so removing a redaction reveals the real
-- content instantly, client-side) rather than against the anonymized file.
-- All edits inside one editing session are batched client-side and applied
-- in a single write + single PDF regeneration when the user clicks Save —
-- there is no per-region backend round trip. After 30 days an S3 Lifecycle
-- Rule on the originals/ prefix deletes them (no custom code needed, since
-- the anonymized file is always already up to date — there is no "final
-- bake" step); editing simply becomes unavailable for that document once
-- its originals are gone. case_document_retention below tracks the S3
-- lifecycle clock so the frontend can know this without probing S3 directly.

CREATE TABLE IF NOT EXISTS public.case_document_redactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    document_name TEXT NOT NULL,
    page_number INTEGER NOT NULL,
    bbox JSONB NOT NULL,
    category TEXT,
    confidence NUMERIC,
    style TEXT NOT NULL DEFAULT 'whiteout' CHECK (style IN ('blur', 'whiteout', 'blackout')),
    source TEXT NOT NULL CHECK (source IN ('automated_text', 'automated_visual', 'manual')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at TIMESTAMPTZ,
    removed_by UUID REFERENCES auth.users(id)
);

COMMENT ON TABLE public.case_document_redactions IS
    'One row per redaction region ever applied to an anonymized document page, automated or manual. "Removing" a redaction never deletes the row — it sets is_active=false and stamps removed_at/removed_by, preserving the audit trail.';
COMMENT ON COLUMN public.case_document_redactions.bbox IS
    'Normalized {x0,y0,x1,y1} in the inclusive [0,1] range (top-left origin), relative to the page regardless of its actual pixel resolution -- same convention VMTB-OCR2ANO-V2 already uses for visual-PII detection (bbox_normalized). The backend converts to pixel coordinates against whatever resolution the retained original page image actually is at redraw time, so the frontend never needs to know or match that resolution.';

CREATE INDEX IF NOT EXISTS idx_case_document_redactions_lookup
    ON public.case_document_redactions (case_id, request_id, document_name, page_number)
    WHERE is_active = true;

CREATE TABLE IF NOT EXISTS public.case_document_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    document_name TEXT NOT NULL,
    version INTEGER NOT NULL,
    s3_key TEXT NOT NULL,
    redaction_id UUID REFERENCES public.case_document_redactions(id),
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (case_id, document_name, version)
);

COMMENT ON TABLE public.case_document_versions IS
    'Version history for a document''s anonymized PDF. The current version''s s3_key always points at the canonical uploads/{request_id}/data/ key; every superseded version''s s3_key is updated to its archived uploads/{request_id}/versions/ location at the moment it is superseded. redaction_id is null for the original automated version.';

CREATE INDEX IF NOT EXISTS idx_case_document_versions_lookup
    ON public.case_document_versions (case_id, request_id, document_name, version DESC);

-- RLS deliberately NOT enabled yet on either table — see the header comment.

DROP POLICY IF EXISTS "Case members can view redactions" ON public.case_document_redactions;
CREATE POLICY "Case members can view redactions"
    ON public.case_document_redactions
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.cases c
            WHERE c.id = case_document_redactions.case_id
              AND (c.owner_id = auth.uid()
                   OR EXISTS (
                       SELECT 1 FROM public.mtb_cases mc
                       JOIN public.mtb_members mm ON mm.mtb_id = mc.mtb_id
                       WHERE mc.case_id = c.id AND mm.user_id = auth.uid()
                   ))
        )
    );

DROP POLICY IF EXISTS "Case members can view document versions" ON public.case_document_versions;
CREATE POLICY "Case members can view document versions"
    ON public.case_document_versions
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.cases c
            WHERE c.id = case_document_versions.case_id
              AND (c.owner_id = auth.uid()
                   OR EXISTS (
                       SELECT 1 FROM public.mtb_cases mc
                       JOIN public.mtb_members mm ON mm.mtb_id = mc.mtb_id
                       WHERE mc.case_id = c.id AND mm.user_id = auth.uid()
                   ))
        )
    );

CREATE TABLE IF NOT EXISTS public.case_document_retention (
    case_id UUID NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    document_name TEXT NOT NULL,
    originals_retained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (case_id, document_name)
);

COMMENT ON TABLE public.case_document_retention IS
    'One row per document, tracking when its uploads/{request_id}/originals/ page images were (re-)written to S3 — the app-level mirror of the S3 Lifecycle Rule''s 30-day clock on that prefix. Upserted by VMTB-OCR2ANO-V2 every time it actually writes fresh originals (first anonymization, or a later full reprocess via Reports.tsx''s "Save All" edit flow) — a reprocess resets the S3 object''s age, so this must be re-stamped too, not just set once. The frontend adds 30 days to originals_retained_at to decide whether to offer the manual redaction editor for a document at all; VMTB-APPLY-REDACTION-CHANGES-V2 does the same check server-side as a defense-in-depth backstop before attempting to read originals that may already be gone.';

-- RLS deliberately NOT enabled yet — see the header comment.

DROP POLICY IF EXISTS "Case members can view document retention" ON public.case_document_retention;
CREATE POLICY "Case members can view document retention"
    ON public.case_document_retention
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.cases c
            WHERE c.id = case_document_retention.case_id
              AND (c.owner_id = auth.uid()
                   OR EXISTS (
                       SELECT 1 FROM public.mtb_cases mc
                       JOIN public.mtb_members mm ON mm.mtb_id = mc.mtb_id
                       WHERE mc.case_id = c.id AND mm.user_id = auth.uid()
                   ))
        )
    );

-- Matches the baseline schema's blanket-grant convention (RLS off = these
-- grants are the only real gate). See the header comment for why, and for
-- the follow-up migration that tightens this later.
GRANT ALL ON public.case_document_redactions TO anon, authenticated, service_role;
GRANT ALL ON public.case_document_versions TO anon, authenticated, service_role;
GRANT ALL ON public.case_document_retention TO anon, authenticated, service_role;
