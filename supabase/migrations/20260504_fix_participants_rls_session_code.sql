-- Tighten participants RLS to only allow rows tied to active sessions by code.

drop policy if exists "students can join active sessions" on public.participants;
drop policy if exists "students can join active sessions by code" on public.participants;
drop policy if exists "students can join session by code" on public.participants;
drop policy if exists "teachers read own participants" on public.participants;
drop policy if exists "teachers read own participants by code" on public.participants;

create policy "students can join active sessions by code" on public.participants
for insert to anon, authenticated
with check (
  exists (
    select 1
    from public.sessions
    where sessions.code = participants.session_code
      and sessions.is_active = true
  )
);

create policy "teachers read own participants by code" on public.participants
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
