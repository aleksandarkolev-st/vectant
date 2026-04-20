# ─────────────────────────────────────────────────────────────────────────────
#  Synthi IDE — WebRTC Compiler Worker (Rust + GStreamer + Xvfb)
# ─────────────────────────────────────────────────────────────────────────────
#  Multi-stage build:
#    Stage 1 (builder): Compiles the Rust `worker` and `runner` binaries
#    Stage 2 (runtime): Heavy image with compilers, GStreamer, Xvfb, LSP
#                       servers — everything needed to compile/run user code
#                       and stream the GUI via WebRTC.
#
#  Expected image size: ~3-5 GB due to compiler toolchains.
#  Use Artifact Registry image streaming to keep pod start times <10s.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Rust build ─────────────────────────────────────────────────────
FROM rust:1.88-bookworm AS builder

WORKDIR /build

# Install GStreamer dev headers (required for gstreamer-rs build scripts)
# and protobuf compiler (required by tonic-build + protoc-bin-vendored)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgstreamer1.0-dev \
    libgstreamer-plugins-base1.0-dev \
    libx11-dev libxcb1-dev \
    libsdl2-dev \
    clang libclang-dev llvm-dev \
    protobuf-compiler libprotobuf-dev \
    pkg-config \
    cmake \
    && rm -rf /var/lib/apt/lists/*

# Cache dependencies: copy manifests first, build a dummy to cache crate downloads
COPY Cargo.toml Cargo.lock ./
COPY build.rs ./
COPY proto/ proto/
COPY .cargo/ .cargo/
RUN mkdir -p src/runtime src/compiler src/hmr src/infra src/safety src/android src/bin && \
    echo "fn main() {}" > src/main.rs && \
    echo "fn main() {}" > src/runtime/runner_bin.rs && \
    echo "" > src/lib.rs && \
    cargo build --release 2>/dev/null || true

# Now copy the real source and build for real
COPY src/ src/
COPY cpp_src/ cpp_src/

# Touch main.rs so cargo detects the source change
RUN touch src/main.rs src/lib.rs && \
    cargo build --release

# ── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# ── System compilers & language runtimes ────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # C/C++
    g++ gcc clang make cmake \
    # Java
    openjdk-17-jdk-headless \
    # Python
    python3 python3-pip \
    # Runtime utilities used by language runtimes and downloads
    curl ca-certificates xz-utils \
    && rm -rf /var/lib/apt/lists/*

ARG NODE_VERSION=20.20.2

# Install a modern Node runtime because the VS Code bridge assets rely on
# language features that Ubuntu's stock Node 12 package does not support.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) node_arch='x64' ;; \
        arm64) node_arch='arm64' ;; \
        *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -o /tmp/node.tar.xz; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner; \
    rm /tmp/node.tar.xz; \
    npm install -g typescript typescript-language-server; \
    npm cache clean --force

# Install Rust toolchain for user code compilation
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

# ── GStreamer (video encoding pipeline for GUI streaming) ───────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    gstreamer1.0-tools \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-libav \
    libgstreamer1.0-0 \
    libgstreamer-plugins-base1.0-0 \
    && rm -rf /var/lib/apt/lists/*

# ── X11 / Virtual display (for GUI app rendering) ──────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    matchbox-window-manager \
    x11-utils \
    xdotool \
    libx11-6 libxcb1 \
    && rm -rf /var/lib/apt/lists/*

# ── LSP servers (language intelligence for the editor) ──────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    clangd \
    && rm -rf /var/lib/apt/lists/*
# rust-analyzer installed via rustup
RUN rustup component add rust-analyzer

# ── Copy compiled worker binaries ──────────────────────────────────────────
COPY --from=builder /build/target/release/worker /usr/local/bin/worker
COPY --from=builder /build/target/release/runner /usr/local/bin/runner
COPY vscode-server-manager.js /usr/local/bin/vscode-server-manager.js
COPY ext-host-preload.js /usr/local/bin/ext-host-preload.js
COPY esm-vscode-hook.mjs /usr/local/bin/esm-vscode-hook.mjs

# ── Security hardening ─────────────────────────────────────────────────────
RUN useradd -m -s /bin/bash runner
# Create writable directories the worker needs
RUN mkdir -p /tmp/synthi /home/runner/.cache && \
    chown -R runner:runner /home/runner /tmp/synthi

WORKDIR /home/runner

# No inbound ports exposed — worker connects outbound to signaling + TURN.
# DISPLAY is set by K8s env var (":99" for Xvfb).

ENTRYPOINT ["worker"]
