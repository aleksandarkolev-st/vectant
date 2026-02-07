"""
Change Impact Model - Learn co-change neighborhoods from git history.
"""

from __future__ import annotations

import logging
import os
import subprocess
from collections import defaultdict
from typing import Dict, Iterable, List, Set

from ..core.config import get_config

logger = logging.getLogger("code_intel.routing.change_impact")


class ChangeImpactModel:
    def __init__(self, workspace_root: str):
        self.workspace_root = os.path.abspath(workspace_root)
        self.config = get_config()
        self._built = False
        self._co_change: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))

    def build(self) -> None:
        if self._built:
            return
        self._built = True
        if not self.config.retrieval.enable_change_impact:
            return
        try:
            commits = int(self.config.retrieval.change_impact_commits)
            cmd = ["git", "-C", self.workspace_root, "log", f"-n{commits}", "--name-only", "--pretty=format:"]
            result = subprocess.run(cmd, capture_output=True, text=True, check=False)
            if result.returncode != 0:
                return
            blocks = result.stdout.split("\n\n")
            for block in blocks:
                files = [line.strip() for line in block.split("\n") if line.strip()]
                if len(files) < 2:
                    continue
                for a in files:
                    for b in files:
                        if a == b:
                            continue
                        self._co_change[a][b] += 1
        except Exception:
            return

    def get_neighbors(self, seed_files: Iterable[str]) -> List[str]:
        self.build()
        neighbors: Dict[str, int] = defaultdict(int)
        for fp in seed_files:
            if fp in self._co_change:
                for other, count in self._co_change[fp].items():
                    neighbors[other] += count
        ranked = sorted(neighbors.items(), key=lambda x: x[1], reverse=True)
        max_n = int(self.config.retrieval.change_impact_max_neighbors)
        return [f for f, _ in ranked[:max_n]]
