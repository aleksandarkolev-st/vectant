#!/usr/bin/env python3
"""
Unit tests for the generic include→link validator (ULTRAPLAN Phase 4.5).

Tests `extract_third_party_includes` and `validate_include_link_coverage`
in build_manifest.py. The whole point of the validator is to be
LIBRARY-AGNOSTIC — there is no library catalog. These tests cover
the spectrum of include shapes the AI might emit (or the user might
write), and confirm the rule fires when manifests miss flags AND
stays quiet when manifests are correct.

Run:
    python3 test_include_link_validator.py
    # or under pytest:
    pytest test_include_link_validator.py -v

No backend / network needed — pure offline unit tests.
"""
from __future__ import annotations

import sys

from build_manifest import (
    BuildManifest,
    ConfidenceBlock,
    ManifestRejection,
    extract_third_party_includes,
    validate_include_link_coverage,
)


# ─────────────────────────────────────────────────────────────────────────────
# Tiny test runner (no pytest dep — runs both standalone and under pytest)
# ─────────────────────────────────────────────────────────────────────────────


PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"


def _run_tests() -> int:
    """Walk module globals, run every callable starting with `test_`, count
    pass/fail. Returns process exit code: 0 on full pass, 1 on any fail.
    """
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


def make_manifest(
    runner_link_flags=None,
    gui_link_flags=None,
    notes: str = "",
) -> BuildManifest:
    """Build a minimal valid BuildManifest with custom link flags + notes.
    Other fields defaulted from the schema.
    """
    return BuildManifest(
        compiler="g++",
        std="c++17",
        common_flags=["-shared", "-fPIC"],
        core_link_flags=[],
        gui_link_flags=gui_link_flags or [],
        shared_link_flags=[],
        runner_link_flags=runner_link_flags or [],
        system_packages=[],
        hot_reload_mode="swap",
        confidence=ConfidenceBlock(
            overall="high",
            runner_synthesis="high",
            link_flags="high",
            notes=notes,
        ),
        build_steps=None,
    )


# ─────────────────────────────────────────────────────────────────────────────
# extract_third_party_includes — what counts as third-party
# ─────────────────────────────────────────────────────────────────────────────


def test_extract_skips_c_stdlib():
    src = """
    #include <stdio.h>
    #include <stdlib.h>
    #include <string.h>
    int main() { return 0; }
    """
    assert extract_third_party_includes(src) == []


def test_extract_skips_cpp_stdlib():
    src = """
    #include <iostream>
    #include <vector>
    #include <string>
    #include <memory>
    #include <filesystem>
    int main() { return 0; }
    """
    assert extract_third_party_includes(src) == []


def test_extract_skips_posix_headers():
    src = """
    #include <unistd.h>
    #include <sys/socket.h>
    #include <pthread.h>
    #include <dlfcn.h>
    int main() { return 0; }
    """
    assert extract_third_party_includes(src) == []


def test_extract_picks_up_sdl2_with_path_segment():
    src = """
    #include <stdio.h>
    #include <SDL2/SDL.h>
    int main() { SDL_Init(0); return 0; }
    """
    assert extract_third_party_includes(src) == ["SDL2"]


def test_extract_picks_up_bare_lib_header():
    src = """
    #include <fmod.h>
    #include <raylib.h>
    int main() { return 0; }
    """
    # Order preserved
    assert extract_third_party_includes(src) == ["fmod", "raylib"]


def test_extract_handles_quoted_includes():
    src = """
    #include "imgui.h"
    #include "stb_image.h"
    int main() { return 0; }
    """
    assert extract_third_party_includes(src) == ["imgui", "stb_image"]


def test_extract_dedupes_repeat_includes():
    src = """
    #include <SDL2/SDL.h>
    #include <SDL2/SDL_image.h>
    #include <SDL2/SDL_ttf.h>
    int main() { return 0; }
    """
    # All three normalise to "SDL2" → only one entry
    assert extract_third_party_includes(src) == ["SDL2"]


def test_extract_strips_block_comments():
    src = """
    /*
     * #include <fmod.h>     // commented out — must not trigger
     */
    #include <SDL2/SDL.h>
    int main() { return 0; }
    """
    assert extract_third_party_includes(src) == ["SDL2"]


def test_extract_handles_mixed_stdlib_and_third_party():
    src = """
    #include <iostream>
    #include <string>
    #include <SDL2/SDL.h>
    #include <vector>
    #include <fmod.h>
    int main() { return 0; }
    """
    # Order preserved, stdlib filtered
    assert extract_third_party_includes(src) == ["SDL2", "fmod"]


