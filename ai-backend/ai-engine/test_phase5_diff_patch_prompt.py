#!/usr/bin/env python3
"""
Phase 5 (ULTRAPLAN) — Tier 2 4-module diff_patch tests.

Tests the Python-side wiring that lets the AI emit edits targeting
`host_runner` as a 4th module alongside core/gui/shared. Specifically:

  - `_VALID_EDIT_MODULES` includes "host_runner"
  - `_validate_edit_list` accepts a host_runner edit
  - `_validate_edit_list` rejects unknown modules
  - `_build_full_diff_patch_prompt` includes the host_runner block
    when host_runner_content is non-empty
  - `_build_full_diff_patch_prompt` SKIPS the host_runner block when
    host_runner_content is empty (legacy 3-file project)
  - The CRITICAL RULE 5 (host_runner ownership) is in the prompt
  - The OUTPUT FORMAT module enum mentions "host_runner"
  - DiffPatchRequest accepts host_runner_content field

Why import-from-main: the helpers are module-private (_prefixed) so
we import them directly. The main.py top-level FastAPI app setup is
side-effect-light enough to import without starting a server.

Run:
    python3 test_phase5_diff_patch_prompt.py
"""
from __future__ import annotations

import sys

# Phase 5 extracted these helpers out of main.py specifically so the
# tests can import them without dragging in main.py's full import chain
# (model clients, telemetry, the dotenv-loaded config, etc.). The
# helpers re-export from main.py too, so production code is unchanged.
import diff_patch_helpers as dph


PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"


def _run_tests() -> int:
    g = globals()
    test_names = sorted(n for n in g if n.startswith("test_") and callable(g[n]))
    passed = 0
    failed = 0
    for name in test_names:
        fn = g[name]
        try:
            fn()
            print(f"  [{PASS}] {name}")
            passed += 1
        except AssertionError as e:
            print(f"  [{FAIL}] {name}")
            print(f"           assertion: {e}")
            failed += 1
        except Exception as e:
            print(f"  [{FAIL}] {name}")
            print(f"           {type(e).__name__}: {e}")
            failed += 1
    print()
    print(f"  {passed}/{passed + failed} tests passed")
    return 0 if failed == 0 else 1


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def make_diff_patch_request(
    diff: str = "@@ -1,1 +1,1 @@\n-int x = 5;\n+int x = 6;\n",
    core_content: str = "// CORE",
    gui_content: str = "// GUI",
    shared_content: str = "// SHARED",
    host_runner_content: str = "",
    architecture: str = "",
):
    """Build a DiffPatchRequest with sensible defaults."""
    return dph.DiffPatchRequest(
        diff=diff,
        core_content=core_content,
        gui_content=gui_content,
        shared_content=shared_content,
        host_runner_content=host_runner_content,
        architecture=architecture,
    )


# ─────────────────────────────────────────────────────────────────────────────
# _VALID_EDIT_MODULES — set membership
# ─────────────────────────────────────────────────────────────────────────────


def test_valid_edit_modules_includes_host_runner():
    assert "host_runner" in dph.VALID_EDIT_MODULES


def test_valid_edit_modules_still_includes_legacy_three():
    # Backward compat: existing core/gui/shared modules must still be valid
    for m in ("core", "gui", "shared"):
        assert m in dph.VALID_EDIT_MODULES, f"{m} dropped from _VALID_EDIT_MODULES"


def test_valid_edit_modules_does_not_include_random_strings():
    assert "main" not in dph.VALID_EDIT_MODULES
    assert "runner" not in dph.VALID_EDIT_MODULES
    assert "host" not in dph.VALID_EDIT_MODULES
    assert "" not in dph.VALID_EDIT_MODULES


# ─────────────────────────────────────────────────────────────────────────────
# _validate_edit_list — module gate
# ─────────────────────────────────────────────────────────────────────────────


def test_validate_edit_list_accepts_host_runner_edit():
    edits = [
        {
            "module": "host_runner",
            "operation": "insert_after",
            "anchor": "SDL_Init(SDL_INIT_VIDEO);",
            "content": "\n    SDL_Init(SDL_INIT_AUDIO);",
        }
    ]
    cleaned = dph.validate_edit_list(edits)
    assert len(cleaned) == 1
    assert cleaned[0]["module"] == "host_runner"


