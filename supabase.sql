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

-- Tope de accesos gratuitos (mientras se define el cobro, ver src/access/gate.ts).
-- Cambiar el 50 de "cap" antes de correr esto, o después con:
-- update public.access_counter set cap = 200 where id = 1;
create table if not exists public.access_counter (
  id int primary key default 1,
  used int not null default 0,
  cap int not null default 50,
  check (id = 1)
);

insert into public.access_counter (id, used, cap)
values (1, 0, 50)
on conflict (id) do nothing;

-- Reclama un cupo de forma atómica (UPDATE ... WHERE ... evita condiciones
-- de carrera entre jugadores que entran al mismo tiempo).
create or replace function public.claim_free_slot()
returns table(allowed boolean, "position" integer, cap integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used integer;
  v_cap integer;
begin
  update public.access_counter
  set used = used + 1
  where id = 1 and used < access_counter.cap
  returning used, access_counter.cap into v_used, v_cap;

  if v_used is not null then
    return query select true, v_used, v_cap;
  else
    select access_counter.used, access_counter.cap into v_used, v_cap
    from public.access_counter where id = 1;
    return query select false, v_used, v_cap;
  end if;
end;
$$;

-- El cliente (navegador) solo puede llamar a la función, nunca leer/escribir
-- la tabla directamente.
revoke all on function public.claim_free_slot() from public;
grant execute on function public.claim_free_slot() to anon;

alter table public.access_counter enable row level security;
-- Sin policies de select/insert/update para "anon": la tabla queda cerrada
-- a acceso directo; solo la función SECURITY DEFINER puede tocarla.
