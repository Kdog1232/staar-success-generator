alter table public.help_requests
add column if not exists teacher_response text;

alter table public.help_requests
add column if not exists responded_at timestamptz;

drop policy if exists "students read active help request responses" on public.help_requests;

create policy "students read active help request responses" on public.help_requests
for select to anon, authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = help_requests.session_id
      and sessions.is_active = true
  )
);
