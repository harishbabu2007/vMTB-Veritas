# Authentication and Notifications

## Auth flows

Three ways in, all wired through `main/src/context/AuthContext.tsx` and
`main/src/services/whatsappOtp.ts`, backed by two Supabase Edge Functions.

### Google OAuth

`AuthContext.signInWithGoogle(flow)` → `supabase.auth.signInWithOAuth({provider:
'google', redirectTo: origin + '/auth/callback' + (signup ? '?flow=signup' :
'')})` → Supabase-hosted OAuth → redirects back to `AuthCallback.tsx`, which
branches on the `?flow=signup` query param vs. whether a `profiles` row
already exists for the Google user id:
- No profile + login flow → redirect to `/signup` (carrying Google state) to
  finish onboarding.
- Profile exists → redirect to `/my-cases`.

Used by both `Login.tsx` and `Signup.tsx` (`Signup.tsx`'s first step,
`google-gate`, makes Google OAuth **mandatory** before the rest of the signup
form).

### Phone + password

`Login.tsx`'s `handlePhonePasswordLogin` → `isPhoneNumberRegistered`
(client-side query against `profiles.whatsapp_number`, used to give a
friendly "not registered" redirect) → `AuthContext.loginWithPhone` → looks up
`profiles.whatsapp_number` → invokes the `verify_whatsapp_otp` Edge Function
with `action: 'get_email'` (a dummy OTP) to resolve the account's real
underlying auth email → `supabase.auth.signInWithPassword({email, password})`.

Both phone logins (this one and WhatsApp OTP) find the account **only by
`profiles.whatsapp_number`**, never by `auth.users.phone`. An account can have
a confirmed `auth.users.phone` (a `phone` identity) while
`profiles.whatsapp_number` is empty; phone login then reports "No account was
found" and redirects to signup, even with the right password. Seen on one
account on 2026-09-19 and fixed by setting `whatsapp_number` by hand; how that
account ended up without it is unconfirmed.

### WhatsApp OTP

Two Edge Functions, both server-side only (the browser never calls Gupshup
directly):

- **`send_whatsapp_otp`** — generates a 6-digit code, stores only its
  SHA-256 hash in `whatsapp_otps`, sends it via Gupshup's WhatsApp template
  API.
- **`verify_whatsapp_otp`** — a single multiplexed endpoint keyed by
  `payload.action` (or its absence):
  - *(default, signup completion)* — verifies the OTP, sets the account
    password, confirms the phone in `auth.users`, upserts `profiles`.
  - `action: 'login'` — returns an `{email, email_otp}` pair; the client
    then calls `supabase.auth.verifyOtp({type: 'email'})` itself to
    establish a real session. **WhatsApp-OTP login piggybacks on
    Supabase's email-OTP session mechanism** rather than minting its own
    JWT.
  - `action: 'get_email'` — resolves an account's underlying auth email
    from its WhatsApp number (used by phone+password login above).
  - `action: 'reset_verify'` / `action: 'reset_password'` — the
    forgot-password flow's OTP-verify and password-set steps.

Client wrappers for all of the above: `main/src/services/whatsappOtp.ts`
(`sendWhatsAppOTP`, `verifyWhatsAppOTPForExistingUser`,
`verifyWhatsAppOTPForLogin`, `verifyWhatsAppOTPForReset`,
`completePasswordReset`, `isPhoneNumberRegistered`,
`extractEdgeFunctionError` for parsing Edge Function error bodies into
user-facing strings).

### Pages wired to these flows

`Login.tsx`, `Signup.tsx`, `AuthCallback.tsx`, `VerifyWhatsApp.tsx` (a
standalone re-verification page for phone numbers not collected at signup),
`ForgotPassword.tsx` (4 steps: phone → otp → reset → success;
`ResetPassword.tsx` is a thin wrapper around it). `CheckYourEmail.tsx` (a
generic "check your email" confirmation screen) also exists but is not
routed or imported anywhere — see `docs/LEGACY_AND_KNOWN_ISSUES.md`.

### Theme (light / dark / system)

A per-user preference, `profiles.theme_preference` (nullable; `light`,
`dark`, `system`). **The default is light**: a signed-out visitor, a new
signup, a new device and anyone whose value is NULL get light, whatever their
OS prefers. The OS is consulted only for a user who explicitly picked
"System" (the picker in the `Layout.tsx` profile menu). The choice is saved
to the user's own row only and follows them across devices.

