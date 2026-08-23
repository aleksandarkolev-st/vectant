from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.live_workspace_lock import live_workspace_lock


@pytest.mark.skipif(os.name == "nt", reason="the production service uses POSIX file locking")
def test_live_workspace_lock_rejects_a_second_concurrent_writer(tmp_path):
    with live_workspace_lock(tmp_path):
        with pytest.raises(PermissionError, match="already active"):
            with live_workspace_lock(tmp_path):
                pass

    with live_workspace_lock(tmp_path):
        pass
