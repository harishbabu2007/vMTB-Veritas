# Rollbacks

One file per applied migration that tightens access, undoing exactly that
migration.

**These are not pending work.** Each file is the escape hatch for one
migration, to use only after that migration has been applied and turns out
to have broken a path we missed. (The 2026-10-03 and 2026-10-10 migrations
they pair with were written before being applied; check `list_migrations`
for what is live.) That is the opposite of `../migrations_deferred/`, which holds
tightenings that have *not* been applied yet — don't confuse the two
directories.

Nothing here is picked up by `supabase db push` or
`mcp__supabase__apply_migration`, because it sits outside `../migrations/`.

## Using one

1. Confirm the break is real and is caused by that migration. A failing path
   usually names the privilege or policy in its error, and the pre-launch
   hardening work recorded a privilege matrix per change to compare against.
2. Prefer fixing forward. Most breaks are one missing column grant or one
   policy that should have used `effective_owner_id()` instead of
   `auth.uid()` — a one-line follow-up migration beats re-opening the whole
   surface the rollback re-opens.
3. If you do run one, apply it as a normal migration (copy into
   `../migrations/` with today's `YYYYMMDD_` prefix, or run the SQL directly)
   and note it, because every file here deliberately restores an exposure
   that was closed on purpose.
4. Re-apply the original as soon as the blocking path is fixed.

## Contents

From the pre-launch hardening pass (2026-10-03, continued 2026-10-10).

- `20261003_profiles_identity_server_owned_rollback.sql` — restores
  blanket table grants on `profiles` and the old
  `enforce_profile_role_immutable` trigger, and gives clients back access to
  `whatsapp_otps`. Re-opens `role`, `linked_clinician_id`,
  `whatsapp_number` and `whatsapp_verified` to client writes, which is what
  decides whose cases a session can reach.
- `20261003_profiles_scope_select_rollback.sql` — makes `profiles`
  world-readable again (every user's name, hospital, phone number, role).
  The paired phone-lookup RPCs keep working either way, so this is only
  needed if some read path was missed.
- `20261003_revoke_public_execute_grants_rollback.sql` — restores the
  implicit PUBLIC execute grant on the case and meeting-transcript RPCs. If
  only one RPC is failing for signed-in users, grant that one to
  `authenticated` instead of running this.
- `20261010_p1_rpc_and_view_hardening_rollback.sql` — restores the old default
  privileges, the old `_run_json()` / `get_case_run_state()` bodies and the
  view and meeting-table grants, and drops `join_mtb_by_code` /
  `restore_case`. Re-opens run state to anyone holding a session id (and
  `get_case_run_state` to anon) and writes through `cases_viewer_safe`.
