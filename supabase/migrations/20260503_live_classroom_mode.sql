create extension if not exists "pgcrypto";

create table if not exists public.lessons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  title text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  code text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.responses (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  student_name text not null,
  answers jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.lessons enable row level security;
alter table public.sessions enable row level security;
alter table public.responses enable row level security;

create policy if not exists "teachers can manage lessons" on public.lessons
for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "teachers can manage sessions" on public.sessions;

create policy if not exists "teachers manage own sessions" on public.sessions
for all to authenticated
using (
  exists (
    select 1 from public.lessons
    where lessons.id = sessions.lesson_id
      and lessons.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.lessons
    where lessons.id = sessions.lesson_id
      and lessons.user_id = auth.uid()
  )
);

create policy if not exists "students can read active sessions by code" on public.sessions
for select to anon, authenticated using (is_active = true);

create policy if not exists "only active session responses" on public.responses
for insert to anon, authenticated
with check (
  exists (
    select 1 from public.sessions
    where sessions.id = responses.session_id
      and sessions.is_active = true
  )
);

drop policy if exists "teachers can read responses" on public.responses;

create policy if not exists "teachers read own session responses" on public.responses
for select to authenticated
using (
  exists (
    select 1
    from public.sessions
    join public.lessons on lessons.id = sessions.lesson_id
    where sessions.id = responses.session_id
      and lessons.user_id = auth.uid()
  )
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'code_length'
      and conrelid = 'public.sessions'::regclass
  ) then
    alter table public.sessions
      add constraint code_length check (char_length(code) = 6);
  end if;
end $$;

create unique index if not exists unique_student_per_session
on public.responses (session_id, student_name);
