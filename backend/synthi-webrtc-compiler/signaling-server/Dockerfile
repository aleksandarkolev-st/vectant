# ─────────────────────────────────────────────────────────────────────────────
#  Multi-stage build for the signaling server
#  Builder: rust:1.75   Runtime: debian:bookworm-slim (only the binary)
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM rust:1.88-bookworm@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0 AS builder

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src/ src/

# Build release binary with full optimisations.
RUN apt-get update && apt-get install -y clang libclang-dev llvm-dev
RUN cargo build --release

# ── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM debian:bookworm-slim@sha256:67b30a61dc87758f0caf819646104f29ecbda97d920aaf5edc834128ac8493d3

# Install minimal TLS / DNS libs required by the redis crate at runtime.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates libssl3 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/signaling-server /usr/local/bin/signaling-server

# Non-root for K8s security best-practice.
RUN useradd --system --no-create-home signaling
USER signaling

ENV SIGNALING_PORT=9000
EXPOSE 9000

ENTRYPOINT ["signaling-server"]
