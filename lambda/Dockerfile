# Imagen de contenedor y no zip: el modelo pesa ~112 MB y el límite de un
# paquete zip descomprimido en Lambda es 250 MB. Con contenedor hay 10 GB y,
# sobre todo, el modelo queda dentro de la imagen en vez de descargarse en el
# primer arranque en frío.
FROM public.ecr.aws/lambda/nodejs:22 AS build

WORKDIR /build
COPY package.json tsconfig.json ./
RUN npm install
COPY handler.ts descargar-modelo.mts ./
RUN npx tsc
RUN node --experimental-strip-types descargar-modelo.mts

FROM public.ecr.aws/lambda/nodejs:22

WORKDIR ${LAMBDA_TASK_ROOT}
COPY package.json ./
RUN npm install --omit=dev

COPY --from=build /build/dist/handler.js ./handler.mjs
COPY --from=build /build/modelo ./modelo

ENV MODELO_DIR=${LAMBDA_TASK_ROOT}/modelo
CMD ["handler.handler"]
