# laletra-api

La búsqueda de [laletra](https://github.com/Valdivia94x/laletra) movida a un servidor:
**pgvector en Postgres** para el índice, **AWS Lambda** para la API, y el híbrido completo
—vectorial + palabras, fusionados con RRF— resuelto dentro de una función SQL.

En producción: **~36 ms** por consulta en caliente, arranque en frío de ~460 ms, en Lambda arm64
con 512 MB. La función recibe el vector de la consulta y devuelve los artículos ordenados; el
embedding se calcula en el cliente, igual que en laletra.

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

## Por qué el modelo no corre dentro de la Lambda

La primera versión vectorizaba la consulta en el servidor. No se pudo, y las dos razones valen
más que la conclusión:

**El bundle de Node de transformers.js importa `onnxruntime-node` de forma dura.** Ese binario
arranca detectando CPUs en `/sys/devices/system/cpu/possible`, árbol que el sandbox de Lambda no
expone. `cpuinfo` falla, se lanza una `OnnxRuntimeException` antes de que el runtime registre su
propio logger, y el proceso aborta en ~1.2 s sin haber cargado nada. Pedir `device: "wasm"` no
sirve: el binding se carga al importar el módulo, mucho antes de mirar esa opción. Borrar el
paquete tampoco: el import es obligatorio y la resolución revienta.

**El bundle web trae runtime WebAssembly y no toca `/sys`, pero lee los pesos por `fetch`.**
Ahí `localModelPath` es una URL, no un directorio; en Lambda el modelo está en disco, así que
encuentra la ruta y no sabe abrirla.

La salida no fue un consuelo sino la arquitectura de laletra: el cliente vectoriza y su pregunta
no viaja. La imagen bajó de 1.65 GB a decenas de MB, el arranque en frío de más de un segundo
—cuando arrancaba— a ~460 ms, y la función quedó con 512 MB porque con 2 GB rendía exactamente
igual. Lo que corre en el servidor sigue siendo lo interesante: el ranking híbrido dentro de
Postgres.

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

**`--provenance=false --sbom=false` al construir.** Buildx adjunta attestations por defecto y
publica un manifest OCI con varias entradas; Lambda lo rechaza con «image manifest, config or
layer media type not supported». Sin ellas queda un manifest Docker clásico, que sí acepta.

**El pipeline y el pool viven fuera del handler.** Lambda reutiliza contenedores: un arranque en
frío carga el modelo una vez y las siguientes peticiones responden en decenas de milisegundos.

**Puerto 6543, no 5432.** El pooler en modo transacción de Supabase. Lambda abre y cierra
contenedores sin avisar, y una conexión directa por invocación agota Postgres.

**La función vive en us-east-2 y la base en us-east-1.** No es una decisión de diseño sino una
restricción heredada: la cuenta se creó con el onboarding nuevo de AWS, que la mete en una
organización cuya SCP sólo habilita ciertas regiones, y us-east-1 no es una de ellas. Son
regiones vecinas —del orden de 12-15 ms extra por consulta— y el ranking corre entero dentro de
Postgres, así que se paga un viaje por petición y no uno por resultado. Si la cuenta llega a
permitir us-east-1, mover la función es recrearla apuntando a la misma imagen.

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

# 4. Construir y desplegar la Lambda (arm64 / Graviton)
cd ../lambda
CUENTA=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-2   # ver nota abajo

aws ecr create-repository --repository-name laletra-api --region $REGION
aws ecr get-login-password --region $REGION \
  | docker login --username AWS --password-stdin $CUENTA.dkr.ecr.$REGION.amazonaws.com

docker build --platform linux/arm64 --provenance=false --sbom=false -t laletra-api .
docker tag laletra-api:latest $CUENTA.dkr.ecr.$REGION.amazonaws.com/laletra-api:latest
docker push $CUENTA.dkr.ecr.$REGION.amazonaws.com/laletra-api:latest

aws lambda create-function \
  --function-name laletra-api \
  --package-type Image \
  --code ImageUri=$CUENTA.dkr.ecr.$REGION.amazonaws.com/laletra-api:latest \
  --role arn:aws:iam::$CUENTA:role/laletra-api-ejecucion \
  --architectures arm64 --memory-size 2048 --timeout 30 \
  --environment "Variables={DATABASE_URL=...}"

aws lambda create-function-url-config --function-name laletra-api --auth-type NONE
```

La función espera `DATABASE_URL` apuntando al **transaction pooler** de Supabase (puerto 6543),
2048 MB de memoria y 30 s de timeout: el arranque en frío carga el modelo, y con menos memoria
Lambda asigna menos CPU y esa carga se alarga.

```json
POST  { "vector": [384 números], "pregunta": "¿pueden entrar a mi casa sin una orden?", "n": 5 }
```

`vector` es obligatorio: el embedding de la consulta, calculado en el cliente con
multilingual-e5-small y el prefijo `query: `. `pregunta` es opcional — sin ella el lado de
palabras no vota y la búsqueda queda puramente semántica.

```json
{
  "pregunta": "¿pueden entrar a mi casa sin una orden?",
  "modo": "hibrido",
  "resultados": [
    { "articulo": 16, "afinidad": 0.8292, "rrf": 0.032787, "via": "ambos", "fragmento": "Nadie puede ser molestado en su persona, familia, domicilio…" }
  ],
  "ms": 36
}
```

## Lo que no hace

No genera texto. Igual que laletra, esto recupera artículos y muestra el fragmento que responde;
no resume, no interpreta y no da consejo legal. Un LLM encima sería el paso siguiente, y también
la forma más rápida de que el proyecto empiece a inventar artículos que no existen.
