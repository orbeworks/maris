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

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends gdal-bin python3-venv unzip \
    && rm -rf /var/lib/apt/lists/*

COPY docker/runtime/requirements.txt /tmp/requirements-runtime.txt
RUN python3 -m venv /opt/maris-python \
    && /opt/maris-python/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/maris-python/bin/pip install --no-cache-dir -r /tmp/requirements-runtime.txt \
    && /opt/maris-python/bin/python -c "import eccodes, pmtiles" \
    && ogr2ogr --version \
    && rm /tmp/requirements-runtime.txt

WORKDIR /app
ENV NODE_ENV=production \
    GFS_PARSER_PYTHON=/opt/maris-python/bin/python \
    PMTILES_PYTHON=/opt/maris-python/bin/python

COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/runtime-api/node_modules apps/api/node_modules
COPY apps/api/package.json apps/api/package.json
COPY apps/api/scripts apps/api/scripts
COPY apps/api/src/charts/models/chart-selection.ts apps/api/src/charts/models/chart-selection.ts

CMD ["node", "apps/api/dist/main.js"]
