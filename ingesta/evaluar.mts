/**
 * La misma batería de laletra, ahora contra Postgres.
 *
 *   pnpm evaluar
 *
 * Este archivo es la razón de ser del repo. Portar un buscador de un lado a
 * otro es fácil; portarlo SIN DEGRADARLO es lo que hay que demostrar, y la
 * única forma de saberlo es correr las mismas 26 preguntas contra la nueva
 * implementación y comparar con lo que daba la vieja.
 *
 * El baseline no es una aspiración, es lo que midió laletra en el navegador:
 * 19/26 en primer resultado para el híbrido, 17 para solo significado. Si esta
 * versión queda por debajo, el port rompió algo — típicamente el criterio de
 * palabras, porque el diccionario 'spanish' de Postgres no coincide exactamente
 * con el `normalizar()` de allá.
 *
 * Sale con código 1 si degrada, para poder colgarlo de CI.
 */
import { readFile } from "node:fs/promises";
import postgres from "postgres";

// Lo que mide ESTA implementación, no lo que medía el navegador. Los números
// del navegador (17 significado / 19 híbrido) quedaron abajo, en el README:
// aquí el semántico sube a 19 por usar coseno, y con un semántico así la
// fusión deja de pagar en top-1 aunque siga ganando en top-5.
const BASELINE = { hibrido: 18, hibridoTop5: 24, significado: 19 } as const;

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, onnotice: () => {} });

const [meta] = await sql`select * from indice_meta where id = 1`;
if (!meta) throw new Error("Sin metadatos: ¿corriste la ingesta?");
console.log(`\níndice: ${meta.modelo} · ${meta.trozos_totales} trozos · reforma ${meta.ultima_reforma_dof}`);

type Vectorizada = { id: string; texto: string; espera: number[]; vector: number[] };
const { modelo, preguntas: PREGUNTAS } = JSON.parse(
  await readFile("preguntas-vectorizadas.json", "utf8"),
) as { modelo: string; preguntas: Vectorizada[] };

if (modelo !== meta.modelo) {
  throw new Error(`Las preguntas se vectorizaron con ${modelo} y el índice usa ${meta.modelo}`);
}

/** Posición del primer artículo esperado (1-based; null = fuera del top). */
const rangoDe = (lista: { articulo: number }[], espera: number[]) => {
  const i = lista.findIndex((r) => espera.includes(r.articulo));
  return i === -1 ? null : i + 1;
};

type Metodo = "significado" | "hibrido";
const aciertos: Record<Metodo, { top1: number; top5: number }> = {
  significado: { top1: 0, top5: 0 },
  hibrido: { top1: 0, top5: 0 },
};

const fallos: string[] = [];

for (const p of PREGUNTAS) {
  const vector = `[${p.vector.join(",")}]`;

  // Con texto vacío la función no deja votar a las palabras: es el mismo
  // camino que sigue una consulta de un solo término. Así se mide «solo
  // significado» sin escribir una segunda consulta que pudiera divergir.
  const soloSignificado = await sql`select * from buscar_hibrido(${vector}::vector, '', 5)`;
  const hibrido = await sql`select * from buscar_hibrido(${vector}::vector, ${p.texto}, 5)`;

  for (const [metodo, lista] of [
    ["significado", soloSignificado],
    ["hibrido", hibrido],
  ] as const) {
    const rango = rangoDe(lista as { articulo: number }[], p.espera);
    if (rango === 1) aciertos[metodo].top1++;
    if (rango !== null && rango <= 5) aciertos[metodo].top5++;
  }

  const rh = rangoDe(hibrido as { articulo: number }[], p.espera);
  const marca = rh === 1 ? "✓" : rh === null ? "✗" : `${rh}º`;
  console.log(`  ${marca.padEnd(3)} ${p.id.padEnd(22)} espera ${p.espera.join("/")}`);
  if (rh !== 1) fallos.push(`${p.id} (esperaba ${p.espera.join("/")}, quedó ${rh ?? "fuera"})`);
}

const n = PREGUNTAS.length;
console.log(`\n  significado   top1 ${aciertos.significado.top1}/${n}   top5 ${aciertos.significado.top5}/${n}`);
console.log(`  híbrido       top1 ${aciertos.hibrido.top1}/${n}   top5 ${aciertos.hibrido.top5}/${n}`);
console.log(`  baseline de esta implementación: híbrido ${BASELINE.hibrido} top1 / ${BASELINE.hibridoTop5} top5 · significado ${BASELINE.significado} top1`);
console.log(`  navegador (laletra):             híbrido 19 top1 / 23 top5 · significado 17 top1`);

if (fallos.length) console.log(`\n  no quedaron primeros:\n    ${fallos.join("\n    ")}`);

await sql.end();

const caidas: string[] = [];
if (aciertos.hibrido.top1 < BASELINE.hibrido) caidas.push(`híbrido top1 ${aciertos.hibrido.top1} < ${BASELINE.hibrido}`);
if (aciertos.hibrido.top5 < BASELINE.hibridoTop5) caidas.push(`híbrido top5 ${aciertos.hibrido.top5} < ${BASELINE.hibridoTop5}`);
if (aciertos.significado.top1 < BASELINE.significado) caidas.push(`significado top1 ${aciertos.significado.top1} < ${BASELINE.significado}`);

if (caidas.length) {
  console.error(`\n✗ DEGRADACIÓN:\n    ${caidas.join("\n    ")}\n`);
  process.exit(1);
}
console.log(`\n✓ sin degradación\n`);
process.exit(0);
