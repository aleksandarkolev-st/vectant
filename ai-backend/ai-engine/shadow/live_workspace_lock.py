"""Process-safe serialization for live workspace agent mutations."""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


@contextmanager
def live_workspace_lock(workspace: Path) -> Iterator[None]:
    """Acquire the workspace's exclusive live-agent lock without waiting."""
    try:
        import fcntl
    except ImportError as error:  # pragma: no cover - production runs on Linux
        raise RuntimeError("live workspace locking requires a POSIX runtime") from error
    root = Path(workspace).resolve()
    lock_path = root / ".vectant" / "live-agent.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+", encoding="utf-8")
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise PermissionError("a live agent run is already active for this workspace") from error
        yield
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()
