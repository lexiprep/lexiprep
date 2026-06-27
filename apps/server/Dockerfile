# syntax=docker/dockerfile:1
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# Let corepack fetch the pinned pnpm without an interactive "Do you want to continue?" prompt.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /workspace/lexiprep/apps/server

# Dev target: source is bind-mounted and deps are installed by the compose
# command, so the image only needs Node + pnpm.
FROM base AS dev
EXPOSE 3000
CMD ["pnpm", "dev"]

# Prod target: same lean image (Node + pnpm). Source is bind-mounted (updated by
# `git pull`) and deps live in a persisted volume populated by `make install`, so a
# deploy never reinstalls. The compose command builds the linked core, then starts.
FROM base AS prod
ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@lexiprep/server", "start"]
