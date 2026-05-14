-- Track exactly when a lobby transitions to a live classroom session.
alter table public.sessions
  add column if not exists started_at timestamptz;
