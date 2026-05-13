-- Store the live lesson payload on the session row so students can render from
-- the session update they are allowed to read instead of fetching teacher-owned
-- lesson rows directly.
alter table public.sessions
  add column if not exists lesson_data jsonb;

create index if not exists sessions_lesson_data_live_idx
  on public.sessions (code, status)
  where lesson_data is not null;