def test_validate_edit_list_accepts_mixed_4_module_list():
    edits = [
        {"module": "core", "operation": "replace", "anchor": "a", "content": "b"},
        {"module": "gui", "operation": "delete", "anchor": "x", "content": ""},
        {"module": "shared", "operation": "insert_before", "anchor": "y", "content": "z"},
        {"module": "host_runner", "operation": "insert_after", "anchor": "p", "content": "q"},
    ]
    cleaned = dph.validate_edit_list(edits)
    assert len(cleaned) == 4
    modules = [e["module"] for e in cleaned]
    assert modules == ["core", "gui", "shared", "host_runner"]


def test_validate_edit_list_rejects_unknown_module():
    edits = [
        {"module": "main_runner", "operation": "replace", "anchor": "a", "content": "b"},
    ]
    try:
        dph.validate_edit_list(edits)
    except Exception as e:
        # FastAPI HTTPException carries .detail with the actual error message
        msg = getattr(e, "detail", str(e))
        assert "main_runner" in msg or "module" in msg
        return
    raise AssertionError("expected HTTPException for unknown module")


def test_validate_edit_list_rejects_typo_in_host_runner():
    # Common typo: "hostrunner" without underscore
    edits = [
        {"module": "hostrunner", "operation": "replace", "anchor": "a", "content": "b"},
    ]
    try:
        dph.validate_edit_list(edits)
    except Exception as e:
        msg = getattr(e, "detail", str(e))
        assert "hostrunner" in msg
        return
    raise AssertionError("expected HTTPException for hostrunner typo")


def test_validate_edit_list_strips_extra_fields():
    edits = [
        {
            "module": "host_runner",
            "operation": "replace",
            "anchor": "old",
            "content": "new",
            "extra_garbage_field": "should be removed",
        }
    ]
    cleaned = dph.validate_edit_list(edits)
    assert "extra_garbage_field" not in cleaned[0]


# ─────────────────────────────────────────────────────────────────────────────
# _build_full_diff_patch_prompt — host_runner block presence/absence
# ─────────────────────────────────────────────────────────────────────────────


def test_prompt_includes_host_runner_block_when_content_present():
    req = make_diff_patch_request(
        host_runner_content='int main() {\n    SDL_Init(SDL_INIT_VIDEO);\n    return 0;\n}\n'
    )
    prompt = dph.build_full_diff_patch_prompt(req)
    assert "CURRENT host_runner module content:" in prompt
    assert "SDL_Init(SDL_INIT_VIDEO)" in prompt


def test_prompt_skips_host_runner_block_when_content_empty():
    req = make_diff_patch_request(host_runner_content="")
    prompt = dph.build_full_diff_patch_prompt(req)
    assert "CURRENT host_runner module content:" not in prompt


def test_prompt_skips_host_runner_block_when_content_whitespace_only():
    req = make_diff_patch_request(host_runner_content="   \n\n  \t\n")
    prompt = dph.build_full_diff_patch_prompt(req)
    assert "CURRENT host_runner module content:" not in prompt


def test_prompt_always_includes_core_gui_shared_blocks():
    # Even with empty host_runner, the legacy 3 blocks must always be present
    req = make_diff_patch_request(host_runner_content="")
    prompt = dph.build_full_diff_patch_prompt(req)
    assert "CURRENT core module content:" in prompt
    assert "CURRENT gui module content:" in prompt
    assert "CURRENT shared module content:" in prompt


# ─────────────────────────────────────────────────────────────────────────────
# Critical rules + output format
# ─────────────────────────────────────────────────────────────────────────────


def test_prompt_mentions_host_runner_in_rule_3_module_enum():
    # CRITICAL RULE 3 lists the valid module values
    req = make_diff_patch_request()
    prompt = dph.build_full_diff_patch_prompt(req)
    # Find the rule 3 section
    assert "host_runner" in prompt
    # The OUTPUT FORMAT also mentions it
    assert '"host_runner"' in prompt


def test_prompt_includes_critical_rule_5_host_runner_ownership():
    # Rule 5 explains what belongs in host_runner vs core/gui
    req = make_diff_patch_request()
    prompt = dph.build_full_diff_patch_prompt(req)
    # Look for ownership keywords from the rule
    prompt_lower = prompt.lower()
    assert "host_runner" in prompt_lower
    # Rule 5 mentions window init OR event loop OR library init
    assert (
        "window init" in prompt_lower
        or "event loop" in prompt_lower
        or "library init" in prompt_lower
        or "ownership" in prompt_lower
    )


