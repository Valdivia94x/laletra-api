-- El lado de palabras, alineado con el original.
--
-- Primera versión de este archivo usaba `plainto_tsquery`, que une los lexemas
-- con AND: «me corrieron del trabajo sin avisarme, ¿qué me deben?» exigía un
-- trozo con `corr` Y `trabaj` Y `avis` Y `deb` a la vez. Nunca ocurría, así que
-- las palabras no votaban nunca y el «híbrido» era solo semántica con otro
-- nombre — el harness lo delató: híbrido y significado daban 19/26 idéntico.
--
-- Tres correcciones para que mida lo mismo que `buscarPorPalabras` en laletra:
--
--   1. OR entre lexemas, no AND. Cualquier término cuenta y el ranking pondera.
--   2. Suelo de cobertura al 50%. Ni AND estricto ni OR libre: si el artículo no
--      cubre la mitad de los términos, no entra. Una lista floja no es
--      inofensiva, porque en la fusión vota y hunde al resultado semántico bueno.
--   3. Vacías propias. El diccionario 'spanish' de Postgres quita artículos y
--      preposiciones, pero deja los verbos con los que se PREGUNTA — «tener»,
--      «puede», «dice», «necesita» — y «tener» aparece en media Constitución.
--
-- Además se puntúa sobre el ARTÍCULO completo y no por trozo, como el original:
-- la frecuencia de un término es una propiedad del artículo, no del párrafo que
-- le tocó en el troceo.

create table if not exists articulos (
  numero   int primary key,
  texto    text not null,
  palabras tsvector generated always as (to_tsvector('spanish', texto)) stored
);
create index if not exists articulos_palabras_idx on articulos using gin (palabras);
alter table articulos enable row level security;

-- Las vacías del original, guardadas ya lematizadas para poder compararlas
-- contra los lexemas que produce to_tsvector.
create table if not exists vacias (palabra text primary key, lexema text);
alter table vacias enable row level security;

insert into vacias (palabra) values
  ('el'),
  ('la'),
  ('los'),
  ('las'),
  ('un'),
  ('una'),
  ('unos'),
  ('unas'),
  ('de'),
  ('del'),
  ('al'),
  ('a'),
  ('ante'),
  ('bajo'),
  ('con'),
  ('contra'),
  ('en'),
  ('entre'),
  ('hacia'),
  ('hasta'),
  ('para'),
  ('por'),
  ('segun'),
  ('sin'),
  ('sobre'),
  ('tras'),
  ('y'),
  ('o'),
  ('u'),
  ('e'),
  ('ni'),
  ('que'),
  ('se'),
  ('su'),
  ('sus'),
  ('le'),
  ('les'),
  ('lo'),
  ('mi'),
  ('mis'),
  ('tu'),
  ('tus'),
  ('es'),
  ('son'),
  ('fue'),
  ('ser'),
  ('esta'),
  ('este'),
  ('estos'),
  ('estas'),
  ('eso'),
  ('esa'),
  ('esos'),
  ('esas'),
  ('hay'),
  ('si'),
  ('no'),
  ('me'),
  ('te'),
  ('nos'),
  ('cual'),
  ('cuales'),
  ('quien'),
  ('quienes'),
  ('cuanto'),
  ('cuantos'),
  ('cuanta'),
  ('cuantas'),
  ('como'),
  ('cuando'),
  ('donde'),
  ('porque'),
  ('puede'),
  ('pueden'),
  ('puedo'),
  ('pueda'),
  ('tener'),
  ('tengo'),
  ('tiene'),
  ('tienen'),
  ('dice'),
  ('dicen'),
  ('decir'),
  ('hace'),
  ('hacen'),
  ('hacer'),
  ('quiero'),
  ('quiere'),
  ('debo'),
  ('debe'),
  ('deben'),
  ('ser'),
  ('estar'),
  ('existe'),
  ('hay'),
  ('necesita'),
  ('necesito'),
  ('toca'),
  ('tocan'),
  ('pasa'),
  ('obligado'),
  ('obligada'),
  ('legal'),
  ('ley')
on conflict (palabra) do nothing;

-- Lematizar con el mismo diccionario que se usará al consultar.
update vacias
set lexema = coalesce((tsvector_to_array(to_tsvector('spanish', palabra)))[1], palabra)
where lexema is null;

create index if not exists vacias_lexema_idx on vacias (lexema);

-- Configuración de texto SIN stemmer, para replicar normalizar() del original.
-- 'spanish' reduce a la raíz y «salud» acabaría alcanzando «salubridad»; aquí
-- se quiere coincidencia de palabra completa, sin acentos. Medido: el híbrido
-- pasa de 17/26 a 18/26 al quitar el stemming.
create extension if not exists unaccent;
drop text search configuration if exists es_simple cascade;
create text search configuration es_simple (copy = simple);
alter text search configuration es_simple
  alter mapping for asciiword, word, hword, hword_part, numword
  with unaccent, simple;

alter table articulos drop column if exists palabras_ns;
alter table articulos add column palabras_ns tsvector
  generated always as (to_tsvector('es_simple', texto)) stored;
create index if not exists articulos_palabras_ns_idx on articulos using gin (palabras_ns);