def test_extract_handles_indented_includes():
    src = """
        #include <SDL2/SDL.h>
       #  include  <fmod.h>
    int main() {}
    """
    assert extract_third_party_includes(src) == ["SDL2", "fmod"]


def test_extract_handles_glfw_with_subpath():
    src = """
    #include <GLFW/glfw3.h>
    #include <GL/gl.h>
    int main() { return 0; }
    """
    assert extract_third_party_includes(src) == ["GLFW", "GL"]


def test_extract_empty_source():
    assert extract_third_party_includes("") == []


def test_extract_source_with_no_includes():
    assert extract_third_party_includes("int main() { return 0; }") == []


# ─────────────────────────────────────────────────────────────────────────────
# validate_include_link_coverage — happy paths
# ─────────────────────────────────────────────────────────────────────────────


def test_validator_passes_stdlib_only_source():
    src = "#include <stdio.h>\nint main(){return 0;}"
    m = make_manifest()
    validate_include_link_coverage(m, src)  # must not raise


def test_validator_passes_sdl2_with_correct_flags():
    src = "#include <SDL2/SDL.h>\nint main(){SDL_Init(0); return 0;}"
    m = make_manifest(
        runner_link_flags=["-lSDL2", "-ldl"],
        gui_link_flags=["-lSDL2"],
    )
    validate_include_link_coverage(m, src)  # must not raise


def test_validator_passes_glfw_with_correct_flags():
    src = "#include <GLFW/glfw3.h>\nint main(){return 0;}"
    m = make_manifest(
        runner_link_flags=["-lglfw", "-ldl"],
        gui_link_flags=["-lglfw", "-lGL"],
    )
    validate_include_link_coverage(m, src)


def test_validator_passes_fmod_sdl_combo():
    src = """
    #include <SDL2/SDL.h>
    #include <fmod.h>
    int main() { return 0; }
    """
    m = make_manifest(
        runner_link_flags=["-lSDL2", "-lfmod", "-ldl"],
        gui_link_flags=["-lSDL2", "-lfmod"],
    )
    validate_include_link_coverage(m, src)


def test_validator_substring_match_handles_versioned_libs():
    # `-lwx_gtk3u_core-3.0` should satisfy `<wx/wx.h>` because "wx" is
    # a substring of "wx_gtk3u_core-3.0" (case-insensitive)
    src = "#include <wx/wx.h>\nint main(){}"
    m = make_manifest(
        runner_link_flags=["-lwx_gtk3u_core-3.0", "-ldl"],
        gui_link_flags=["-lwx_gtk3u_core-3.0"],
    )
    validate_include_link_coverage(m, src)


def test_validator_case_insensitive_match():
    src = "#include <SDL2/SDL.h>\nint main(){}"
    # Lowercase flag should still satisfy uppercase identifier
    m = make_manifest(
        runner_link_flags=["-lsdl2", "-ldl"],
        gui_link_flags=["-lsdl2"],
    )
    validate_include_link_coverage(m, src)


# ─────────────────────────────────────────────────────────────────────────────
# validate_include_link_coverage — rejection paths
# ─────────────────────────────────────────────────────────────────────────────


def test_validator_rejects_fmod_missing_from_runner_flags():
    # The exact bug we're trying to catch: source uses FMOD, gui has it,
    # runner does not. Pre-Phase-4.5 this slipped through; now must reject.
    src = """
    #include <SDL2/SDL.h>
    #include <fmod.h>
    int main() { return 0; }
    """
    m = make_manifest(
        runner_link_flags=["-lSDL2", "-ldl"],     # ← MISSING -lfmod
        gui_link_flags=["-lSDL2", "-lfmod"],
    )
    try:
        validate_include_link_coverage(m, src)
    except ManifestRejection as e:
        assert "fmod" in e.message.lower()
        assert "runner_link_flags" in e.message
        return
    raise AssertionError("expected ManifestRejection for missing -lfmod")


def test_validator_rejects_fmod_missing_from_gui_flags():
    src = "#include <fmod.h>\nint main() { return 0; }"
    m = make_manifest(
        runner_link_flags=["-lfmod", "-ldl"],
        gui_link_flags=[],  # ← MISSING -lfmod here
    )
    try:
        validate_include_link_coverage(m, src)
    except ManifestRejection as e:
        assert "fmod" in e.message.lower()
        assert "gui_link_flags" in e.message
        return
    raise AssertionError("expected ManifestRejection for missing gui flag")


