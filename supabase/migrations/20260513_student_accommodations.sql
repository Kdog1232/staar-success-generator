create table if not exists public.student_accommodations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  student_name text not null,
  text_to_speech boolean not null default false,
  spanish_translation boolean not null default false,
  content_supports boolean not null default false,
  simplified_supports boolean not null default false,
  extended_time boolean not null default false,
  read_aloud boolean not null default false,
  highlighted_vocabulary boolean not null default false,
  line_reader boolean not null default false,
  chunked_reading boolean not null default false,
  dyslexia_font boolean not null default false,
  font_size text default 'normal',
  highlighting_tools boolean not null default false,
  eliminate_answers boolean not null default false,
  vocabulary_glossary boolean not null default false,
  bilingual_vocabulary boolean not null default false,
  annotation_tools boolean not null default false,
  calm_testing_mode boolean not null default false,
  question_rephrase boolean not null default false,
  guided_reading_prompts boolean not null default false,
  color_overlay text default 'default',
  reduced_distraction boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.student_accommodations enable row level security;

create unique index if not exists student_accommodations_session_student_unique_idx
  on public.student_accommodations (session_id, student_name);

create index if not exists student_accommodations_session_idx
  on public.student_accommodations (session_id);

create index if not exists student_accommodations_student_lookup_idx
  on public.student_accommodations (session_id, lower(student_name));

create index if not exists student_accommodations_accessibility_idx
  on public.student_accommodations (session_id, font_size, color_overlay);


alter table public.student_accommodations
  drop constraint if exists student_accommodations_font_size_check,
  add constraint student_accommodations_font_size_check
    check (font_size in ('small', 'normal', 'large', 'extra_large'));

alter table public.student_accommodations
  drop constraint if exists student_accommodations_color_overlay_check,
  add constraint student_accommodations_color_overlay_check
    check (color_overlay in ('default', 'cream', 'soft_blue', 'soft_gray', 'dark'));

create or replace function public.set_student_accommodations_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_student_accommodations_updated_at on public.student_accommodations;
create trigger set_student_accommodations_updated_at
before update on public.student_accommodations
for each row execute function public.set_student_accommodations_updated_at();

drop policy if exists "teachers read own student accommodations" on public.student_accommodations;
drop policy if exists "teachers insert own student accommodations" on public.student_accommodations;
drop policy if exists "teachers update own student accommodations" on public.student_accommodations;
drop policy if exists "students read active own student accommodations" on public.student_accommodations;

create policy "teachers read own student accommodations" on public.student_accommodations
for select to authenticated
using (
  exists (
    select 1
    from public.sessions
    join public.lessons on lessons.id = sessions.lesson_id
    where sessions.id = student_accommodations.session_id
      and lessons.user_id = auth.uid()
  )
);

create policy "teachers insert own student accommodations" on public.student_accommodations
for insert to authenticated
with check (
  exists (
    select 1
    from public.sessions
    join public.lessons on lessons.id = sessions.lesson_id
    where sessions.id = student_accommodations.session_id
      and lessons.user_id = auth.uid()
  )
);

create policy "teachers update own student accommodations" on public.student_accommodations
for update to authenticated
using (
  exists (
    select 1
    from public.sessions
    join public.lessons on lessons.id = sessions.lesson_id
    where sessions.id = student_accommodations.session_id
      and lessons.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.sessions
    join public.lessons on lessons.id = sessions.lesson_id
    where sessions.id = student_accommodations.session_id
      and lessons.user_id = auth.uid()
  )
);

-- Student reads are intentionally limited to active-session rows and the client always
-- queries by its joined session_id + exact student_name. With anonymous student joins,
-- PostgREST cannot independently know the typed student name without adding auth.
create policy "students read active own student accommodations" on public.student_accommodations
for select to anon, authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = student_accommodations.session_id
      and sessions.is_active = true
  )
);

do $$
begin
  begin
    alter publication supabase_realtime add table public.student_accommodations;
  exception
    when duplicate_object then null;
    when undefined_object then null;
  end;
end $$;
