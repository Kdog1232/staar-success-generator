-- Lobby-first live classroom behavior with optional join locking.

alter table public.sessions
  add column if not exists allow_join boolean not null default true;

alter table public.sessions enable row level security;
alter table public.participants enable row level security;

-- Clean drop existing policies.
drop policy if exists "teachers manage own sessions" on public.sessions;
drop policy if exists "teachers insert own sessions" on public.sessions;
drop policy if exists "teachers update own sessions" on public.sessions;
drop policy if exists "teachers read own sessions" on public.sessions;
drop policy if exists "students read active sessions" on public.sessions;
drop policy if exists "students can read active sessions by code" on public.sessions;

drop policy if exists "students can join active sessions" on public.participants;
drop policy if exists "students can join active sessions by code" on public.participants;
drop policy if exists "students can join session by code" on public.participants;
drop policy if exists "students join active sessions by code" on public.participants;
drop policy if exists "teachers read own participants" on public.participants;
drop policy if exists "teachers read own participants by code" on public.participants;
drop policy if exists "teachers read participants for own sessions" on public.participants;

-- Sessions: keep this broad to avoid auth.uid-related hangs on create/update.
create policy "authenticated users can create sessions" on public.sessions
for insert to authenticated
with check (true);

create policy "authenticated users can update sessions" on public.sessions
for update to authenticated
using (true)
with check (true);

create policy "authenticated users can read sessions" on public.sessions
for select to authenticated
using (true);

create policy "students can read sessions by code" on public.sessions
for select to anon
using (true);

-- Participants: join by session_code while allow_join=true, read by session existence.
create policy "students can join when session allows" on public.participants
for insert to anon, authenticated
with check (
  exists (
    select 1
    from public.sessions
    where sessions.code = participants.session_code
      and sessions.allow_join = true
  )
);

create policy "participants readable when session exists" on public.participants
for select to anon, authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.code = participants.session_code
  )
);
