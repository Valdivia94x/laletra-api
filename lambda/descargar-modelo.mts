/**
 * Baja el modelo en tiempo de BUILD, no en el primer arranque en frío.
 *
 * Transformers.js lo descargaría solo la primera vez que se invoca, pero en
 * Lambda eso significa que el primer usuario después de cada despliegue paga
 * ~112 MB de descarga dentro de su petición, y que el sistema de archivos es
 * de solo lectura salvo /tmp. Hornearlo en la imagen convierte un problema de
 * runtime en uno de build.
 */
import { pipeline, env } from "@huggingface/transformers";

env.cacheDir = "./modelo";
const extraer = await pipeline("feature-extraction", "Xenova/multilingual-e5-small", {
  dtype: "q8",
});
const prueba = await extraer("query: prueba", { pooling: "mean", normalize: true });
console.log(`✓ modelo en ./modelo · dimensiones: ${(prueba.data as Float32Array).length}`);
