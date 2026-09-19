-- Adds the S3 object key for a user's uploaded profile photo. Stores the key,
-- never a presigned URL (those expire) — the frontend resolves a fresh
-- presigned GET URL on demand via the profile-photo Lambda.
alter table public.profiles add column avatar_key text;
