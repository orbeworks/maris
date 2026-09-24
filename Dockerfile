FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/mobile/package.json apps/mobile/package.json
RUN pnpm install --frozen-lockfile --filter @maris/api...

COPY apps/api apps/api
RUN pnpm --filter @maris/api build \
    && pnpm --filter @maris/api deploy --prod /app/runtime-api

FROM ghcr.io/orbeworks/maris-runtime:node22-bookworm-v1@sha256:67eeaf169dbea7908f51e9b05ea213fa69337061ec52480ad74765fb53bb93f9 AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/runtime-api/node_modules apps/api/node_modules
COPY apps/api/package.json apps/api/package.json
COPY apps/api/scripts apps/api/scripts
COPY apps/api/src/charts/models/chart-selection.ts apps/api/src/charts/models/chart-selection.ts

CMD ["node", "apps/api/dist/main.js"]
