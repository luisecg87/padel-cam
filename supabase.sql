-- Pádel Cam — esquema de la nube (Fase 2). Ejecutar UNA VEZ en el proyecto:
-- Supabase → SQL Editor → New query → pegar todo esto → Run.
--
-- Una fila por usuario: el perfil y el progreso viajan como un único jsonb
-- (espejo de las claves de localStorage; ver SYNC_KEYS en src/cloud.ts).
-- Las políticas RLS garantizan que cada usuario SOLO puede leer y escribir
-- su propia fila, aunque la clave "anon" sea pública.

create table if not exists public.jugadores (
  id uuid primary key references auth.users (id) on delete cascade,
  datos jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.jugadores enable row level security;

drop policy if exists "leer lo propio" on public.jugadores;
create policy "leer lo propio"
  on public.jugadores for select
  using (auth.uid() = id);

drop policy if exists "crear lo propio" on public.jugadores;
create policy "crear lo propio"
  on public.jugadores for insert
  with check (auth.uid() = id);

drop policy if exists "actualizar lo propio" on public.jugadores;
create policy "actualizar lo propio"
  on public.jugadores for update
  using (auth.uid() = id)
  with check (auth.uid() = id);
