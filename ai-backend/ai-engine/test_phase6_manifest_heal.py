#!/usr/bin/env python3
"""
Phase 6 (ULTRAPLAN) — manifest heal prompt + response parser tests.

Covers the library-agnostic pieces that can be tested offline:

  - `build_manifest_heal_prompt` contains NO library names (anti-hardcoding)
  - prompt includes the symbols, source excerpt, manifest, failed_module
  - `VALID_FAILED_MODULES` set membership
  - `parse_heal_manifest_response`: happy path, unchanged-true path,
    markdown fence stripping, malformed JSON, missing fields, wrong types
  - `HealManifestRequest` schema shape
  - `HealManifestResponse` schema shape

Tests that require a live AI (actual heal retry end-to-end) are out
of scope for offline unit tests — covered by Phase 7's corpus against
the running ai-engine instead.

Run:
    python3 test_phase6_manifest_heal.py
"""
from __future__ import annotations

import sys

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


def make_manifest(
    runner_link_flags=None,
    gui_link_flags=None,
    core_link_flags=None,
    notes: str = "Standard project",
):
    return {
        "compiler": "g++",
        "std": "c++17",
        "common_flags": ["-shared", "-fPIC"],
        "core_link_flags": core_link_flags or [],
        "gui_link_flags": gui_link_flags or [],
        "shared_link_flags": [],
        "runner_link_flags": runner_link_flags or [],
        "system_packages": [],
        "hot_reload_mode": "swap",
        "confidence": {
            "overall": "high",
            "runner_synthesis": "high",
            "link_flags": "high",
            "notes": notes,
        },
    }


def make_heal_request(
    symbols=None,
    failed_module="host_runner",
    source_excerpt="#include <fmod.h>\nint main(){ FMOD_System_Create(nullptr); return 0; }",
    current_manifest=None,
    architecture=None,
):
    return dph.HealManifestRequest(
        current_manifest=current_manifest or make_manifest(runner_link_flags=["-lSDL2", "-ldl"]),
        undefined_symbols=symbols or ["FMOD_System_Create"],
        source_excerpt=source_excerpt,
        failed_module=failed_module,
        architecture=architecture,
    )


# ─────────────────────────────────────────────────────────────────────────────
# VALID_FAILED_MODULES
# ─────────────────────────────────────────────────────────────────────────────


def test_valid_failed_modules_contains_all_four_stages():
    assert "core" in dph.VALID_FAILED_MODULES
    assert "gui" in dph.VALID_FAILED_MODULES
    assert "shared" in dph.VALID_FAILED_MODULES
    assert "host_runner" in dph.VALID_FAILED_MODULES


def test_valid_failed_modules_rejects_random_strings():
    assert "main" not in dph.VALID_FAILED_MODULES
    assert "runner" not in dph.VALID_FAILED_MODULES
    assert "" not in dph.VALID_FAILED_MODULES


# ─────────────────────────────────────────────────────────────────────────────
# Anti-hardcoding guarantee: no library names in the prompt
# ─────────────────────────────────────────────────────────────────────────────


def test_prompt_contains_no_library_names_in_template():
    """The prompt TEMPLATE must not reference any specific library by
    name — that's the core anti-hardcoding invariant of Phase 6.

    Strategy: build the prompt with a deliberately FAKE library
    (`ACME_`) so any real library name in the output must have come
    from the template, not the interpolated inputs. Then check the
    prompt doesn't contain common real library names.
    """
    fake_manifest = {
        "compiler": "g++",
        "std": "c++17",
        "common_flags": ["-shared", "-fPIC"],
        "core_link_flags": [],
        "gui_link_flags": ["-lacme"],
        "shared_link_flags": [],
        "runner_link_flags": ["-lacme", "-ldl"],
        "system_packages": [],
        "hot_reload_mode": "swap",
        "confidence": {
            "overall": "high",
            "runner_synthesis": "high",
            "link_flags": "high",
            "notes": "Acme test project",
        },
    }
    req = dph.HealManifestRequest(
        current_manifest=fake_manifest,
        undefined_symbols=["ACME_Init", "ACME_Shutdown"],
        source_excerpt="#include <acme.h>\nint main(){ ACME_Init(); return 0; }",
        failed_module="host_runner",
    )
    prompt = dph.build_manifest_heal_prompt(req)
    # Verify our fake inputs DO appear (sanity check that the prompt
    # builder actually uses them)
    assert "ACME_Init" in prompt
    assert "acme.h" in prompt

    lower = prompt.lower()
    # These real library names must NEVER appear in the prompt template.
    # Since our inputs don't mention any of them, their presence would
    # mean the template itself is hardcoding library knowledge.
    for forbidden in (
        "sdl2",
        "sdl_",
        "glfw",
        "fmod",
        "raylib",
        "sokol",
        "wxwidgets",
        "openal",
        "juce",
        "-lsdl",
        "-lglfw",
        "-lfmod",
    ):
        assert forbidden not in lower, (
            f"prompt template leaks library name: {forbidden!r}"
        )