def test_prompt_rule_5_warns_against_emitting_when_empty():
    # The rule should explicitly tell the AI not to emit host_runner
    # edits when host_runner.cpp is empty (legacy 3-file project)
    req = make_diff_patch_request()
    prompt = dph.build_full_diff_patch_prompt(req)
    assert "empty" in prompt.lower() or "legacy" in prompt.lower()


def test_prompt_output_format_lists_4_module_options():
    req = make_diff_patch_request(host_runner_content="int main(){}")
    prompt = dph.build_full_diff_patch_prompt(req)
    # The OUTPUT FORMAT section should list all 4 module options
    assert '"core"' in prompt
    assert '"gui"' in prompt
    assert '"shared"' in prompt
    assert '"host_runner"' in prompt


# ─────────────────────────────────────────────────────────────────────────────
# DiffPatchRequest schema
# ─────────────────────────────────────────────────────────────────────────────


def test_diff_patch_request_accepts_host_runner_content():
    req = dph.DiffPatchRequest(
        diff="some diff",
        core_content="core",
        gui_content="gui",
        shared_content="shared",
        host_runner_content="int main(){}",
    )
    assert req.host_runner_content == "int main(){}"


def test_diff_patch_request_host_runner_content_defaults_to_empty():
    # Pre-Phase-5 callers don't pass host_runner_content — it must
    # default to empty string for backward compat with the legacy
    # 3-module diff_patch flow.
    req = dph.DiffPatchRequest(
        diff="some diff",
        core_content="core",
        gui_content="gui",
        shared_content="shared",
    )
    assert req.host_runner_content == ""


def test_diff_patch_request_minimal_construction():
    # Only `diff` is required (everything else has defaults). Ensures
    # the schema doesn't accidentally make host_runner_content required.
    req = dph.DiffPatchRequest(diff="@@ -1 +1 @@\n-a\n+b\n")
    assert req.host_runner_content == ""
    assert req.core_content == ""


# ─────────────────────────────────────────────────────────────────────────────
# Realistic prompt assembly
# ─────────────────────────────────────────────────────────────────────────────


def test_realistic_prompt_with_host_runner_and_arch():
    req = make_diff_patch_request(
        diff="@@ -10,1 +10,1 @@\n-    SDL_CreateWindow(\"App\", 0, 0, 800, 600, 0);\n+    SDL_CreateWindow(\"App\", 0, 0, 1280, 720, 0);\n",
        core_content="// core content",
        gui_content="// gui content",
        shared_content="// shared content",
        host_runner_content='int main() {\n    SDL_Init(SDL_INIT_VIDEO);\n    SDL_CreateWindow("App", 0, 0, 800, 600, 0);\n    return 0;\n}\n',
        architecture="# Architecture\n## Where User Code Goes\n- Window setup → host_runner.cpp\n",
    )
    prompt = dph.build_full_diff_patch_prompt(req)
    # Architecture present
    assert "## Where User Code Goes" in prompt
    # host_runner block present with the actual SDL_CreateWindow line
    assert "SDL_CreateWindow(\"App\"" in prompt
    # Diff present at the bottom
    assert "1280, 720" in prompt
    # Critical rule 5 anchor (host_runner ownership)
    assert "host_runner" in prompt


def test_realistic_prompt_legacy_3_file_project_no_host_runner():
    req = make_diff_patch_request(
        diff="@@ -1 +1 @@\n-int x = 5;\n+int x = 6;\n",
        core_content="void core_on_update(State* s) { s->x = 5; }",
        gui_content="void gui_on_render(State* s) {}",
        shared_content="struct State { int x; };",
        host_runner_content="",
    )
    prompt = dph.build_full_diff_patch_prompt(req)
    # All 3 legacy blocks present
    assert "CURRENT core module content:" in prompt
    assert "CURRENT gui module content:" in prompt
    assert "CURRENT shared module content:" in prompt
    # host_runner block NOT present
    assert "CURRENT host_runner module content:" not in prompt
    # But the rule still mentions host_runner (so the AI knows about it)
    assert "host_runner" in prompt


# ─────────────────────────────────────────────────────────────────────────────
# Entrypoint
# ─────────────────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    print("\033[1mPhase 5 diff_patch prompt tests\033[0m")
    print()
    sys.exit(_run_tests())
