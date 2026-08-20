/**
 * Vectoriza la batería una sola vez y la deja en JSON.
 *
 *   pnpm vectorizar-preguntas
 *
 * Separar esto del evaluador tiene tres ventajas y ninguna desventaja: el
 * evaluador deja de cargar 112 MB de modelo para 26 preguntas que nunca
 * cambian, puede correr en CI sin descargar nada, y —lo que motivó el cambio—
 * onnxruntime-node revienta con «mutex lock failed» al liberar sus hilos, así
 * que el proceso que mide ya no es el proceso que carga el modelo.
 *
 * Se vuelve a correr solo si cambian las preguntas o el modelo.
 */
import { writeFile } from "node:fs/promises";
import { pipeline } from "@huggingface/transformers";
import { PREGUNTAS } from "../../laletra/content/preguntas.js";

const MODELO = "Xenova/multilingual-e5-small";
const extraer = await pipeline("feature-extraction", MODELO, { dtype: "q8" });

const vectorizadas = [];
for (const p of PREGUNTAS) {
  const s = await extraer(`query: ${p.texto}`, { pooling: "mean", normalize: true });
  vectorizadas.push({ id: p.id, texto: p.texto, espera: p.espera, vector: Array.from(s.data as Float32Array) });
  process.stdout.write(`\r  ${vectorizadas.length}/${PREGUNTAS.length}`);
}

await writeFile("preguntas-vectorizadas.json", JSON.stringify({ modelo: MODELO, preguntas: vectorizadas }));
console.log(`\n✓ ${vectorizadas.length} preguntas vectorizadas con ${MODELO}`);
process.exit(0);
