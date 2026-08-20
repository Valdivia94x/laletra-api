-- Esquema del índice: un trozo por fila, con sus dos representaciones.
--
-- La decisión de fondo: en laletra el índice vive en dos archivos (vectores.bin
-- e indice.json) que el navegador descarga enteros. Eso funciona con 136
-- artículos y no escala a nada más grande. Aquí el mismo índice vive en
-- Postgres, que ya sabe hacer las dos búsquedas que necesitamos —vectorial y
-- por palabras— y puede fusionarlas sin traerse el corpus completo a ningún
-- lado.

create extension if not exists vector;

create table if not exists trozos (
  id          bigserial primary key,
  articulo    int  not null,
  desde       int  not null,
  hasta       int  not null,
  texto       text not null,
  -- 384 dimensiones: multilingual-e5-small, el mismo modelo que corre en el
  -- navegador de laletra. Guardado en float32 y no cuantizado a int8 como allá,
  -- porque aquí no hay que descargar nada por la red: el costo de los 8 bits
  -- extra lo paga el disco del servidor, no el visitante.
  vector      vector(384) not null,
  -- El lado de palabras. Se calcula una vez al insertar, no en cada consulta.
  palabras    tsvector generated always as (to_tsvector('spanish', texto)) stored,
  unique (articulo, desde, hasta)
);

-- Un artículo largo tiene muchos trozos y el ranking agrega por artículo, así
-- que este índice se usa en cada consulta.
create index if not exists trozos_articulo_idx on trozos (articulo);

-- HNSW y no IVFFlat: el corpus es chico y estático, HNSW da mejor recall sin
-- necesidad de elegir un número de listas ni de re-entrenar al insertar.
-- vector_cosine_ops porque los vectores de e5 se comparan por coseno.
create index if not exists trozos_vector_idx
  on trozos using hnsw (vector vector_cosine_ops);

create index if not exists trozos_palabras_idx
  on trozos using gin (palabras);

-- Metadatos del índice, para que la API pueda decir contra qué versión responde.
create table if not exists indice_meta (
  id                  int primary key default 1,
  modelo              text not null,
  dimensiones         int  not null,
  ultima_reforma_dof  text not null,
  trozos_totales      int  not null,
  actualizado         timestamptz not null default now(),
  check (id = 1)
);

-- RLS activo y sin políticas: negar por defecto.
--
-- La Lambda no se ve afectada porque entra por una conexión Postgres directa
-- con el rol de servicio, que trae BYPASSRLS. Lo que esto cierra es la otra
-- puerta: Supabase publica todo el schema `public` por PostgREST, y sin RLS
-- bastaría la anon key —que normalmente viaja en un frontend— para leer las
-- tablas enteras.
--
-- El corpus es la Constitución, o sea información pública, así que aquí no hay
-- nada que proteger. Se activa igual porque el criterio no debería depender de
-- qué tan sensible parezca el dato del momento: si mañana este esquema se copia
-- para un corpus que sí importa, el default correcto ya está puesto.
alter table trozos      enable row level security;
alter table indice_meta enable row level security;
