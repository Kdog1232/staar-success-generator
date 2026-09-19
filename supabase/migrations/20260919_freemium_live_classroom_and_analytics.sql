-- Lessons Ready freemium relaunch:
--   * generation events are queryable for retention analysis
--   * free teachers receive three atomic session creations per UTC calendar month
--   * direct session writes are restricted to lesson owners

create table if not exists public.generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  subject text,
  grade text,
  skill text,
  level text,
  mode text,
  created_at timestamptz not null default now()
);

create index if not exists generations_user_created_idx
  on public.generations (user_id, created_at desc);

alter table public.generations enable row level security;

drop policy if exists "teachers read own generation events" on public.generations;
create policy "teachers read own generation events"
on public.generations for select to authenticated
using (user_id = auth.uid());

-- Serialize creation per teacher. This prevents two concurrent requests from
-- both observing two sessions and creating a fourth free session.
create or replace function public.create_live_classroom_session(
  p_lesson_id uuid,
  p_code text
)
returns setof public.sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_plan text;
  v_monthly_count integer;
  v_session public.sessions;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  if not exists (
    select 1 from public.lessons l
    where l.id = p_lesson_id and l.user_id = v_user_id
  ) then
    raise exception using errcode = '42501', message = 'LESSON_NOT_OWNED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

  select coalesce(p.plan, 'free') into v_plan
  from public.profiles p
  where p.id = v_user_id;
  v_plan := coalesce(v_plan, 'free');

  if v_plan not in ('paid', 'pro') then
    select count(*)::integer into v_monthly_count
    from public.sessions s
    join public.lessons l on l.id = s.lesson_id
    where l.user_id = v_user_id
      and s.created_at >= date_trunc('month', now())
      and s.created_at < date_trunc('month', now()) + interval '1 month';

    if v_monthly_count >= 3 then
      raise exception using
        errcode = 'P0001',
        message = 'LIVE_CLASSROOM_MONTHLY_LIMIT_REACHED',
        detail = 'Free teachers can create 3 Live Classroom sessions per calendar month.';
    end if;
  end if;

  insert into public.sessions (lesson_id, code, status, is_active, allow_join)
  values (p_lesson_id, p_code, 'lobby', false, true)
  returning * into v_session;

  return next v_session;
end;
$$;

revoke all on function public.create_live_classroom_session(uuid, text) from public, anon;
grant execute on function public.create_live_classroom_session(uuid, text) to authenticated;

create or replace function public.get_live_classroom_usage()
returns table (
  plan text,
  sessions_used integer,
  session_limit integer,
  sessions_remaining integer,
  limit_reached boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with teacher as (
    select auth.uid() as user_id,
           coalesce((select p.plan from public.profiles p where p.id = auth.uid()), 'free') as plan
  ), usage as (
    select count(*)::integer as used
    from public.sessions s
    join public.lessons l on l.id = s.lesson_id
    join teacher t on t.user_id = l.user_id
    where s.created_at >= date_trunc('month', now())
      and s.created_at < date_trunc('month', now()) + interval '1 month'
  )
  select t.plan,
         u.used,
         case when t.plan in ('paid', 'pro') then null else 3 end,
         case when t.plan in ('paid', 'pro') then null else greatest(0, 3 - u.used) end,
         t.plan not in ('paid', 'pro') and u.used >= 3
  from teacher t cross join usage u
  where t.user_id is not null;
$$;

revoke all on function public.get_live_classroom_usage() from public, anon;
grant execute on function public.get_live_classroom_usage() to authenticated;

-- Replace the deliberately broad policies introduced for the lobby prototype.
-- Session INSERT is intentionally available only through the atomic RPC above.
drop policy if exists "authenticated users can create sessions" on public.sessions;
drop policy if exists "authenticated users can update sessions" on public.sessions;
drop policy if exists "authenticated users can read sessions" on public.sessions;
drop policy if exists "students can read sessions by code" on public.sessions;
drop policy if exists "teachers manage own sessions" on public.sessions;
drop policy if exists "teachers insert own sessions" on public.sessions;
drop policy if exists "teachers update own sessions" on public.sessions;
drop policy if exists "teachers read own sessions" on public.sessions;
drop policy if exists "students read active sessions" on public.sessions;
drop policy if exists "students can read active sessions by code" on public.sessions;

create policy "teachers update own sessions" on public.sessions
for update to authenticated
using (exists (
  select 1 from public.lessons l
  where l.id = sessions.lesson_id and l.user_id = auth.uid()
))
with check (exists (
  select 1 from public.lessons l
  where l.id = sessions.lesson_id and l.user_id = auth.uid()
));

create policy "teachers read own sessions" on public.sessions
for select to authenticated
using (exists (
  select 1 from public.lessons l
  where l.id = sessions.lesson_id and l.user_id = auth.uid()
));

-- Lobby rows must be readable for code entry; live rows carry the lesson used
-- by students. Ended sessions cease being publicly readable.
create policy "students read joinable or active sessions" on public.sessions
for select to anon, authenticated
using (allow_join = true or is_active = true);

-- Participants are a teacher roster. Students only need their INSERT result.
drop policy if exists "students can join active sessions" on public.participants;
drop policy if exists "students can join active sessions by code" on public.participants;
drop policy if exists "students can join session by code" on public.participants;
drop policy if exists "students join active sessions by code" on public.participants;
drop policy if exists "students can join when session allows" on public.participants;
drop policy if exists "participants readable when session exists" on public.participants;
drop policy if exists "teachers read own participants" on public.participants;
drop policy if exists "teachers read own participants by code" on public.participants;
drop policy if exists "teachers read participants for own sessions" on public.participants;

create policy "students join matching open session" on public.participants
for insert to anon, authenticated
with check (exists (
  select 1 from public.sessions s
  where s.id = participants.session_id
    and s.code = participants.session_code
    and s.allow_join = true
));

create policy "teachers read participants for own sessions" on public.participants
for select to authenticated
using (exists (
  select 1
  from public.sessions s
  join public.lessons l on l.id = s.lesson_id
  where (s.id = participants.session_id or s.code = participants.session_code)
    and l.user_id = auth.uid()
));

-- Existing response, help-request, and accommodation policies already scope
-- teacher access through sessions -> lessons -> auth.uid(), and student writes
-- to active sessions. They are intentionally retained unchanged. Relaunch
-- metrics remain derivable from profiles, generations, lessons, sessions, and
-- participants without duplicating teacher or student data in another table.
