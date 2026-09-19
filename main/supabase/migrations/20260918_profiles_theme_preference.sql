-- Per-user Light/Dark/System theme preference. NULL means no preference set
-- yet (the client falls back to the cached/system value).
alter table public.profiles
  add column theme_preference text check (theme_preference in ('light', 'dark', 'system'));
