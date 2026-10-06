# syntax=docker/dockerfile:1
# Local demo image for the Creator x Builder platform: `docker compose up --build`, then open
# http://localhost:3000. Every external service runs fake (FAKE_SERVICES=all); see README.
# Not a production image: it keeps dev dependencies so migrations and the seed can run at start.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS app
COPY . .
# NEXT_PUBLIC_* values are inlined at build time. The rest are build-only placeholders so that
# env validation passes while pages are prerendered; real values come from docker-compose.yml.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    APP_ENV=development \
    FAKE_SERVICES=all
RUN DATABASE_URL=postgres://build:build@localhost:5432/build \
    AUTH_SECRET=build-only-placeholder-secret-not-used-at-runtime \
    ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    STRIPE_WEBHOOK_SECRET=whsec_build_only_placeholder \
    pnpm build
RUN chmod +x docker/entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["docker/entrypoint.sh"]
