/**
 * Sube el índice de laletra a Postgres con pgvector.
 *
 *   pnpm ingestar
 *
 * No re-vectoriza nada: lee el índice que laletra ya generó y publicó. Eso
 * mantiene una propiedad que importa — los vectores de la API y los del
 * navegador son BIT A BIT los mismos, así que si las dos dan resultados
 * distintos, la culpa está en la fusión o en el ranking, nunca en el modelo.
 *
 * Sobre la cuantización: laletra guarda int8 (v × 127) para que el navegador
 * descargue 201 KB en vez de 800 KB. Aquí se des-cuantiza dividiendo entre 127
 * y se almacena float32. La pérdida ya ocurrió al cuantizar y no se recupera,
 * pero tampoco se agrega: es exactamente la precisión con la que hoy responde
 * el sitio en producción. Re-vectorizar en float32 puro daría algo ligeramente
 * mejor, a cambio de descargar el modelo de 112 MB y de que los dos índices
 * dejaran de ser comparables.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";

// Relativa a la RAÍZ del repo, no al cwd: da igual desde dónde se invoque.
const RAIZ = join(import.meta.dirname, "..");
const LALETRA = process.env.LALETRA ?? "../laletra";
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Falta DATABASE_URL");

type Trozo = { articulo: number; desde: number; hasta: number };
type Indice = {
  modelo: string;
  dimensiones: number;
  escala: number;
  ultimaReformaDOF: string;
  trozos: Trozo[];
};
type Corpus = { articulos: { numero: number; texto: string }[] };

const dir = join(RAIZ, LALETRA, "public/indice");
const indice: Indice = JSON.parse(await readFile(join(dir, "indice.json"), "utf8"));
const corpus: Corpus = JSON.parse(await readFile(join(dir, "constitucion.json"), "utf8"));
const crudos = new Int8Array((await readFile(join(dir, "vectores.bin"))).buffer);

const { dimensiones, escala, trozos } = indice;
const esperados = trozos.length * dimensiones;
if (crudos.length !== esperados) {
  throw new Error(`vectores.bin tiene ${crudos.length} bytes y el índice espera ${esperados}`);
}

const textoDe = new Map(corpus.articulos.map((a) => [a.numero, a.texto]));

const sql = postgres(DATABASE_URL, { prepare: false });

console.log(`Ingestando ${trozos.length} trozos de ${dimensiones} dimensiones…`);

await sql`truncate trozos restart identity`;

const LOTE = 100;
for (let i = 0; i < trozos.length; i += LOTE) {
  const filas = trozos.slice(i, i + LOTE).map((t, j) => {
    const idx = i + j;
    const base = idx * dimensiones;
    const vector = Array.from(
      { length: dimensiones },
      (_, d) => crudos[base + d] / escala,
    );
    const completo = textoDe.get(t.articulo);
    if (completo === undefined) throw new Error(`Sin texto para el artículo ${t.articulo}`);
    return {
      articulo: t.articulo,
      desde: t.desde,
      hasta: t.hasta,
      // El trozo, no el artículo entero: es lo que se vectorizó y es lo que el
      // lado de palabras debe indexar para que las dos mitades midan lo mismo.
      texto: completo.slice(t.desde, t.hasta),
      vector: `[${vector.join(",")}]`,
    };
  });
  await sql`insert into trozos ${sql(filas, "articulo", "desde", "hasta", "texto", "vector")}`;
  process.stdout.write(`\r  ${Math.min(i + LOTE, trozos.length)}/${trozos.length}`);
}

// El artículo completo, para el lado de palabras: la frecuencia de un término
// es propiedad del artículo, no del párrafo que le tocó en el troceo.
await sql`truncate articulos`;
await sql`insert into articulos ${sql(
  corpus.articulos.map((a) => ({ numero: a.numero, texto: a.texto })),
  "numero",
  "texto",
)}`;
console.log(`\n  artículos completos: ${corpus.articulos.length}`);

await sql`
  insert into indice_meta (id, modelo, dimensiones, ultima_reforma_dof, trozos_totales, actualizado)
  values (1, ${indice.modelo}, ${dimensiones}, ${indice.ultimaReformaDOF}, ${trozos.length}, now())
  on conflict (id) do update set
    modelo = excluded.modelo,
    dimensiones = excluded.dimensiones,
    ultima_reforma_dof = excluded.ultima_reforma_dof,
    trozos_totales = excluded.trozos_totales,
    actualizado = excluded.actualizado
`;

const [{ count }] = await sql`select count(*)::int as count from trozos`;
const [{ articulos }] = await sql`select count(distinct articulo)::int as articulos from trozos`;
console.log(`\n✓ ${count} trozos de ${articulos} artículos · reforma ${indice.ultimaReformaDOF}`);

await sql.end();
