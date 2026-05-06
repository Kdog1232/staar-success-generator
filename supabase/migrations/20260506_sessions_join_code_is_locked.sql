-- Keep both legacy and current classroom codes populated for live session joins.

alter table public.sessions
  add column if not exists code text;

alter table public.sessions
  add column if not exists join_code text;

alter table public.sessions
  add column if not exists is_locked boolean not null default false;

update public.sessions
set join_code = code
where join_code is null
  and code is not null;

update public.sessions
set code = join_code
where code is null
  and join_code is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'join_code_length'
      and conrelid = 'public.sessions'::regclass
  ) then
    alter table public.sessions
      add constraint join_code_length check (join_code is null or char_length(join_code) = 6);
  end if;
end $$;

create unique index if not exists sessions_join_code_unique_idx
on public.sessions (join_code)
where join_code is not null;
