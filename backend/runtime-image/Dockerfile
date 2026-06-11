# vectant-runtime:local — per-workspace rootless Docker engine + default-program toolchain.
#
# Based on docker:dind-rootless so each workspace gets its OWN isolated rootless
# daemon: `docker`/`docker compose` inside a container program never touch the
# host socket and cannot see another workspace's containers. The collab-server
# spawns one of these per workspace (see workspaceRuntimeContainer.js).
#
# NOTE: the base dind-rootless image does NOT export DOCKER_HOST (verified in the
# Task 1 spike — `docker exec` defaulted to /var/run/docker.sock and failed). The
# rootless daemon listens on unix:///run/user/<uid>/docker.sock, so we bake that
# into the image ENV below; `docker exec`'d program launches then inherit it,
# while the per-program env scrub keeps any recipe-supplied DOCKER_HOST blocked.
#
# Base image is pinned by digest for reproducibility (docker:dind-rootless == 29.5.3,
# verified in the spike). Bump deliberately, not implicitly.
FROM docker:dind-rootless@sha256:41825fb12da6b78219af4b862830f252be1f5dee3d6cbfd508736ed31c0014d8

# The rootless user's UID in the base image. Decoupled here so a future base
# bump that changes the UID is a one-line edit rather than a silent breakage.
ARG ROOTLESS_UID=1000

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

# sudo for ad-hoc installs from the terminal, passwordless for the rootless user
# (this container is the user's own isolated sandbox).
RUN apk add --no-cache sudo \
 && echo 'rootless ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/rootless \
 && chmod 0440 /etc/sudoers.d/rootless

# Git identity (system-level so it applies regardless of HOME), matching the
# collab-server autocommit identity.
RUN git config --system user.email "synthi@overview-synti.com" \
 && git config --system user.name "Synthi Autocommit"

# Ensure the rootless user has a writable HOME for git/npm/claude config, and a
# friendly login-shell prompt so the terminal reads "~/workspace $".
RUN mkdir -p /home/rootless \
 && chown -R rootless:rootless /home/rootless \
 && printf 'export PS1="\\[\\e[36m\\]~/workspace\\[\\e[0m\\]\\$ "\n' > /etc/profile.d/00-vectant-prompt.sh
ENV HOME=/home/rootless

# The rootless daemon's socket. Baking it as ENV makes every `docker exec`
# (i.e. every container-program launch) talk to this workspace's own daemon.
ENV DOCKER_HOST=unix:///run/user/${ROOTLESS_UID}/docker.sock

USER rootless
WORKDIR /workspace