def test_prompt_uses_placeholder_syntax_in_examples():
    req = make_heal_request()
    prompt = dph.build_manifest_heal_prompt(req)
    # Examples in the prompt should use placeholder syntax like `<name>`
    # rather than naming specific libraries. Check the prompt has at
    # least one placeholder marker.
    assert "<some-lib>" in prompt or "<one-sentence" in prompt or "<name>" in prompt


def test_prompt_does_not_contain_hardcoded_symbol_prefix_table():
    """Regression trap: if someone adds a lookup table like
        FMOD_* -> -lfmod
        SDL_* -> -lSDL2
    to the prompt, this check catches it. Uses a fake library in the
    inputs so real library mentions must come from the template only.
    """
    fake_manifest = {
        "compiler": "g++",
        "std": "c++17",
        "common_flags": [],
        "core_link_flags": [],
        "gui_link_flags": [],
        "shared_link_flags": [],
        "runner_link_flags": [],
        "system_packages": [],
        "hot_reload_mode": "swap",
        "confidence": {
            "overall": "high",
            "runner_synthesis": "high",
            "link_flags": "high",
            "notes": "",
        },
    }
    req = dph.HealManifestRequest(
        current_manifest=fake_manifest,
        undefined_symbols=["ACME_Init"],
        source_excerpt="int main(){}",
        failed_module="core",
    )
    prompt = dph.build_manifest_heal_prompt(req)
    lower = prompt.lower()
    # Symbol-prefix wildcards that would indicate a hardcoded table
    assert "fmod_" not in lower
    assert "sdl_" not in lower
    assert "glfw_" not in lower
    assert "raylib_" not in lower


# ─────────────────────────────────────────────────────────────────────────────
# Prompt content
# ─────────────────────────────────────────────────────────────────────────────


def test_prompt_includes_undefined_symbols_list():
    req = make_heal_request(symbols=["FMOD_System_Create", "FMOD_System_Init"])
    prompt = dph.build_manifest_heal_prompt(req)
    assert "FMOD_System_Create" in prompt
    assert "FMOD_System_Init" in prompt


def test_prompt_includes_source_excerpt():
    req = make_heal_request(
        source_excerpt='#include <fmod.h>\nint main(){ FMOD_System_Create(nullptr); return 0; }'
    )
    prompt = dph.build_manifest_heal_prompt(req)
    assert "#include <fmod.h>" in prompt
    assert "FMOD_System_Create(nullptr)" in prompt


def test_prompt_includes_current_manifest_as_json():
    manifest = make_manifest(
        runner_link_flags=["-lSDL2", "-ldl"],
        gui_link_flags=["-lSDL2"],
    )
    req = make_heal_request(current_manifest=manifest)
    prompt = dph.build_manifest_heal_prompt(req)
    # Manifest JSON should appear in the prompt
    assert '"compiler": "g++"' in prompt
    assert "-lSDL2" in prompt


def test_prompt_states_failed_module_clearly():
    for module in ("core", "gui", "shared", "host_runner"):
        req = make_heal_request(failed_module=module)
        prompt = dph.build_manifest_heal_prompt(req)
        assert f"FAILED COMPILE STAGE: {module}" in prompt


def test_prompt_includes_architecture_when_provided():
    req = make_heal_request(
        architecture="# Architecture\n## Where User Code Goes\n- audio → core",
    )
    prompt = dph.build_manifest_heal_prompt(req)
    assert "Where User Code Goes" in prompt


def test_prompt_omits_architecture_section_when_none():
    req = make_heal_request(architecture=None)
    prompt = dph.build_manifest_heal_prompt(req)
    assert "ARCHITECTURE CACHE" not in prompt


def test_prompt_omits_architecture_section_when_empty():
    req = make_heal_request(architecture="   \n  ")
    prompt = dph.build_manifest_heal_prompt(req)
    assert "ARCHITECTURE CACHE" not in prompt


def test_prompt_instructs_ai_to_preserve_existing_flags():
    req = make_heal_request()
    prompt = dph.build_manifest_heal_prompt(req)
    # The rules section must tell the AI to PRESERVE existing flags
    # (not replace them) — otherwise we'd lose -lSDL2 when adding -lfmod.
    lower = prompt.lower()
    assert "preserve" in lower or "keep" in lower


def test_prompt_instructs_ai_to_return_unchanged_when_stuck():
    req = make_heal_request()
    prompt = dph.build_manifest_heal_prompt(req)
    # The escape hatch: if AI can't infer the library, set unchanged=true
    assert "unchanged" in prompt.lower()


def test_prompt_warns_against_removing_flags():
    req = make_heal_request()
    prompt = dph.build_manifest_heal_prompt(req)
    lower = prompt.lower()
    assert "do not remove" in lower or "do not drop" in lower or "conservative" in lower


