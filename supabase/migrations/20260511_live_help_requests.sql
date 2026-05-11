create table if not exists public.help_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  student_name text not null,
  message text not null default 'Student raised their hand.',
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.help_requests enable row level security;

drop policy if exists "students create active help requests" on public.help_requests;
drop policy if exists "teachers read own help requests" on public.help_requests;
drop policy if exists "teachers update own help requests" on public.help_requests;

create policy "students create active help requests" on public.help_requests
for insert to anon, authenticated
with check (
  exists (
    select 1
    from public.sessions
    where sessions.id = help_requests.session_id
      and sessions.is_active = true
  )
);

create policy "teachers read own help requests" on public.help_requests
for select to authenticated
using (
  exists (
    select 1
    from public.sessions
    join public.lessons on lessons.id = sessions.lesson_id
    where sessions.id = help_requests.session_id
      and lessons.user_id = auth.uid()
  )
);

create policy "teachers update own help requests" on public.help_requests
for update to authenticated
using (
  exists (
    select 1
    from public.sessions
    join public.lessons on lessons.id = sessions.lesson_id
    where sessions.id = help_requests.session_id
      and lessons.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.sessions
    join public.lessons on lessons.id = sessions.lesson_id
    where sessions.id = help_requests.session_id
      and lessons.user_id = auth.uid()
  )
);

create index if not exists help_requests_session_created_idx
  on public.help_requests (session_id, resolved, created_at);

do $$
begin
  begin
    alter publication supabase_realtime add table public.help_requests;
  exception
    when duplicate_object then null;
    when undefined_object then null;
  end;
end $$;

create unique index if not exists help_requests_one_active_per_student_idx
  on public.help_requests (session_id, lower(student_name))
  where resolved = false;
