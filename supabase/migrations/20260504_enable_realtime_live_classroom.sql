-- Ensure live classroom tables emit realtime events for lobby + session transitions.
do $$
begin
  begin
    alter publication supabase_realtime add table public.sessions;
  exception
    when duplicate_object then null;
    when undefined_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.participants;
  exception
    when duplicate_object then null;
    when undefined_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.responses;
  exception
    when duplicate_object then null;
    when undefined_object then null;
  end;
end $$;
