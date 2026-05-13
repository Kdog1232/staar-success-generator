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

alter table public.student_accommodations
  drop constraint if exists student_accommodations_font_size_check,
  add constraint student_accommodations_font_size_check
    check (font_size in ('small', 'normal', 'large', 'extra_large'));

alter table public.student_accommodations
  drop constraint if exists student_accommodations_color_overlay_check,
  add constraint student_accommodations_color_overlay_check
    check (color_overlay in ('default', 'cream', 'soft_blue', 'soft_gray', 'dark'));

create index if not exists student_accommodations_accessibility_idx
  on public.student_accommodations (session_id, font_size, color_overlay);
