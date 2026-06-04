import os
import sys
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from run_server import build_uvicorn_args, service_worker_count


_ENTRYPOINT_ENV_KEYS = [
    "SYNTHI_AI_ENGINE_APP",
    "SYNTHI_AI_ENGINE_HOST",
    "SYNTHI_AI_ENGINE_PORT",
    "SYNTHI_AI_ENGINE_TIMEOUT_KEEP_ALIVE",
    "SYNTHI_AI_ENGINE_WORKERS",
    "WEB_CONCURRENCY",
]


@contextmanager
def isolated_entrypoint_env(values=None):
    previous = {key: os.environ.get(key) for key in _ENTRYPOINT_ENV_KEYS}
    try:
        for key in _ENTRYPOINT_ENV_KEYS:
            os.environ.pop(key, None)
        for key, value in (values or {}).items():
            os.environ[key] = value
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def test_service_worker_count_defaults_to_single_worker():
    with isolated_entrypoint_env():
        assert service_worker_count() == 1


def test_service_worker_count_accepts_standard_web_concurrency():
    with isolated_entrypoint_env({"WEB_CONCURRENCY": "3"}):
        assert service_worker_count() == 3


def test_service_worker_count_prefers_service_specific_env():
    with isolated_entrypoint_env(
        {"SYNTHI_AI_ENGINE_WORKERS": "2", "WEB_CONCURRENCY": "4"}
    ):
        assert service_worker_count() == 2


def test_service_worker_count_rejects_invalid_values():
    for env_name in ["SYNTHI_AI_ENGINE_WORKERS", "WEB_CONCURRENCY"]:
        with isolated_entrypoint_env({env_name: "0"}):
            try:
                service_worker_count()
            except ValueError:
                pass
            else:
                raise AssertionError(f"{env_name} accepted an invalid worker count")


def test_build_uvicorn_args_uses_generic_service_env():
    with isolated_entrypoint_env(
        {
            "SYNTHI_AI_ENGINE_APP": "module:app",
            "SYNTHI_AI_ENGINE_HOST": "127.0.0.1",
            "SYNTHI_AI_ENGINE_PORT": "9001",
            "SYNTHI_AI_ENGINE_TIMEOUT_KEEP_ALIVE": "45",
            "SYNTHI_AI_ENGINE_WORKERS": "2",
        }
    ):
        assert build_uvicorn_args() == [
            "uvicorn",
            "module:app",
            "--host",
            "127.0.0.1",
            "--port",
            "9001",
            "--workers",
            "2",
            "--timeout-keep-alive",
            "45",
        ]


if __name__ == "__main__":
    test_service_worker_count_defaults_to_single_worker()
    test_service_worker_count_accepts_standard_web_concurrency()
    test_service_worker_count_prefers_service_specific_env()
    test_service_worker_count_rejects_invalid_values()
    test_build_uvicorn_args_uses_generic_service_env()
    print("run_server tests passed")
