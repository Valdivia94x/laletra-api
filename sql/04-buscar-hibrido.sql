-- buscar_hibrido, versión final. Dos diferencias medidas contra el navegador:
--
--   · COSENO en vez de producto punto. clasificar() suma q·v y divide entre 127;
--     pgvector con <=> divide además entre la norma de v. Los vectores salen
--     normalizados del modelo, pero la cuantización a int8 les mueve la norma, y
--     el coseno corrige ese sesgo. Medido: 19/26 contra 18/26.
--
--   · PALABRAS SIN LEMATIZAR. to_tsvector('spanish') reduce a la raíz, así que
--     «salud» alcanza «salubridad» y «saludable»; normalizar() compara palabras
--     completas sin acentos. El stemming es más permisivo, mete artículos de
--     relleno y esos votan en la fusión. La configuración es_simple (unaccent +
--     simple, sin stemmer) replica el criterio original. Medido: 18/26 contra
--     17/26 en el híbrido.
--
-- Lo que cambia respecto a la v1 está explicado en 03-palabras.sql. En resumen:
-- antes las palabras casi nunca votaban (AND entre lexemas), así que el híbrido
-- era semántica disfrazada. Aquí votan con el mismo criterio que en laletra.

create or replace function buscar_hibrido(
  consulta_vector vector(384),
  consulta_texto  text default '',
  cuantos         int  default 5,
  k               int  default 60
)
returns table (
  articulo int,
  afinidad real,
  desde    int,
  hasta    int,
  rrf      real,
  via      text
)
language plpgsql
stable
as $$
declare
  terminos   text[];
  n_terminos int;
  tsq        tsquery;
begin
  -- Lexemas con contenido: fuera las vacías del original y los muy cortos.
  select array_agg(distinct lex)
  into terminos
  from unnest(tsvector_to_array(to_tsvector('es_simple', coalesce(consulta_texto, '')))) as lex
  where length(lex) > 2
    and lex not in (select v.palabra from vacias v);

  n_terminos := coalesce(array_length(terminos, 1), 0);

  -- 'simple' y no 'spanish': los lexemas ya vienen lematizados y volver a
  -- pasarlos por el diccionario los deformaría.
  if n_terminos >= 2 then
    tsq := to_tsquery('simple', array_to_string(terminos, ' | '));
  end if;

  return query
  with
  candidatos as (
    select t.articulo, t.desde, t.hasta,
           (1 - (t.vector <=> consulta_vector))::real as afinidad
    from trozos t
    order by t.vector <=> consulta_vector
    limit 60
  ),
  semantico as (
    select distinct on (c.articulo) c.articulo, c.desde, c.hasta, c.afinidad
    from candidatos c
    order by c.articulo, c.afinidad desc
  ),
  semantico_rank as (
    select s.*, row_number() over (order by s.afinidad desc) as pos
    from semantico s
    order by s.afinidad desc
    limit 20
  ),
  -- Cobertura: cuántos términos distintos aparecen en el artículo.
  cobertura as (
    select a.numero as articulo,
           count(*) filter (where a.palabras_ns @@ to_tsquery('simple', t.lex)) as cubiertos
    from articulos a
    cross join unnest(coalesce(terminos, '{}')) as t(lex)
    group by a.numero
  ),
  palabras_rank as (
    select p.articulo, row_number() over (order by p.puntos desc) as pos
    from (
      select c.articulo,
             -- ts_rank ya amortigua la frecuencia; el factor de cobertura
             -- reproduce el bono del original: tres términos una vez valen más
             -- que un término treinta veces.
             (ts_rank(a.palabras_ns, tsq) * (c.cubiertos::real / n_terminos)) as puntos
      from cobertura c
      join articulos a on a.numero = c.articulo
      where n_terminos >= 2
        and c.cubiertos > 0
        -- El suelo del 50%: una lista floja vota y hunde al semántico bueno.
        and (c.cubiertos::real / n_terminos) >= 0.5
      order by puntos desc
      limit 20
    ) p
  ),
  fusion as (
    select
      coalesce(s.articulo, p.articulo)                          as articulo,
      coalesce(s.afinidad, 0::real)                             as afinidad,
      coalesce(s.desde, 0)                                      as desde,
      coalesce(s.hasta, 0)                                      as hasta,
      (coalesce(1.0 / (k + s.pos), 0)
       + coalesce(1.0 / (k + p.pos), 0))::real                  as rrf,
      case
        when s.articulo is not null and p.articulo is not null then 'ambos'
        when s.articulo is not null then 'semantico'
        else 'palabras'
      end                                                       as via
    from semantico_rank s
    full outer join palabras_rank p on p.articulo = s.articulo
  )
  select f.articulo, f.afinidad, f.desde, f.hasta, f.rrf, f.via
  from fusion f
  order by f.rrf desc, f.afinidad desc
  limit cuantos;
end;
$$;
