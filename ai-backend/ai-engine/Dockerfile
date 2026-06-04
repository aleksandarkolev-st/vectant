# ─────────────────────────────────────────────────────────────────────────────
#  Synthi IDE — AI Engine (Python 3.10, FastAPI + Uvicorn)
# ─────────────────────────────────────────────────────────────────────────────
#  Stateless LLM orchestration service.  No local state — safe to scale
#  horizontally.  Uses google-generativeai (Gemini) and tiktoken.
#
#  tiktoken + numpy require a C compiler during pip install on slim images,
#  so build-essential is installed then removed.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Build wheels ───────────────────────────────────────────────────
FROM python:3.10-slim@sha256:a3699f905b890636146817f204e73d9aa61329127b0c60e46310c44f9f0612b2 AS builder
WORKDIR /build

RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip wheel --no-cache-dir --wheel-dir /build/wheels -r requirements.txt

# ── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM python:3.10-slim@sha256:a3699f905b890636146817f204e73d9aa61329127b0c60e46310c44f9f0612b2
WORKDIR /app

# Prevent .pyc files and ensure real-time log output
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Install pre-built wheels — no compiler needed at runtime
COPY --from=builder /build/wheels /tmp/wheels
COPY --from=builder /build/requirements.txt .
RUN pip install --no-cache-dir /tmp/wheels/* && rm -rf /tmp/wheels

COPY . .

# Match uid/gid with collab-server (which owns /data/repos as 1001:1001).
# Without this, the CodeIntel engine 500s on every workspace load trying to
# write its index into <workspace>/.code_intel (Permission denied).
RUN groupadd --system --gid 1001 appuser \
 && useradd --system --no-create-home --uid 1001 --gid 1001 appuser
USER appuser

EXPOSE 8000

CMD ["python", "run_server.py"]
