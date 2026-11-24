-- buscar_hibrido_con_texto: la función que llama la Lambda.
--
-- Envuelve a buscar_hibrido (04) sin tocar el ranking: toma sus resultados en
-- el mismo orden y a cada artículo le agrega el fragmento de texto que se
-- muestra en la respuesta.
--
-- Se creó a mano en la base de Supabase y nunca se guardó en el repo, así que
-- seguir "Poner a andar" dejaba a la Lambda llamando a una función que no
-- existía. Esta definición se recuperó de la base con pg_get_functiondef el
-- 24 nov 2026, tal cual estaba.

CREATE OR REPLACE FUNCTION public.buscar_hibrido_con_texto(consulta_vector vector, consulta_texto text DEFAULT ''::text, cuantos integer DEFAULT 5)
 RETURNS TABLE(articulo integer, afinidad real, fragmento text, rrf real, via text)
 LANGUAGE sql
 STABLE
AS $function$
  select
    b.articulo,
    b.afinidad,
    case
      when b.hasta > b.desde then substring(t.texto from b.desde + 1 for b.hasta - b.desde)
      else left(t.texto, 400)
    end as fragmento,
    b.rrf,
    b.via
  from buscar_hibrido(consulta_vector, consulta_texto, cuantos) b
  join lateral (
    select t2.texto from trozos t2 where t2.articulo = b.articulo order by t2.desde limit 1
  ) t on true
  order by b.rrf desc;
$function$;
