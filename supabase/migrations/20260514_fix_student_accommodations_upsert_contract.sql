-- Keep the student_accommodations upsert target deterministic for teacher saves.
-- The frontend saves one row per (session_id, student_name), so normalize any
-- pre-existing duplicates before enforcing the backend contract used by
-- .upsert(..., { onConflict: 'session_id,student_name' }).

alter table public.student_accommodations
  add column if not exists line_reader boolean not null default false,
  add column if not exists chunked_reading boolean not null default false,
  add column if not exists dyslexia_font boolean not null default false,
  add column if not exists font_size text default 'normal',
  add column if not exists highlighting_tools boolean not null default false,
  add column if not exists eliminate_answers boolean not null default false,
  add column if not exists vocabulary_glossary boolean not null default false,
  add column if not exists bilingual_vocabulary boolean not null default false,
  add column if not exists annotation_tools boolean not null default false,
  add column if not exists calm_testing_mode boolean not null default false,
  add column if not exists question_rephrase boolean not null default false,
  add column if not exists guided_reading_prompts boolean not null default false,
  add column if not exists color_overlay text default 'default',
  add column if not exists reduced_distraction boolean not null default false;

with ranked_accommodations as (
  select
    id,
    row_number() over (
      partition by session_id, student_name
      order by updated_at desc nulls last, created_at desc nulls last, id desc
    ) as duplicate_rank
  from public.student_accommodations
)
delete from public.student_accommodations accommodations
using ranked_accommodations ranked
where accommodations.id = ranked.id
  and ranked.duplicate_rank > 1;

alter table public.student_accommodations
  drop constraint if exists student_accommodations_session_student_unique;

drop index if exists public.student_accommodations_session_student_unique_idx;

alter table public.student_accommodations
  add constraint student_accommodations_session_student_unique
  unique (session_id, student_name);

alter table public.student_accommodations
  drop constraint if exists student_accommodations_font_size_check,
  add constraint student_accommodations_font_size_check
    check (font_size in ('small', 'normal', 'large', 'extra_large'));

alter table public.student_accommodations
  drop constraint if exists student_accommodations_color_overlay_check,
  add constraint student_accommodations_color_overlay_check
    check (color_overlay in ('default', 'cream', 'soft_blue', 'soft_gray', 'dark'));

drop policy if exists "teachers read own student accommodations" on public.student_accommodations;
drop policy if exists "teachers insert own student accommodations" on public.student_accommodations;
drop policy if exists "teachers update own student accommodations" on public.student_accommodations;

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
