# Sin modelo dentro: la función solo consulta Postgres.
#
# La imagen pasó de 1.65 GB a unas decenas de MB, y el arranque en frío de más
# de un segundo —cuando arrancaba— a milisegundos. La razón de que el modelo no
# esté aquí está en handler.ts: en Lambda no hay forma razonable de correrlo.
FROM public.ecr.aws/lambda/nodejs:22 AS build
WORKDIR /build
COPY package.json tsconfig.json ./
RUN npm install
COPY handler.ts ./
RUN npx tsc

FROM public.ecr.aws/lambda/nodejs:22
WORKDIR ${LAMBDA_TASK_ROOT}
COPY package.json ./
# Solo el driver de Postgres: ni transformers ni onnxruntime.
RUN npm install --omit=dev postgres@^3.4.5
COPY --from=build /build/dist/handler.js ./handler.mjs
CMD ["handler.handler"]
