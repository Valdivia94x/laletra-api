/**
 * La API: recibe un vector de consulta, devuelve artículos ordenados.
 *
 * Aquí NO corre el modelo, y no es una renuncia: es la misma decisión que toma
 * laletra, donde el navegador vectoriza lo que el visitante escribe y su
 * pregunta nunca sale de su máquina. Esta función hereda esa frontera.
 *
 * También hubo una razón forzosa, que vale documentar porque costó descubrirla.
 * Vectorizar dentro de Lambda no se pudo:
 *
 *   · El bundle de Node de transformers.js importa `onnxruntime-node` de forma
 *     dura. Ese binario arranca detectando CPUs en /sys/devices/system/cpu/,
 *     árbol que el sandbox de Lambda no expone: cpuinfo falla, se lanza una
 *     excepción antes de registrar el logger y el runtime aborta en ~1.2 s.
 *     Pedir `device: "wasm"` llega tarde: el binding se carga al importar.
 *
 *   · El bundle web trae runtime WebAssembly y no toca /sys, pero lee los pesos
 *     por `fetch`: `localModelPath` es una URL, no un directorio. En Lambda el
 *     modelo está en disco, así que tampoco.
 *
 * Lo que queda del lado del servidor es lo interesante de todos modos: el
 * ranking híbrido —vectorial más palabras, fusionados con RRF— resuelto dentro
 * de Postgres.
 */
import postgres from "postgres";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

// Puerto 6543 (pooler en modo transacción de Supabase), no 5432: Lambda abre y
// cierra contenedores sin avisar y una conexión directa por invocación agota
// Postgres.
const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

const DIMENSIONES = 384;

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

  let cuerpo: { vector?: number[]; pregunta?: string; n?: number } = {};
  try {
    cuerpo = evento.body ? JSON.parse(evento.body) : {};
  } catch {
    return responder(400, { error: "Cuerpo no es JSON válido" });
  }
  // El evento crudo también sirve, para poder invocar sin pasar por la URL.
  const crudo = evento as unknown as { vector?: number[]; pregunta?: string; n?: number };
  const vector = cuerpo.vector ?? crudo.vector;
  const pregunta = (cuerpo.pregunta ?? crudo.pregunta ?? "").trim();
  const cuantos = Math.min(Number(cuerpo.n ?? crudo.n ?? 5) || 5, 20);

  if (!Array.isArray(vector)) {
    return responder(400, {
      error: "Falta `vector`: un arreglo de 384 números.",
      // Explicar el porqué evita que el siguiente lo tome por capricho.
      nota: "El embedding se calcula en el cliente con multilingual-e5-small y el prefijo «query: ». Así la pregunta no viaja al servidor.",
    });
  }
  if (vector.length !== DIMENSIONES) {
    return responder(400, { error: `El vector debe tener ${DIMENSIONES} dimensiones, llegaron ${vector.length}` });
  }

  // `pregunta` es opcional: sin ella el lado de palabras no vota y la búsqueda
  // queda puramente semántica. Es el mismo camino que sigue una consulta de un
  // solo término, así que no hay una segunda ruta que pueda divergir.
  const filas = await sql<Fila[]>`
    select * from buscar_hibrido_con_texto(${`[${vector.join(",")}]`}::vector, ${pregunta}, ${cuantos})
  `;

  return responder(200, {
    pregunta: pregunta || null,
    modo: pregunta ? "hibrido" : "semantico",
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
