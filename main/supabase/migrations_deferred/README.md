# Deferred migrations

Files here are **intentionally not inside `../migrations/`** so `supabase
db push` / the Supabase CLI / `mcp__supabase__apply_migration` never picks
them up automatically. Each one is a real, ready-to-run migration for a
security tightening that's been deliberately postponed — see
`docs/LEGACY_AND_KNOWN_ISSUES.md` for why each one is here and what
triggers actually applying it.

## How to apply one when its time comes

1. Do whatever prerequisite the file's header comment says (e.g. pull a
   secret, set a Lambda env var).
2. Copy it into `../migrations/` with a fresh `YYYYMMDD_` prefix (today's
   date, not the original filename's date — it needs to sort after
   everything already applied).
3. Apply it the normal way (`mcp__supabase__apply_migration` or
   `supabase db push`).
4. Delete it from this folder and update the `docs/LEGACY_AND_KNOWN_ISSUES.md`
   entry that pointed to it.

## Contents

- `lock_down_manual_redaction_tables.sql` — enables RLS on
  `case_document_redactions`, `case_document_versions`,
  `case_document_retention` (added in
  `../migrations/20260914_manual_redaction_editor.sql`) and restricts
  writes to the service role only. Deferred because this feature has no
  real users yet; apply before onboarding real users to the manual
  anonymization editor. Requires `SUPABASE_SERVICE_ROLE_KEY` to be set as
  an env var on `VMTB-OCR2ANO-V2` and `VMTB-APPLY-REDACTION-CHANGES-V2`
  first (and those two Lambdas' code switched from the anon-key client to
  a service-role client for their writes to these three tables) — this
  migration alone is not sufficient on its own, it will just break those
  Lambdas' writes if applied without that code change.
