"""Runtime entrypoint for the AI engine service."""

from __future__ import annotations

import os


def _positive_int_from_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a positive integer") from exc
    if value < 1:
        raise ValueError(f"{name} must be a positive integer")
    return value


def service_worker_count() -> int:
    """Return configured worker count using common container conventions."""

    if os.environ.get("SYNTHI_AI_ENGINE_WORKERS"):
        return _positive_int_from_env("SYNTHI_AI_ENGINE_WORKERS", 1)
    return _positive_int_from_env("WEB_CONCURRENCY", 1)


def build_uvicorn_args() -> list[str]:
    app = os.environ.get("SYNTHI_AI_ENGINE_APP", "main:app")
    host = os.environ.get("SYNTHI_AI_ENGINE_HOST", "0.0.0.0")
    port = _positive_int_from_env("SYNTHI_AI_ENGINE_PORT", 8000)
    keep_alive = _positive_int_from_env("SYNTHI_AI_ENGINE_TIMEOUT_KEEP_ALIVE", 120)
    workers = service_worker_count()
    return [
        "uvicorn",
        app,
        "--host",
        host,
        "--port",
        str(port),
        "--workers",
        str(workers),
        "--timeout-keep-alive",
        str(keep_alive),
    ]


def main() -> None:
    os.execvp("uvicorn", build_uvicorn_args())


if __name__ == "__main__":
    main()
