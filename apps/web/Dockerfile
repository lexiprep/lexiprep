# syntax=docker/dockerfile:1
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /workspace/lexiprep/apps/web

# Dev target: source is bind-mounted and deps are installed by the compose
# command, so the image only needs Node + pnpm.
FROM base AS dev
EXPOSE 5173
CMD ["pnpm", "dev"]

# Prod target: source bind-mounted, deps from a persisted volume (`make install`). The
# compose command builds the static bundle, then serves it with `vite preview` (which
# proxies /api to the server, same single-origin setup as dev).
FROM base AS prod
ENV NODE_ENV=production
EXPOSE 5173
CMD ["sh", "-c", "pnpm --filter @lexiprep/web build && pnpm --filter @lexiprep/web preview --host 0.0.0.0 --port 5173"]
