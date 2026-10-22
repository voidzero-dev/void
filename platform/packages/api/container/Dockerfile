# Build container image for "Deploy on GitHub".
#
# This image is a THIN harness. It does NOT re-implement deploy packaging — it
# downloads the pushed source, installs the repo's dependencies, and runs the
# REAL `void deploy` CLI. The BuildManager Durable Object (packages/api/src/
# build-manager.ts) starts this container with the build env vars and consumes
# the agent's status / log POSTs.
#
# Env vars injected by the DO at start():
#   BUILD_ID, PROJECT_ID, PROJECT_SLUG, SOURCE_TARBALL_URL, SOURCE_TOKEN,
#   VOID_TOKEN, VOID_API_URL, VOID_PROJECT, DO_LOG_URL, AGENT_TOKEN
FROM node:26.12.1-slim

# node:26.12.1-slim ships `tar` + `gzip` but is otherwise minimal. We add:
#   ca-certificates       HTTPS for the tarball fetch, npm/bun installs, deploy upload
#   curl                  documented fallback download path + the bun install script
#   unzip                 required by the bun install script
#   git                   git-spec deps (git+https:..., github:owner/repo) fetch at install
#   python3 / make / g++  node-gyp's native source builds (deps with binding.gyp)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# There is no SSH client in the image and no channel for user key material to
# reach the container, so ssh-spec git deps (git+ssh://git@github.com/...,
# git@github.com:owner/repo) could never authenticate here. Rewrite them to
# https at the system level instead: public GitHub repos then install
# anonymously, and private ones fail with an actionable "could not read
# Username for 'https://github.com'" auth error instead of "cannot spawn ssh".
RUN git config --system url."https://github.com/".insteadOf "ssh://git@github.com/" \
  && git config --system --add url."https://github.com/".insteadOf "git@github.com:"

# pnpm + yarn are managed through corepack. The agent invokes them via
# `corepack pnpm` / `corepack yarn` so the repo's packageManager pin (if any) is
# respected. Corepack is not bundled with Node 26, so install it explicitly.
# Version-pinned so an upstream release cannot change production build images
# without a repo diff.
ARG COREPACK_VERSION=0.35.0
RUN npm install -g "corepack@${COREPACK_VERSION}" \
  && corepack enable

# Bun for repos that pin bun.lock / bun.lockb. Installed to a stable global
# path on PATH so the agent can shell out to `bun`. Version-pinned so the
# build executor is reproducible and an upstream installer change cannot
# alter production build images without a repo diff.
ARG BUN_VERSION=1.3.14
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
  && test "$(bun --version)" = "${BUN_VERSION}"

# Untrusted repo code — dependency lifecycle scripts (postinstall etc.) and the
# user's `void deploy` build — runs as this NON-ROOT user so it cannot read the
# root agent's /proc/<ppid>/environ and recover AGENT_TOKEN/SOURCE_TOKEN (the
# control-plane secrets it never needs). The agent itself stays root (no USER
# directive) so it can setuid-spawn the children and chown the source tree. The
# uid/gid MUST match BUILDER_UID/BUILDER_GID in build-agent.mjs. Pre-create the
# package-manager cache dirs (corepack/npm/yarn/bun all write under $HOME) so the
# unprivileged install has somewhere writable — build-agent.mjs points the child's
# cache env vars (builderCacheEnv) at these paths. /tmp/build is the agent's
# WORK_DIR parent; chowning it lets the builder own the extracted tree.
# node:26.12.1-slim ships a built-in `node` user that already owns uid/gid 1000, so
# it must be removed first or the useradd fails with "UID 1000 is not unique"
# and the image cannot build. Nothing here runs as `node`.
RUN userdel node \
  && rm -rf /home/node \
  && useradd --uid 1000 --create-home --home-dir /home/builder builder \
  && mkdir -p /home/builder/.cache/node/corepack /home/builder/.cache/yarn \
              /home/builder/.npm /home/builder/.bun /tmp/build \
  && chown -R builder:builder /home/builder /tmp/build

# Pre-provision a pinned pnpm + yarn into the BUILDER's corepack home. A repo can
# have a lockfile (pnpm-lock.yaml / yarn.lock) but NO `packageManager` field; with
# only `corepack enable` the builder's corepack home is empty, so corepack would
# fall back to downloading "latest" on every build — nondeterministic across
# image rebuilds and dependent on a runtime network fetch. Activating a pinned
# version here makes those repos build against a fixed, reproducible toolchain
# with no per-build download. corepack still honors a repo's explicit
# `packageManager` pin when present, so this only sets the no-pin default.
# COREPACK_HOME MUST match builderCacheEnv() in build-agent.mjs. Pinned for the
# same reproducibility reason as Bun above.
ARG PNPM_VERSION=11.8.0
ARG YARN_VERSION=1.22.22
RUN COREPACK_HOME=/home/builder/.cache/node/corepack \
    corepack prepare "pnpm@${PNPM_VERSION}" "yarn@${YARN_VERSION}" --activate \
  && chown -R builder:builder /home/builder/.cache/node/corepack

# Build from the repository root. The root .dockerignore limits the context to
# these files. Keep their relative layout so Node can import the release manifest
# without node_modules or a generated version file. Both remain root-owned.
COPY packages/void/package.json /opt/void/packages/void/package.json
COPY platform/packages/api/container/build-agent.mjs /opt/void/platform/packages/api/container/build-agent.mjs

# Health-check / control port the DO talks to (GET / health, POST /cancel).
EXPOSE 4000

CMD ["node", "/opt/void/platform/packages/api/container/build-agent.mjs"]