def test_validator_rejects_when_no_link_flags_at_all():
    src = "#include <SDL2/SDL.h>\nint main(){}"
    m = make_manifest()  # both flag lists empty
    try:
        validate_include_link_coverage(m, src)
    except ManifestRejection as e:
        assert "SDL" in e.message
        return
    raise AssertionError("expected ManifestRejection when both flag lists are empty")


def test_validator_rejects_first_missing_include_only():
    # When multiple includes are missing flags, the validator should
    # raise on the FIRST one (so the AI can fix one at a time).
    src = """
    #include <SDL2/SDL.h>
    #include <fmod.h>
    int main() {}
    """
    m = make_manifest()  # nothing
    try:
        validate_include_link_coverage(m, src)
    except ManifestRejection as e:
        # Source order is SDL2 first, then fmod
        assert "SDL2" in e.message
        return
    raise AssertionError("expected ManifestRejection for first missing include")


# ─────────────────────────────────────────────────────────────────────────────
# Excuse via confidence.notes
# ─────────────────────────────────────────────────────────────────────────────


def test_validator_accepts_header_only_excuse():
    src = "#include <stb_image.h>\nint main(){}"
    # No link flag provided, but excused in notes
    m = make_manifest(
        notes="Header-only: stb_image.h (single-file header library, no .so)",
    )
    validate_include_link_coverage(m, src)  # must not raise


def test_validator_accepts_imgui_compiled_in_excuse():
    src = "#include <imgui.h>\nint main(){}"
    m = make_manifest(
        notes="Header-only: imgui sources compiled directly into gui module",
    )
    validate_include_link_coverage(m, src)


def test_validator_excuse_substring_match_is_lenient():
    # Excuse only needs to mention the identifier as substring
    src = "#include <fmod.h>\nint main(){}"
    m = make_manifest(
        notes="Skipping FMOD link flag — using FMOD's static archive instead.",
    )
    validate_include_link_coverage(m, src)


def test_validator_rejects_when_excuse_for_wrong_library():
    src = """
    #include <fmod.h>
    int main() {}
    """
    # Notes mention a DIFFERENT library — must NOT excuse fmod
    m = make_manifest(
        notes="Header-only: stb_image.h compiled inline",
    )
    try:
        validate_include_link_coverage(m, src)
    except ManifestRejection as e:
        assert "fmod" in e.message.lower()
        return
    raise AssertionError("excuse for unrelated library must not satisfy fmod")


# ─────────────────────────────────────────────────────────────────────────────
# Edge cases
# ─────────────────────────────────────────────────────────────────────────────


def test_validator_handles_empty_source():
    m = make_manifest()
    validate_include_link_coverage(m, "")  # must not raise


def test_validator_with_commented_out_include():
    # `#include <fmod.h>` inside a /* */ block must not trigger
    src = """
    /*
    #include <fmod.h>
    */
    #include <SDL2/SDL.h>
    int main(){}
    """
    m = make_manifest(
        runner_link_flags=["-lSDL2", "-ldl"],
        gui_link_flags=["-lSDL2"],
    )
    validate_include_link_coverage(m, src)


def test_validator_quoted_local_header_treated_as_third_party():
    # `#include "shared.h"` looks like a local file but the validator
    # has no way to distinguish — it'll try to satisfy "shared". User
    # should excuse it via notes if local.
    src = '#include "shared.h"\nint main(){}'
    m = make_manifest(
        notes="Local header: shared.h is project-local, not external",
    )
    validate_include_link_coverage(m, src)  # must not raise (excused)


def test_validator_message_includes_actionable_hint():
    src = "#include <raylib.h>\nint main(){}"
    m = make_manifest()
    try:
        validate_include_link_coverage(m, src)
    except ManifestRejection as e:
        # Message should include the identifier and at least one of the
        # actionable hints (link flag suggestion or notes excuse path)
        assert "raylib" in e.message
        assert "-lraylib" in e.message or "confidence.notes" in e.message
        return
    raise AssertionError("expected actionable rejection message")


# ─────────────────────────────────────────────────────────────────────────────
# Ordering invariants
# ─────────────────────────────────────────────────────────────────────────────


def test_extract_preserves_first_seen_order_with_dups():
    src = """
    #include <fmod.h>
    #include <SDL2/SDL.h>
    #include <fmod/core.h>
    """
    # fmod first, then SDL2; the second fmod is dedup'd
    assert extract_third_party_includes(src) == ["fmod", "SDL2"]


# ─────────────────────────────────────────────────────────────────────────────
# Entrypoint
# ─────────────────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    print("\033[1mInclude → Link Validator unit tests\033[0m")
    print()
    sys.exit(_run_tests())
