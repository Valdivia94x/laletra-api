/**
 * La API: pregunta en texto, artículos ordenados de vuelta.
 *
 * Lo único que hace aquí el modelo es vectorizar la consulta. Todo el ranking
 * —vectorial, por palabras y la fusión— ocurre dentro de Postgres, en
 * buscar_hibrido(). Esa frontera es deliberada: si mañana se cambia el modelo,
 * cambia este archivo; si se cambia el criterio de ranking, cambia el SQL. No
 * hay lógica de búsqueda repartida entre los dos.
 *
 * El pipeline y el pool viven FUERA del handler a propósito. Lambda reutiliza
 * el contenedor entre invocaciones, así que un arranque en frío carga el modelo
 * una vez (~1.5 s) y las siguientes peticiones responden en decenas de ms.
 * Meterlos dentro del handler significaría pagar esa carga en cada petición.
 */
import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import postgres from "postgres";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

env.cacheDir = process.env.MODELO_DIR ?? "/var/task/modelo";
env.allowRemoteModels = false; // el modelo está horneado; si falta, que truene claro

// Puerto 6543 (transaction pooler de Supabase), no 5432: Lambda abre y cierra
// contenedores sin avisar y una conexión directa por invocación agota Postgres.
const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

let extraer: Promise<FeatureExtractionPipeline> | null = null;
const modelo = () =>
  (extraer ??= pipeline("feature-extraction", "Xenova/multilingual-e5-small", { dtype: "q8" }));

type Fila = {
  articulo: number;
  afinidad: number;
  fragmento: string;
  rrf: number;
  via: "ambos" | "semantico" | "palabras";
};

const responder = (statusCode: number, cuerpo: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(cuerpo),
});

export const handler = async (
  evento: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const inicio = Date.now();

  const pregunta = (
    evento.queryStringParameters?.q ??
    (evento.body ? (JSON.parse(evento.body).pregunta as string) : "")
  )?.trim();

  if (!pregunta) return responder(400, { error: "Falta la pregunta (?q= o {pregunta})" });
  if (pregunta.length > 500) return responder(400, { error: "Pregunta demasiado larga" });

  const cuantos = Math.min(Number(evento.queryStringParameters?.n ?? 5) || 5, 20);

  // El prefijo «query: » no es adorno: e5 se entrenó con él y sin él la calidad
  // baja de forma medible. Los pasajes llevan «passage: » al vectorizarse.
  const salida = await (await modelo())(`query: ${pregunta}`, {
    pooling: "mean",
    normalize: true,
  });
  const vector = `[${Array.from(salida.data as Float32Array).join(",")}]`;

  const filas = await sql<Fila[]>`
    select * from buscar_hibrido_con_texto(${vector}::vector, ${pregunta}, ${cuantos})
  `;

  return responder(200, {
    pregunta,
    resultados: filas.map((f) => ({
      articulo: f.articulo,
      afinidad: Number(f.afinidad.toFixed(4)),
      rrf: Number(f.rrf.toFixed(6)),
      via: f.via,
      fragmento: f.fragmento,
    })),
    ms: Date.now() - inicio,
  });
};
