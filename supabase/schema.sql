-- Tope global de accesos gratuitos para Pádel Cam.
-- Ejecutar una vez en el SQL Editor del proyecto Supabase (nuevo o existente).
-- Cambiar el 50 de "cap" por el cupo que quieras antes de correrlo,
-- o actualizarlo despues con: update access_counter set cap = 200 where id = 1;

create table if not exists access_counter (
  id int primary key default 1,
  used int not null default 0,
  cap int not null default 50,
  check (id = 1)
);

insert into access_counter (id, used, cap)
values (1, 0, 50)
on conflict (id) do nothing;

-- Reclama un cupo de forma atomica (UPDATE ... WHERE ... evita condiciones
-- de carrera entre jugadores que entran al mismo tiempo).
create or replace function claim_free_slot()
returns table(allowed boolean, "position" integer, cap integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used integer;
  v_cap integer;
begin
  update access_counter
  set used = used + 1
  where id = 1 and used < access_counter.cap
  returning used, access_counter.cap into v_used, v_cap;

  if v_used is not null then
    return query select true, v_used, v_cap;
  else
    select access_counter.used, access_counter.cap into v_used, v_cap
    from access_counter where id = 1;
    return query select false, v_used, v_cap;
  end if;
end;
$$;

-- El cliente (navegador) solo puede llamar a la funcion, nunca leer/escribir
-- la tabla directamente.
revoke all on function claim_free_slot() from public;
grant execute on function claim_free_slot() to anon;

alter table access_counter enable row level security;
-- Sin policies de select/insert/update para "anon": la tabla queda cerrada
-- a acceso directo; solo la funcion SECURITY DEFINER puede tocarla.
