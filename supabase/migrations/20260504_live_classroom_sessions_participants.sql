alter table public.sessions
  add column if not exists status text not null default 'lobby';

create table if not exists public.participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  student_name text not null,
  joined_at timestamptz not null default now()
);

alter table public.participants enable row level security;

create policy if not exists "students can join active sessions" on public.participants
for insert to anon, authenticated
with check (
  exists (
    select 1 from public.sessions
    where sessions.id = participants.session_id
      and sessions.is_active = true
  )
);

create policy if not exists "teachers read own participants" on public.participants
for select to authenticated
using (
  exists (
    select 1 from public.sessions
    join public.lessons on lessons.id = sessions.lesson_id
    where sessions.id = participants.session_id
      and lessons.user_id = auth.uid()
  )
);

create index if not exists participants_session_joined_idx
on public.participants(session_id, joined_at);
