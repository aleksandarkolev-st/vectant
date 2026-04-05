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
FROM python:3.10-slim AS builder
WORKDIR /build

RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip wheel --no-cache-dir --wheel-dir /build/wheels -r requirements.txt

# ── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM python:3.10-slim
WORKDIR /app

# Prevent .pyc files and ensure real-time log output
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Install pre-built wheels — no compiler needed at runtime
COPY --from=builder /build/wheels /tmp/wheels
COPY --from=builder /build/requirements.txt .
RUN pip install --no-cache-dir /tmp/wheels/* && rm -rf /tmp/wheels

COPY . .

RUN useradd --system --no-create-home appuser
USER appuser

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--timeout-keep-alive", "120"]
