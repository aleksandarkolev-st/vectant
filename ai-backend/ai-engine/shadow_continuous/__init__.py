"""Continuous shadow. Master plan §14 (Wave 4).

Subscribes to file-save events (via the collab-server bridge or any
other producer that POSTs to /shadow_continuous/notify), debounces 800ms
per workspace, identifies changed modules, replays the matching tests
from the regression log, and surfaces a chat suggestion only when a
test that previously passed now fails (pass→fail trigger).

The 10-minute idle ping the original spec described is *cut* per master
plan §14 — signal-to-noise was poor.
"""

from .preference_store import (  # re-export for convenience  # noqa: F401
    is_workspace_opted_out,
    set_workspace_opt_out,
    daily_spend,
    spent_today,
    DAILY_SPEND_CAP_USD,
)
from .watcher import notify_change, get_state  # noqa: F401
from .regression_runner import replay_for_changes  # noqa: F401
