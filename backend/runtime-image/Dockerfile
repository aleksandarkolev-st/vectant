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

# The rootless daemon's socket. Baking it as ENV makes every `docker exec`
# (i.e. every container-program launch) talk to this workspace's own daemon.
ENV DOCKER_HOST=unix:///run/user/${ROOTLESS_UID}/docker.sock

USER rootless
WORKDIR /workspace
