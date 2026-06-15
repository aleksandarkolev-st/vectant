# vectant-runtime — per-workspace Docker engine + k8s/default-program toolchain.
#
# BUILT TWO WAYS from this ONE Dockerfile (default = rootless; override args = rootful):
#   • LOCAL DEV HYBRID (default args): rootless dind under Docker Desktop `--privileged`
#     (backend/collab-server/workspaceRuntimeContainer.js). Rootless-inside-privileged;
#     user `rootless`, daemon at /run/user/1000/docker.sock. RUNTIME_IMAGE points here.
#   • SYSBOX PROD: rootful dind under `runtimeClassName: sysbox-runc`, NO privilege —
#     Sysbox supplies the userns isolation, so a NORMAL rootful daemon runs safely.
#     RUNTIME_POD_IMAGE (runtimePodSpec.js) points here. Build with:
#       --build-arg RUNTIME_BASE=docker:dind@sha256:<digest>
#       --build-arg RUNTIME_USER=root
#       --build-arg RUNTIME_HOME=/root
#       --build-arg DOCKER_SOCK=/var/run/docker.sock
#     The rootless image CRASH-LOOPS under Sysbox — `rootlesskit … fork/exec
#     /proc/self/exe: operation not permitted` — because rootlesskit can't nest a
#     user namespace inside the one Sysbox already provides (validated live on GKE
#     2026-06-15; the identical Deployment runs `docker run hello-world` with a
#     rootful base). See tasks/lessons.md.
#
# Carries kind/kubectl/helm so the workspace's own daemon can drive real container +
# Kubernetes workflows. Bases pinned by digest for reproducibility; bump deliberately.
ARG RUNTIME_BASE=docker:dind-rootless@sha256:41825fb12da6b78219af4b862830f252be1f5dee3d6cbfd508736ed31c0014d8
FROM ${RUNTIME_BASE}

# Target identity — defaults match the rootless base (local hybrid). The Sysbox
# build overrides these to root / /root / the rootful socket (see header).
ARG RUNTIME_USER=rootless
ARG RUNTIME_HOME=/home/rootless
ARG DOCKER_SOCK=/run/user/1000/docker.sock

USER root

# Default-program toolchain (Alpine base → apk). node/python/git for container
# programs; lazygit for the @vectant/lazygit recipe; bash/curl/ca-certificates
# as common shell + fetch deps.
RUN apk add --no-cache \
      nodejs npm \
      python3 py3-pip \
      git lazygit curl ca-certificates bash

# http-server for static container programs.
RUN npm install -g http-server

# ── Terminal env parity (Phase 2a) ───────────────────────────────────────────
# The in-app terminal runs as `bash -l` inside this container, so it must match
# the collab-server terminal's tooling.

# Claude Code CLI — exposed in the terminal (lands in /usr/local/bin, on PATH).
RUN npm install -g @anthropic-ai/claude-code

# ── Container + k8s orchestration toolchain (Sysbox runtime — Slice 1) ─────────
# The workspace's OWN daemon drives real `docker build/run/compose`,
# `kind create cluster`, `kubectl`, and `helm`. compose + buildx are already
# bundled in the dind base, so only kubectl + helm are added (Alpine community).
RUN apk add --no-cache kubectl helm

# kind is not packaged for Alpine — install a pinned release binary verified by
# its published SHA-256. Bump KIND_VERSION + KIND_SHA256 together, deliberately.
ARG KIND_VERSION=v0.32.0
ARG KIND_SHA256=50030de23cf40a18505f20426f6a8506bedf13c6e509244bd1fa9463721b0f54
RUN curl -fsSLo /usr/local/bin/kind "https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-linux-amd64" \
 && echo "${KIND_SHA256}  /usr/local/bin/kind" | sha256sum -c - \
 && chmod +x /usr/local/bin/kind

# sudo for ad-hoc installs from the terminal, passwordless for the target user
# (this container is the user's own isolated sandbox).
RUN apk add --no-cache sudo \
 && echo "${RUNTIME_USER} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/runtime-user \
 && chmod 0440 /etc/sudoers.d/runtime-user

# Git identity (system-level so it applies regardless of HOME), matching the
# collab-server autocommit identity.
RUN git config --system user.email "synthi@overview-synti.com" \
 && git config --system user.name "Synthi Autocommit"

# Ensure the target user has a writable HOME for git/npm/claude config, and a
# friendly login-shell prompt so the terminal reads "~/workspace $".
RUN mkdir -p ${RUNTIME_HOME} \
 && chown -R ${RUNTIME_USER}:${RUNTIME_USER} ${RUNTIME_HOME} \
 && printf 'export PS1="\\[\\e[36m\\]~/workspace\\[\\e[0m\\]\\$ "\n' > /etc/profile.d/00-vectant-prompt.sh
ENV HOME=${RUNTIME_HOME}

# The daemon's socket. Rootless dind listens on /run/user/<uid>/docker.sock; rootful
# dind (Sysbox) on /var/run/docker.sock. Baking it as ENV makes every `docker exec`
# (i.e. every container-program launch) talk to this workspace's own daemon; the
# per-program env scrub keeps any recipe-supplied DOCKER_HOST blocked.
ENV DOCKER_HOST=unix://${DOCKER_SOCK}

USER ${RUNTIME_USER}
WORKDIR /workspace
