# laletra-api

La búsqueda de [laletra](https://github.com/Valdivia94x/laletra) movida a un servidor:
**pgvector en Postgres** para el índice, **AWS Lambda** para la API, y el híbrido completo
—vectorial + palabras, fusionados con RRF— resuelto dentro de una función SQL.

No sustituye a laletra. Aquel proyecto corre el modelo en el navegador y su gracia es que la
consulta nunca sale de tu máquina; este renuncia a eso a cambio de que el corpus no tenga que
caber en la memoria del cliente. Son dos respuestas distintas a la misma pregunta, y tenerlas
lado a lado es justamente lo interesante.

## Por qué existe

En laletra el índice son dos archivos que el navegador descarga enteros: 201 KB de vectores y
22 KB de desplazamientos. Con 136 artículos funciona. Con un corpus diez veces mayor, no: el
visitante no va a bajar 2 MB antes de escribir su primera pregunta, y menos si el modelo ya le
costó 112 MB.

La salida obvia es un servidor. La menos obvia es **cuánto de la búsqueda puede vivir en la base
de datos**, y la respuesta resultó ser: toda.

## El híbrido, en SQL

Postgres tiene las dos mitades que hacían falta. `pgvector` da la búsqueda por significado con
un índice HNSW; `tsvector` da la de palabras con GIN. Faltaba fusionarlas, y eso son treinta
líneas de `plpgsql`.

Se conservaron las tres decisiones que en laletra hacen que el híbrido gane:

**RRF sobre rangos, no sobre puntuaciones.** Mezclar un coseno con un `ts_rank` obliga a
normalizar, y cada normalización es un parámetro que ajustar contra 26 preguntas. RRF suma
`1/(k + posición)` con k=60, el valor de la literatura, y no se toca.

**Agregación por artículo con máximo, no promedio.** Un artículo responde si *uno* de sus
párrafos responde. Promediar castigaría al 123 por ser largo, que es el artículo que más
preguntas contesta.

**Con menos de dos términos con contenido, las palabras no votan.** «¿qué se necesita para ser
presidente?» se reduce a «presidente», y el artículo 89 la repite más veces que el 82, que es el
que de verdad contesta.

## Lo que se verificó, y lo que salió distinto

Portar un buscador es fácil; portarlo sin degradarlo es lo que hay que demostrar. `pnpm evaluar`
corre las mismas 26 preguntas de laletra contra Postgres. El resultado no fue el empate que
esperaba:

| método | navegador (laletra) | Postgres (este repo) |
|---|---|---|
| solo significado | 17/26 top-1 | **19/26** top-1 |
| híbrido | **19/26** top-1 · 23/26 top-5 | 18/26 top-1 · **24/26** top-5 |

Se invirtieron. Encontrar por qué tomó tres experimentos, y las dos causas son interesantes:

**El semántico mejoró por usar coseno.** `clasificar()` suma el producto punto y divide entre
127; pgvector con `<=>` divide además entre la norma del vector. Los vectores salen normalizados
del modelo, pero **la cuantización a int8 les mueve la norma**, y el producto punto crudo premia
a los que quedaron con norma mayor. El coseno corrige ese sesgo. Medido en aislamiento: 19/26
contra 18/26.

**El híbrido empeoró por el stemming.** `to_tsvector('spanish')` reduce a la raíz, así que
«salud» alcanza «salubridad» y «saludable». `normalizar()` compara palabras completas sin
acentos. El stemmer es más permisivo, mete artículos de relleno, y esos votan en la fusión y
hunden al resultado semántico bueno. Con una configuración `es_simple` (unaccent + simple, sin
stemmer) el híbrido sube de 17/26 a 18/26.

**Y queda un hallazgo que no es un bug.** Con el semántico en 19, la fusión ya no paga en top-1:
arregla `expropiacion` y `guerra`, pero rompe `armas`, `agua` y `extranjeros`. El híbrido de
laletra existía para compensar un semántico débil; al quitarle el sesgo de la cuantización, la
mitad de palabras dejó de aportar. Sigue ganando en top-5 (24 contra 23), que es lo que ve quien
consulta, así que se queda como opción por defecto — pero documentado, no asumido.

Es el tipo de cosa que solo aparece si mides. El buscador *funcionaba* en las tres versiones
intermedias: devolvía buenos resultados y nadie habría notado a mano que media arquitectura
estaba muerta. La primera versión de este repo usaba `plainto_tsquery`, que une los lexemas con
AND y exigía que un artículo contuviera todos los términos a la vez: el «híbrido» era semántica
disfrazada, y el harness lo delató porque las dos columnas daban exactamente el mismo número.

El evaluador sale con código 1 si cualquiera de las tres métricas cae por debajo de lo medido.
No carga el modelo: las 26 preguntas se vectorizan una vez con `pnpm vectorizar-preguntas` y se
guardan en JSON. Además de correr en segundos y no necesitar 112 MB en CI, eso esquiva que
`onnxruntime-node` reviente al liberar sus hilos y convierta un ✓ en un exit 134.

## Decisiones de infraestructura

**Los vectores se copian, no se recalculan.** La ingesta lee el `vectores.bin` que laletra ya
publicó y lo des-cuantiza (int8 ÷ 127). Así los vectores del servidor y los del navegador son
bit a bit los mismos: si las dos versiones difieren, la culpa está en el ranking, nunca en el
modelo.

**HNSW y no IVFFlat.** El corpus es chico y estático; HNSW da mejor recall sin elegir número de
listas ni re-entrenar al insertar.

**Imagen de contenedor y no zip.** El modelo pesa ~112 MB y el límite de un zip descomprimido en
Lambda es 250 MB. Con contenedor hay 10 GB y, sobre todo, el modelo queda horneado en la imagen
en vez de descargarse durante la petición del primer usuario tras cada despliegue.

**El pipeline y el pool viven fuera del handler.** Lambda reutiliza contenedores: un arranque en
frío carga el modelo una vez y las siguientes peticiones responden en decenas de milisegundos.

**Puerto 6543, no 5432.** El pooler en modo transacción de Supabase. Lambda abre y cierra
contenedores sin avisar, y una conexión directa por invocación agota Postgres.

## Poner a andar

```bash
cp .env.example .env        # DATABASE_URL de Supabase + ruta a laletra

# 1. Esquema y función de búsqueda
psql "$DATABASE_URL" -f sql/01-esquema.sql
psql "$DATABASE_URL" -f sql/03-palabras.sql
psql "$DATABASE_URL" -f sql/04-buscar-hibrido.sql

# 2. Subir el índice que laletra ya generó
cd ingesta && pnpm install && pnpm ingestar

# 3. Comprobar que no se degradó
pnpm vectorizar-preguntas   # una vez: deja las 26 preguntas en JSON
pnpm evaluar                # no carga el modelo; corre en segundos

# 4. Construir y desplegar la Lambda
cd ../lambda
docker build --platform linux/amd64 -t laletra-api .
# etiquetar y empujar a ECR, luego crear la función desde esa imagen
```

La función espera `DATABASE_URL` en variables de entorno, 1024 MB de memoria y 30 s de timeout
(el arranque en frío carga el modelo).

```
GET /?q=¿pueden entrar a mi casa sin una orden?&n=5
```

```json
{
  "pregunta": "¿pueden entrar a mi casa sin una orden?",
  "resultados": [
    { "articulo": 16, "afinidad": 0.87, "rrf": 0.032787, "via": "ambos", "fragmento": "…" }
  ],
  "ms": 42
}
```

## Lo que no hace

No genera texto. Igual que laletra, esto recupera artículos y muestra el fragmento que responde;
no resume, no interpreta y no da consejo legal. Un LLM encima sería el paso siguiente, y también
la forma más rápida de que el proyecto empiece a inventar artículos que no existen.
