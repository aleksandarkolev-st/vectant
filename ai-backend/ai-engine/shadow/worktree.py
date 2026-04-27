"""Pre-warmed git worktree pool + dep-install serialization.

Master plan §7. Worktrees live at `{repo}/.shadow/wt_{N}` so paths and
permissions match the source repo. We use `git worktree add` so each
universe operates on a real, isolated checkout.

The dep-install race is handled by detecting manifest changes at apply
time and acquiring a per-workspace lock (asyncio.Lock keyed by workspace).
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator, Dict, List, Optional

logger = logging.getLogger("shadow.worktree")

DEP_MANIFESTS = {
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "requirements.txt", "pyproject.toml", "poetry.lock", "uv.lock",
    "Cargo.toml", "Cargo.lock",
    "go.mod", "go.sum",
}


@dataclass
class Worktree:
    path: Path
    repo: Path
    slot: int
    in_use: bool = False


class WorktreePool:
    """One pool per (repo) path. Pre-warms up to `size` worktrees lazily."""

    def __init__(self, repo: Path, size: int = 4):
        self.repo = repo
        self.size = size
        self.shadow_root = repo / ".shadow"
        self._slots: List[Worktree] = []
        self._sem = asyncio.Semaphore(size)
        self._build_lock = asyncio.Lock()
        self._dep_lock = asyncio.Lock()  # serializes dep installs across universes

    async def _ensure_slot(self, slot: int) -> Worktree:
        async with self._build_lock:
            if slot < len(self._slots):
                return self._slots[slot]
            wt_path = self.shadow_root / f"wt_{slot}"
            self.shadow_root.mkdir(parents=True, exist_ok=True)
            if not wt_path.exists():
                await _git(["worktree", "add", "--detach", str(wt_path), "HEAD"], cwd=self.repo)
            wt = Worktree(path=wt_path, repo=self.repo, slot=slot)
            self._slots.append(wt)
            return wt

    @asynccontextmanager
    async def acquire(self) -> AsyncIterator[Worktree]:
        await self._sem.acquire()
        wt: Optional[Worktree] = None
        try:
            for slot in range(self.size):
                if slot >= len(self._slots) or not self._slots[slot].in_use:
                    wt = await self._ensure_slot(slot)
                    if not wt.in_use:
                        wt.in_use = True
                        break
            assert wt is not None, "semaphore released without a free slot"

            # Reset to a clean state matching repo HEAD.
            await _git(["stash", "--include-untracked", "--quiet"], cwd=wt.path, ignore_fail=True)
            await _git(["reset", "--hard", "HEAD", "--quiet"], cwd=wt.path)
            await _git(["clean", "-fdx", "-e", ".shadow-cache"], cwd=wt.path)
            yield wt
        finally:
            if wt is not None:
                # Best-effort cleanup; never raise from finally.
                try:
                    await _git(["reset", "--hard", "HEAD", "--quiet"], cwd=wt.path)
                    await _git(["clean", "-fdx", "-e", ".shadow-cache"], cwd=wt.path)
                except Exception as e:
                    logger.warning("worktree cleanup failed: %s", e)
                wt.in_use = False
            self._sem.release()

    @asynccontextmanager
    async def dep_lock(self):
        """Held while a universe installs deps. Wave 1 is exclusive across the pool."""
        async with self._dep_lock:
            yield


_pools: Dict[str, WorktreePool] = {}
_pool_lock = asyncio.Lock()


async def get_pool(repo: Path, size: int = 4) -> WorktreePool:
    key = str(repo.resolve())
    async with _pool_lock:
        pool = _pools.get(key)
        if pool is None:
            pool = WorktreePool(repo=Path(key), size=size)
            _pools[key] = pool
        return pool


async def teardown_all() -> None:
    """Best-effort teardown — used by tests."""
    for pool in list(_pools.values()):
        for wt in pool._slots:
            try:
                await _git(["worktree", "remove", "--force", str(wt.path)], cwd=pool.repo, ignore_fail=True)
            except Exception:
                shutil.rmtree(wt.path, ignore_errors=True)
    _pools.clear()


def patch_changes_dependencies(patch_paths: List[str]) -> bool:
    """True if any patched file is a dependency manifest."""
    for p in patch_paths:
        name = os.path.basename(p)
        if name in DEP_MANIFESTS:
            return True
    return False


# ---------------------------------------------------------------------------
# Subprocess helpers
# ---------------------------------------------------------------------------

async def _git(args: List[str], cwd: Path, ignore_fail: bool = False) -> str:
    proc = await asyncio.create_subprocess_exec(
        "git", *args,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0 and not ignore_fail:
        raise RuntimeError(f"git {' '.join(args)} failed in {cwd}: {err.decode(errors='replace')}")
    return out.decode(errors="replace")
