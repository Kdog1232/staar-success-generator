drop policy if exists "users can delete own lessons" on public.lessons;

create policy "users can delete own lessons"
on public.lessons
for delete to authenticated
using (auth.uid() = user_id);
