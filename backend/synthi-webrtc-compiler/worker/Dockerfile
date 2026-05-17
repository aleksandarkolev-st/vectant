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
FROM rust:1.88-bookworm@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0 AS builder

WORKDIR /build

ARG WORKER_CARGO_FEATURES=""

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
# `[patch.crates-io] stun = { path = "vendored/stun" }` in Cargo.toml is
# resolved during lockfile processing — even the dummy cache build reads
# it — so the vendored tree must be present before `cargo build` runs.
# See `vendored/stun/README_SYNTHI_PATCH.md` for why the patch exists.
COPY vendored/ vendored/
RUN mkdir -p src/runtime src/compiler src/hmr src/infra src/safety src/android src/bin && \
    echo "fn main() {}" > src/main.rs && \
    echo "fn main() {}" > src/runtime/runner_bin.rs && \
    echo "" > src/lib.rs && \
    if [ -n "$WORKER_CARGO_FEATURES" ]; then \
      cargo build --release --features "$WORKER_CARGO_FEATURES" 2>/dev/null || true; \
    else \
      cargo build --release 2>/dev/null || true; \
    fi

# Now copy the real source and build for real
COPY src/ src/
COPY cpp_src/ cpp_src/

# Touch main.rs so cargo detects the source change
RUN touch src/main.rs src/lib.rs && \
    if [ -n "$WORKER_CARGO_FEATURES" ]; then \
      cargo build --release --features "$WORKER_CARGO_FEATURES"; \
    else \
      cargo build --release; \
    fi

# ── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM ubuntu:25.10@sha256:4a9232cc47bf99defcc8860ef6222c99773330367fcecbf21ba2edb0b810a31e

ENV DEBIAN_FRONTEND=noninteractive

ARG ROCM_VERSION=7.2.1
ARG ROCM_UBUNTU_CODENAME=noble
ARG ROCDXG_VERSION=1.2.0

# ── System compilers & language runtimes ────────────────────────────────────
# We need the latest GCC for C++26 — gcc-14 only recognises the `-std=c++26`
# flag but implements very little of the actual feature set (no reflection,
# no contracts, no pack indexing, etc.). Ubuntu 25.10 (Questing) ships
# gcc-15 in its main archive, which is the latest stable release and lands
# the bulk of the C++26 features that have been voted into the working
# draft. No third-party PPA required — using ppa:ubuntu-toolchain-r/test
# on older Ubuntu was fragile (the launchpad CDN occasionally refuses
# connections during builds, killing the image).
#
# We point the unversioned `g++` / `gcc` aliases at the new binaries via
# update-alternatives so every downstream invocation (compile_core,
# compile_gui, host_runner, the LSP's compile_flags.txt) picks up GCC 15
# without needing to know the version explicitly.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    # C/C++ — GCC 15 for C++26
    gcc-15 g++-15 clang make cmake \
    # Java — full JDK (NOT -headless): GUI apps (AWT/Swing) need
    # libawt_xawt.so + its X11 runtime deps (libxrender1, libxtst6,
    # fontconfig, …) which the -headless variant omits.
    openjdk-17-jdk \
    # Python
    python3 python3-pip \
    # SDL2
    libsdl2-2.0-0 libsdl2-dev \
    # Runtime utilities used by language runtimes, downloads, and ROCm lld
    curl xz-utils gnupg libxml2-16 \
    && update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-15 100 \
    && update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-15 100 \
    && update-alternatives --install /usr/bin/cc cc /usr/bin/gcc-15 100 \
    && update-alternatives --install /usr/bin/c++ c++ /usr/bin/g++-15 100 \
    && ln -sf /lib/x86_64-linux-gnu/libxml2.so.16 /usr/lib/x86_64-linux-gnu/libxml2.so.2 \
    && rm -rf /var/lib/apt/lists/*

# ── ROCm / HIP toolchain for GPU HMR ─────────────────────────────────────────
# Ubuntu 25.10 is newer than AMD's ROCm packaging target, so we explicitly use
# the current Ubuntu 24.04 (noble) ROCm 7.2.1 repository. ROCm 7.2.1 is the
# matching release family for RX 9070 XT / gfx1201 and ROCDXG 1.2.0 WSL support.
RUN set -eux; \
    install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSL https://repo.radeon.com/rocm/rocm.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/rocm.gpg; \
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/rocm.gpg] https://repo.radeon.com/rocm/apt/${ROCM_VERSION} ${ROCM_UBUNTU_CODENAME} main" \
      > /etc/apt/sources.list.d/rocm.list; \
    printf 'Package: *\nPin: origin repo.radeon.com\nPin-Priority: 600\n' \
      > /etc/apt/preferences.d/rocm-pin-600; \
    apt-get update; \
    apt-get install -y --no-install-recommends rocm-hip-sdk rocminfo; \
    curl -fsSL "https://github.com/ROCm/librocdxg/releases/download/v${ROCDXG_VERSION}/rocdxg-roct_${ROCDXG_VERSION}_amd64.deb" \
      -o /tmp/rocdxg.deb; \
    apt-get install -y --no-install-recommends /tmp/rocdxg.deb; \
    rm -f /tmp/rocdxg.deb; \
    ldconfig; \
    rm -rf /var/lib/apt/lists/*

ENV ROCM_PATH="/opt/rocm"
ENV RUSTUP_HOME="/usr/local/rustup"
ENV CARGO_HOME="/usr/local/cargo"
ENV PATH="${ROCM_PATH}/bin:${ROCM_PATH}/llvm/bin:${CARGO_HOME}/bin:${PATH}"
ENV LD_LIBRARY_PATH="${ROCM_PATH}/lib:${ROCM_PATH}/lib64"

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

# Install Rust toolchain for user code compilation. Avoid curl|sh by pinning
# rustup-init and verifying the archive hash before executing it.
ARG RUSTUP_VERSION=1.28.2
RUN set -eux; \
    dpkg_arch="$(dpkg --print-architecture)"; \
    case "${dpkg_arch}" in \
      amd64) rust_arch='x86_64-unknown-linux-gnu'; rustup_sha256='20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c' ;; \
      arm64) rust_arch='aarch64-unknown-linux-gnu'; rustup_sha256='e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c' ;; \
      *) echo "unsupported architecture: ${dpkg_arch}" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${rust_arch}/rustup-init"; \
    echo "${rustup_sha256}  /tmp/rustup-init" | sha256sum -c -; \
    chmod +x /tmp/rustup-init; \
    /tmp/rustup-init -y --default-toolchain stable --profile minimal --no-modify-path; \
    rm -f /tmp/rustup-init

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
# Ubuntu 24.04 ships with a default `ubuntu` user at UID 1000. Drop it so
# our `runner` user inherits UID 1000 — keeps parity with the 22.04 image
# and any host-side tooling that assumes that UID.
RUN userdel -r ubuntu 2>/dev/null || true && \
    useradd -m -s /bin/bash -u 1000 runner
# Create writable directories the worker needs
RUN mkdir -p /tmp/synthi /home/runner/.cache "${CARGO_HOME}" "${RUSTUP_HOME}" && \
    chown -R runner:runner /home/runner /tmp/synthi "${CARGO_HOME}" "${RUSTUP_HOME}"

WORKDIR /home/runner

# No inbound ports exposed — worker connects outbound to signaling + TURN.
# DISPLAY is set by K8s env var (":99" for Xvfb).

ENTRYPOINT ["worker"]
