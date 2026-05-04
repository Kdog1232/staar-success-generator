-- Strict + functional RLS for live classroom flow.

alter table public.sessions enable row level security;
alter table public.participants enable row level security;

-- Ensure participants uses session_code for joins/policies.
alter table public.participants
  add column if not exists session_code text;

-- Backfill from legacy session_id if present.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'participants'
      and column_name = 'session_id'
  ) then
    update public.participants p
    set session_code = s.code
    from public.sessions s
    where p.session_code is null
      and p.session_id = s.id;
  end if;
end $$;

alter table public.participants
  alter column session_code set not null;

-- Drop old policies cleanly.
drop policy if exists "teachers manage own sessions" on public.sessions;
drop policy if exists "students can read active sessions by code" on public.sessions;
drop policy if exists "students can join active sessions" on public.participants;
drop policy if exists "students can join active sessions by code" on public.participants;
drop policy if exists "students can join session by code" on public.participants;
drop policy if exists "teachers read own participants" on public.participants;
drop policy if exists "teachers read own participants by code" on public.participants;

-- Sessions: teacher ownership + active-read for join flow.
create policy "teachers insert own sessions" on public.sessions
for insert to authenticated
with check (
  exists (
    select 1
    from public.lessons
    where lessons.id = sessions.lesson_id
      and lessons.user_id = auth.uid()
  )
);

create policy "teachers update own sessions" on public.sessions
for update to authenticated
using (
  exists (
    select 1
    from public.lessons
    where lessons.id = sessions.lesson_id
      and lessons.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.lessons
    where lessons.id = sessions.lesson_id
      and lessons.user_id = auth.uid()
  )
);

create policy "teachers read own sessions" on public.sessions
for select to authenticated
using (
  exists (
    select 1
    from public.lessons
    where lessons.id = sessions.lesson_id
      and lessons.user_id = auth.uid()
  )
);

create policy "students read active sessions" on public.sessions
for select to anon, authenticated
using (is_active = true);

-- Participants: student joins only when active by session code.
create policy "students join active sessions by code" on public.participants
for insert to anon, authenticated
with check (
  exists (
    select 1
    from public.sessions
    where sessions.code = participants.session_code
      and sessions.is_active = true
  )
);

create policy "teachers read participants for own sessions" on public.participants
for select to authenticated
using (
  exists (
    select 1
    from public.sessions
    join public.lessons on lessons.id = sessions.lesson_id
    where sessions.code = participants.session_code
      and lessons.user_id = auth.uid()
  )
);

-- Performance indexes for lookup + realtime list ordering.
create index if not exists sessions_code_active_idx
  on public.sessions (code, is_active);

create index if not exists participants_session_code_joined_idx
  on public.participants (session_code, joined_at);