# ─────────────────────────────────────────────────────────────────────────────
# HealManifestRequest schema
# ─────────────────────────────────────────────────────────────────────────────


def test_heal_request_minimal_construction():
    req = dph.HealManifestRequest(
        current_manifest=make_manifest(),
        undefined_symbols=["SDL_Init"],
        source_excerpt="#include <SDL2/SDL.h>",
        failed_module="core",
    )
    assert req.failed_module == "core"
    assert req.undefined_symbols == ["SDL_Init"]
    assert req.architecture is None


def test_heal_request_with_architecture():
    req = dph.HealManifestRequest(
        current_manifest=make_manifest(),
        undefined_symbols=["X"],
        source_excerpt="",
        failed_module="gui",
        architecture="# Arch doc",
    )
    assert req.architecture == "# Arch doc"


# ─────────────────────────────────────────────────────────────────────────────
# parse_heal_manifest_response — happy path + edge cases
# ─────────────────────────────────────────────────────────────────────────────


def test_parse_response_happy_path():
    raw = """{
        "updated_manifest": {
            "compiler": "g++",
            "std": "c++17",
            "runner_link_flags": ["-lSDL2", "-lfmod", "-ldl"]
        },
        "unchanged": false,
        "notes": "Added -lfmod to runner_link_flags for FMOD_System_Create"
    }"""
    resp = dph.parse_heal_manifest_response(raw)
    assert resp.updated_manifest["runner_link_flags"] == ["-lSDL2", "-lfmod", "-ldl"]
    assert resp.unchanged is False
    assert "fmod" in resp.notes.lower()


def test_parse_response_unchanged_true():
    raw = """{
        "updated_manifest": {"compiler": "g++"},
        "unchanged": true,
        "notes": "Could not determine library for symbol 'mystery_sym'"
    }"""
    resp = dph.parse_heal_manifest_response(raw)
    assert resp.unchanged is True


def test_parse_response_strips_markdown_json_fence():
    raw = """```json
{
    "updated_manifest": {"compiler": "g++"},
    "unchanged": false,
    "notes": ""
}
```"""
    resp = dph.parse_heal_manifest_response(raw)
    assert resp.updated_manifest == {"compiler": "g++"}


def test_parse_response_strips_bare_markdown_fence():
    raw = """```
{
    "updated_manifest": {"compiler": "g++"},
    "unchanged": false,
    "notes": ""
}
```"""
    resp = dph.parse_heal_manifest_response(raw)
    assert resp.updated_manifest == {"compiler": "g++"}


def test_parse_response_notes_defaults_to_empty():
    raw = """{
        "updated_manifest": {"compiler": "g++"},
        "unchanged": false
    }"""
    resp = dph.parse_heal_manifest_response(raw)
    assert resp.notes == ""


def test_parse_response_unchanged_defaults_to_false():
    raw = """{
        "updated_manifest": {"compiler": "g++"},
        "notes": "whatever"
    }"""
    resp = dph.parse_heal_manifest_response(raw)
    assert resp.unchanged is False


def test_parse_response_rejects_missing_updated_manifest():
    raw = """{"unchanged": false, "notes": "x"}"""
    try:
        dph.parse_heal_manifest_response(raw)
    except ValueError as e:
        assert "updated_manifest" in str(e)
        return
    raise AssertionError("expected ValueError for missing updated_manifest")


def test_parse_response_rejects_malformed_json():
    raw = "this is not json"
    try:
        dph.parse_heal_manifest_response(raw)
    except ValueError as e:
        assert "JSON" in str(e) or "json" in str(e).lower()
        return
    raise AssertionError("expected ValueError for malformed JSON")


def test_parse_response_rejects_non_dict_top_level():
    raw = "[1, 2, 3]"
    try:
        dph.parse_heal_manifest_response(raw)
    except ValueError as e:
        assert "object" in str(e)
        return
    raise AssertionError("expected ValueError for non-dict top level")


def test_parse_response_rejects_non_dict_updated_manifest():
    raw = """{"updated_manifest": "not a dict", "unchanged": false}"""
    try:
        dph.parse_heal_manifest_response(raw)
    except ValueError as e:
        assert "updated_manifest" in str(e)
        return
    raise AssertionError("expected ValueError for non-dict updated_manifest")


def test_parse_response_handles_extra_fields_in_response():
    # If the AI returns extra top-level fields, parser should ignore them.
    raw = """{
        "updated_manifest": {"compiler": "g++"},
        "unchanged": false,
        "notes": "",
        "debug_info": "something",
        "extra_field": 42
    }"""
    resp = dph.parse_heal_manifest_response(raw)
    assert resp.updated_manifest == {"compiler": "g++"}


# ─────────────────────────────────────────────────────────────────────────────
# Entrypoint
# ─────────────────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    print("\033[1mPhase 6 manifest heal — prompt + parser tests\033[0m")
    print()
    sys.exit(_run_tests())