- **Engine:** `src/context/ThemeContext.tsx` (mounted inside `AuthProvider`),
  helpers in `src/utils/themeStorage.ts`. It toggles the `dark` class on
  `<html>`; nothing else in the app reads the theme.
- **First paint:** the inline script in `main/index.html` applies the class
  before React loads. It reads the cached user id (`vmtb.auth.user`, the same
  key `AuthContext` uses) and that user's hint `vmtb-theme:<userId>`; no
  stored user → light. The script, `themeStorage.ts` and `ThemeContext` must
  agree — change all three together. The hint is only a hint; the profile
  row is the source of truth and is re-read after login. Hints are per user
  so a shared computer never shows one person's theme to another; logout in
  `AuthContext` deliberately keeps them. The old global `vmtb-theme-last` key
  is deleted on load.
- **Saving:** `setTheme` applies immediately, then writes in order through a
  queue (`.update(...).select('id')`, falling back to an upsert when the
  profile row doesn't exist yet). A write that fails or matches no row is
  reverted with an error toast — never silently kept. A profile read that
  started before the user's choice is ignored, so a fresh choice can't be
  overwritten. Supabase query builders are lazy: an un-awaited `.update()`
  sends nothing (the earlier version's saves never reached the database).
  Other tabs follow through the `storage` event on the hint key.
- **Colours are semantic tokens.** `src/index.css` defines them under `:root`
  and `:root.dark` (surfaces, text incl. `text-subtle`/`text-faint`, borders,
  `primary-solid`, `link`, `overlay`, `paper`, and four feedback families
  `danger`/`success`/`info`/`warning` with `-text`/`-bg`/`-bg-strong`/
  `-border`/`-solid`); `tailwind.config.js` maps them to classes
  (`bg-surface`, `text-danger`, `bg-danger-solid`, …). Components use no raw
  palette classes, hex/rgb literals or `dark:` colour variants. A document
  page stays white (`bg-paper`) in both themes.
- **Guard:** `npm run check:theme` (in `main/`, `scripts/check-theme.mjs`)
  fails on any of those in `src/` and checks AA contrast of the token pairs
  in both themes. A literal that must stay is allowed with a
  `theme-allow: <reason>` comment (or a `theme-allow-start` /
  `theme-allow-end` block); current uses are the Google logo, the redaction
  overlay colours in `components/documents/redactionStyles.ts`, and a toast
  shadow. `VoiceRecorder.*` and the dead backup files are skipped — see
  `docs/LEGACY_AND_KNOWN_ISSUES.md`.

### Legacy/unused auth code — flagged, not removed

`AuthContext.tsx` also defines several methods no current page appears to
call: `login` (plain native `supabase.auth.signUp`/`signInWithPassword`),
`signup` (native Supabase signup + `profiles` upsert — superseded by the
Google+WhatsApp-OTP flow above), `sendPhoneOtp`/`verifyPhoneOtp` (native SMS
OTP via `supabase.auth.signInWithOtp`/`verifyOtp` with `type: 'sms'`), and
`requestPasswordReset` (native email reset link — superseded by the
WhatsApp-OTP forgot-password flow). These aren't dead in the sense of being
unreachable — they're exported and could be wired up — but no page currently
does. See `docs/LEGACY_AND_KNOWN_ISSUES.md`.

## Notifications

Two more Supabase Edge Functions, fired by three database triggers (captured
as commented-out `CREATE OR REPLACE TRIGGER` statements in the migration dump
— see `docs/DATABASE_SCHEMA.md` for why, and for the plaintext-secret finding
in that same file):

- **`notify_case_created`** — `AFTER INSERT ON mtb_cases` — fires when a case
  is shared into an MTB (this is the actual "case created" signal, not a
  trigger on `cases` itself).
- **`notify_meeting`** — `AFTER INSERT ON meeting_sessions` — fires when a
  live MTB meeting session row is created. Gated per-MTB by
  `mtbs.notification_enabled` (default `true`).
- **`notify_opinion_added`** — `AFTER INSERT ON case_opinions` — fires when
  a new opinion, question answer, or reply is posted.

All four notification/OTP Edge Functions live under
`main/Supabase Edge Functions/` (Deno), currently git-untracked alongside
the document-AI pipeline code — see the root `CLAUDE.md`.
