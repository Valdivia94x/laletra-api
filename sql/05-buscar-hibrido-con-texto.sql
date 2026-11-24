-- buscar_hibrido_con_texto: la función que llama la Lambda.
--
-- Envuelve a buscar_hibrido (04) sin tocar el ranking: toma sus resultados en
-- el mismo orden y a cada artículo le agrega el fragmento de texto que se
-- muestra en la respuesta.
--
-- Se creó a mano en la base de Supabase y nunca se guardó en el repo, así que
-- seguir "Poner a andar" dejaba a la Lambda llamando a una función que no
-- existía. Se recuperó de la base con pg_get_functiondef el 24 nov 2026.
--
-- El fragmento es el trozo exacto que ganó en el lado semántico. buscar_hibrido
-- ya devuelve su `desde` y `hasta`, y (articulo, desde, hasta) es único en
-- `trozos`. La primera versión tomaba el PRIMER trozo del artículo y lo cortaba
-- con las posiciones del mejor; como cada fila de `trozos` guarda solo el texto
-- de su trozo, el corte caía fuera y el fragmento salía vacío siempre que el
-- mejor no fuera el primero.

CREATE OR REPLACE FUNCTION public.buscar_hibrido_con_texto(consulta_vector vector, consulta_texto text DEFAULT ''::text, cuantos integer DEFAULT 5)
 RETURNS TABLE(articulo integer, afinidad real, fragmento text, rrf real, via text)
 LANGUAGE sql
 STABLE
AS $function$
  select
    b.articulo,
    b.afinidad,
    coalesce(
      -- El trozo exacto que coincidió.
      (select t.texto from trozos t
        where t.articulo = b.articulo and t.desde = b.desde and t.hasta = b.hasta),
      -- Si llegó solo por palabras no hay trozo: los primeros 400 caracteres.
      (select left(t.texto, 400) from trozos t
        where t.articulo = b.articulo order by t.desde limit 1)
    ) as fragmento,
    b.rrf,
    b.via
  from buscar_hibrido(consulta_vector, consulta_texto, cuantos) b
  order by b.rrf desc;
$function$;
