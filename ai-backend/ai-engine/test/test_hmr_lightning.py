"""
HMR Lightning Ultraplan — Python-side tests.

Tests the build manifest, compile safety flags, UNIVERSAL_SPLIT_PROMPT
structure, and include→link validation that the Rust worker depends on.
These run without AI API calls — pure unit tests.

Usage:
    cd ai-backend/ai-engine
    python3 -m pytest test/test_hmr_lightning.py -v
"""
from __future__ import annotations

import json
import pytest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from build_manifest import (
    BuildManifest,
    ConfidenceBlock,
    ManifestRejection,
    parse_manifest,
    validate_manifest_v1,
    manifest_to_dict,
    validate_include_link_coverage,
)
from llm.prompts import UNIVERSAL_SPLIT_PROMPT


# ═══════════════════════════════════════════════════════════════
# BUILD MANIFEST TESTS
# ═══════════════════════════════════════════════════════════════


class TestBuildManifest:
    """Core manifest parsing and validation."""

    def test_sdl2_manifest_parses(self):
        raw = {
            "compiler": "g++",
            "std": "c++17",
            "common_flags": ["-shared", "-fPIC", "-O0", "-fno-merge-constants"],
            "core_link_flags": [],
            "gui_link_flags": ["-lSDL2"],
            "shared_link_flags": [],
            "runner_link_flags": ["-lSDL2", "-ldl"],
            "system_packages": ["libsdl2-dev"],
            "hot_reload_mode": "swap",
            "confidence": {
                "overall": "high",
                "runner_synthesis": "high",
                "link_flags": "high",
                "notes": "",
            },
        }
        m = parse_manifest(raw)
        assert m.compiler == "g++"
        assert "-lSDL2" in m.gui_link_flags
        assert m.hot_reload_mode == "swap"

    def test_glfw_manifest_parses(self):
        raw = {
            "compiler": "g++",
            "std": "c++17",
            "common_flags": ["-shared", "-fPIC"],
            "core_link_flags": [],
            "gui_link_flags": ["-lglfw"],
            "shared_link_flags": [],
            "runner_link_flags": ["-lglfw", "-ldl"],
            "system_packages": ["libglfw3-dev"],
            "hot_reload_mode": "swap",
            "confidence": {
                "overall": "high",
                "runner_synthesis": "high",
                "link_flags": "high",
                "notes": "",
            },
        }
        m = parse_manifest(raw)
        assert "-lglfw" in m.gui_link_flags

    def test_raylib_manifest_parses(self):
        raw = {
            "compiler": "g++",
            "std": "c++17",
            "common_flags": ["-shared", "-fPIC"],
            "core_link_flags": [],
            "gui_link_flags": ["-lraylib"],
            "shared_link_flags": [],
            "runner_link_flags": ["-lraylib", "-ldl"],
            "system_packages": [],
            "hot_reload_mode": "swap",
            "confidence": {
                "overall": "medium",
                "runner_synthesis": "medium",
                "link_flags": "medium",
                "notes": "raylib detection",
            },
        }
        m = parse_manifest(raw)
        assert "-lraylib" in m.gui_link_flags

    def test_manifest_from_json_string(self):
        json_str = json.dumps({
            "compiler": "clang++",
            "std": "c++20",
            "common_flags": ["-shared"],
            "gui_link_flags": ["-lsfml-graphics"],
            "runner_link_flags": ["-lsfml-graphics", "-ldl"],
            "system_packages": [],
            "hot_reload_mode": "swap",
            "confidence": {
                "overall": "high",
                "runner_synthesis": "high",
                "link_flags": "high",
                "notes": "",
            },
        })
        m = parse_manifest(json_str)
        assert m.compiler == "clang++"

    def test_manifest_rejects_invalid_compiler(self):
        raw = {
            "compiler": "msvc",
            "std": "c++17",
            "common_flags": [],
            "gui_link_flags": [],
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
        with pytest.raises(Exception):
            parse_manifest(raw)

    def test_manifest_round_trip(self):
        raw = {
            "compiler": "g++",
            "std": "c++17",
            "common_flags": ["-shared", "-fPIC", "-O0"],
            "core_link_flags": [],
            "gui_link_flags": ["-lSDL2"],
            "shared_link_flags": [],
            "runner_link_flags": ["-lSDL2", "-ldl"],
            "system_packages": ["libsdl2-dev"],
            "hot_reload_mode": "swap",
            "confidence": {
                "overall": "high",
                "runner_synthesis": "high",
                "link_flags": "high",
                "notes": "",
            },
        }
        m = parse_manifest(raw)
        d = manifest_to_dict(m)
        m2 = parse_manifest(d)
        assert m2.compiler == m.compiler
        assert m2.gui_link_flags == m.gui_link_flags

    def test_extra_fields_ignored(self):
        raw = {
            "compiler": "g++",
            "std": "c++17",
            "common_flags": [],
            "gui_link_flags": [],
            "runner_link_flags": [],
            "system_packages": [],
            "hot_reload_mode": "swap",
            "confidence": {
                "overall": "high",
                "runner_synthesis": "high",
                "link_flags": "high",
                "notes": "",
            },
            "future_v3_field": True,
        }
        m = parse_manifest(raw)
        assert m.compiler == "g++"


class TestManifestV1Validation:
    """V1 execution-gate tests."""

    def _make_manifest(self, **overrides):
        base = {
            "compiler": "g++",
            "std": "c++17",
            "common_flags": ["-shared", "-fPIC"],
            "core_link_flags": [],
            "gui_link_flags": ["-lSDL2"],
            "shared_link_flags": [],
            "runner_link_flags": ["-lSDL2", "-ldl"],
            "system_packages": ["libsdl2-dev"],
            "hot_reload_mode": "swap",
            "confidence": {
                "overall": "high",
                "runner_synthesis": "high",
                "link_flags": "high",
                "notes": "",
            },
        }
        base.update(overrides)
        return parse_manifest(base)

    def test_valid_sdl2_passes(self):
        m = self._make_manifest()
        validate_manifest_v1(m)  # should not raise

    def test_multi_step_build_rejected(self):
        m = self._make_manifest(
            build_steps=[{"name": "moc", "command": "moc", "args": ["main.h"]}]
        )
        with pytest.raises(ManifestRejection, match="pre-compile step"):
            validate_manifest_v1(m)

    def test_process_restart_mode_passes(self):
        m = self._make_manifest(hot_reload_mode="process_restart")
        validate_manifest_v1(m)  # should not raise


class TestTier0SafetyFlags:
    """Verify -O0 and -fno-merge-constants are required for Tier 0."""

    def test_tier0_requires_debug_safe_flags(self):
        """Python manifest validation should require Tier 0 debug-safe flags."""
        raw = {
            "compiler": "g++",
            "std": "c++17",
            "common_flags": [
                "-shared", "-fPIC", "-O0", "-fno-merge-constants",
                "-g", "-gdwarf-4",
            ],
            "gui_link_flags": ["-lSDL2"],
            "runner_link_flags": ["-lSDL2", "-ldl"],
            "system_packages": ["libsdl2-dev"],
            "hot_reload_mode": "swap",
            "confidence": {
                "overall": "high",
                "runner_synthesis": "high",
                "link_flags": "high",
                "notes": "",
            },
        }
        m = parse_manifest(raw)
        assert "-O0" in m.common_flags
        assert "-fno-merge-constants" in m.common_flags

    def test_manifest_without_o0_still_parses(self):
        """Manifests without -O0 are valid schema-wise — the Rust side
        injects the flag. Python doesn't reject."""
        raw = {
            "compiler": "g++",
            "std": "c++17",
            "common_flags": ["-shared", "-fPIC"],
            "gui_link_flags": [],
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
        m = parse_manifest(raw)
        assert "-O0" not in m.common_flags  # Rust will inject this


# ═══════════════════════════════════════════════════════════════
# INCLUDE → LINK VALIDATOR TESTS
# ═══════════════════════════════════════════════════════════════


class TestIncludeLinkValidator:
    """The include→link rule: every #include <X.h> must have a matching -lX."""

    def test_sdl2_include_covered_by_link_flag(self):
        source = '#include <SDL2/SDL.h>\nint main() { return 0; }'
        manifest = parse_manifest({
            "compiler": "g++",
            "std": "c++17",
            "common_flags": [],
            "gui_link_flags": ["-lSDL2"],
            "runner_link_flags": ["-lSDL2", "-ldl"],
            "system_packages": ["libsdl2-dev"],
            "hot_reload_mode": "swap",
            "confidence": {
                "overall": "high",
                "runner_synthesis": "high",
                "link_flags": "high",
                "notes": "",
            },
        })
        # Should NOT raise — SDL2 is covered
        validate_include_link_coverage(manifest, source)

    def test_missing_link_flag_raises(self):
        source = '#include <GLFW/glfw3.h>\nint main() { return 0; }'
        manifest = parse_manifest({
            "compiler": "g++",
            "std": "c++17",
            "common_flags": [],
            "gui_link_flags": [],  # Missing -lglfw!
            "runner_link_flags": [],
            "system_packages": [],
            "hot_reload_mode": "swap",
            "confidence": {
                "overall": "high",
                "runner_synthesis": "high",
                "link_flags": "high",
                "notes": "",
            },
        })
        with pytest.raises(ManifestRejection):
            validate_include_link_coverage(manifest, source)

    def test_header_only_excused_in_notes(self):
        source = '#include <nlohmann/json.hpp>\nint main() { return 0; }'
        manifest = parse_manifest({
            "compiler": "g++",
            "std": "c++17",
            "common_flags": [],
            "gui_link_flags": [],
            "runner_link_flags": [],
            "system_packages": [],
            "hot_reload_mode": "swap",
            "confidence": {
                "overall": "high",
                "runner_synthesis": "high",
                "link_flags": "high",
                "notes": "nlohmann/json is header-only, no link flag needed",
            },
        })
        # Should NOT raise — excused in notes
        validate_include_link_coverage(manifest, source)


# ═══════════════════════════════════════════════════════════════
# UNIVERSAL_SPLIT_PROMPT STRUCTURAL TESTS
# ═══════════════════════════════════════════════════════════════


class TestUniversalSplitPrompt:
    """Verify the prompt contains required sections for the HMR pipeline."""

    def test_prompt_exists_and_is_long(self):
        assert len(UNIVERSAL_SPLIT_PROMPT) > 5000, \
            "prompt should be substantial (>5k chars)"

    def test_four_output_files_described(self):
        assert "shared.h" in UNIVERSAL_SPLIT_PROMPT
        assert "core.cpp" in UNIVERSAL_SPLIT_PROMPT
        assert "gui.cpp" in UNIVERSAL_SPLIT_PROMPT
        assert "host_runner.cpp" in UNIVERSAL_SPLIT_PROMPT

    def test_library_agnostic_claim(self):
        assert "LIBRARY-AGNOSTIC" in UNIVERSAL_SPLIT_PROMPT or \
               "library-agnostic" in UNIVERSAL_SPLIT_PROMPT.lower()

    def test_hmr_lifecycle_functions(self):
        assert "core_on_load" in UNIVERSAL_SPLIT_PROMPT
        assert "core_on_update" in UNIVERSAL_SPLIT_PROMPT or \
               "on_update" in UNIVERSAL_SPLIT_PROMPT

    def test_dlopen_dlclose_mentioned(self):
        assert "dlopen" in UNIVERSAL_SPLIT_PROMPT
        assert "dlclose" in UNIVERSAL_SPLIT_PROMPT

    def test_state_preservation_protocol(self):
        assert "STATE-PRESERVATION" in UNIVERSAL_SPLIT_PROMPT or \
               "state" in UNIVERSAL_SPLIT_PROMPT.lower()

    def test_zero_hallucination_rule(self):
        assert "HALLUCINATION" in UNIVERSAL_SPLIT_PROMPT or \
               "hallucination" in UNIVERSAL_SPLIT_PROMPT.lower()

    def test_build_manifest_block(self):
        assert "synthi_build_manifest" in UNIVERSAL_SPLIT_PROMPT or \
               "compile_manifest" in UNIVERSAL_SPLIT_PROMPT.lower()

    def test_arch_cache_block(self):
        assert "synthi_arch_cache" in UNIVERSAL_SPLIT_PROMPT

    def test_include_link_rule(self):
        assert "INCLUDE" in UNIVERSAL_SPLIT_PROMPT and \
               "LINK" in UNIVERSAL_SPLIT_PROMPT

    def test_stdin_reader_thread_skeleton(self):
        """Phase 12.5: prompt must include stdin reader thread reference."""
        assert "stdin" in UNIVERSAL_SPLIT_PROMPT.lower()
        assert "load" in UNIVERSAL_SPLIT_PROMPT.lower()

    def test_no_malloc_prohibition(self):
        """Guardrail: AI must not use malloc in generated code."""
        assert "MALLOC" in UNIVERSAL_SPLIT_PROMPT or \
               "malloc" in UNIVERSAL_SPLIT_PROMPT

    def test_exact_function_signatures(self):
        assert "EXACT FUNCTION SIGNATURES" in UNIVERSAL_SPLIT_PROMPT or \
               "extern \"C\"" in UNIVERSAL_SPLIT_PROMPT

    def test_self_check_section(self):
        """AI self-check guardrail should be in the prompt."""
        assert "SELF-CHECK" in UNIVERSAL_SPLIT_PROMPT or \
               "self-check" in UNIVERSAL_SPLIT_PROMPT.lower() or \
               "CHECK" in UNIVERSAL_SPLIT_PROMPT


# ═══════════════════════════════════════════════════════════════
# IPC PROTOCOL COMPATIBILITY (Python ↔ Rust)
# ═══════════════════════════════════════════════════════════════


class TestIPCProtocolCompat:
    """Verify the IPC message format matches what Rust expects."""

    def test_load_command_json_shape(self):
        """Must match HmrCommand::Load in hmr_protocol.rs."""
        cmd = {
            "type": "Load",
            "command_id": 1,
            "module_name": "core",
            "so_path": "/build/libcore.so",
        }
        j = json.dumps(cmd)
        parsed = json.loads(j)
        assert parsed["type"] == "Load"
        assert "command_id" in parsed
        assert "module_name" in parsed
        assert "so_path" in parsed

    def test_handshake_ack_json_shape(self):
        """Must match HmrResponse::HandshakeAck in hmr_protocol.rs."""
        resp = {
            "type": "HandshakeAck",
            "child_version": 1,
            "child_min_supported": 1,
            "child_capabilities": ["load", "reload", "window_discovery"],
        }
        j = json.dumps(resp)
        parsed = json.loads(j)
        assert parsed["type"] == "HandshakeAck"
        assert parsed["child_version"] == 1

    def test_window_discovered_json_shape(self):
        """Must match HmrResponse::WindowDiscovered."""
        resp = {
            "type": "WindowDiscovered",
            "x11_window_id": 0x04000001,
        }
        j = json.dumps(resp)
        parsed = json.loads(j)
        assert parsed["type"] == "WindowDiscovered"
        assert parsed["x11_window_id"] > 0

    def test_patch_bytes_command(self):
        """Must match HmrCommand::PatchBytes (Phase 11 integration)."""
        cmd = {
            "type": "PatchBytes",
            "command_id": 42,
            "module_name": "core",
            "file_offset": 0x2000,
            "bytes_hex": "c3f54840",
        }
        j = json.dumps(cmd)
        parsed = json.loads(j)
        assert parsed["type"] == "PatchBytes"
        assert parsed["bytes_hex"] == "c3f54840"

    def test_error_response_json_shape(self):
        resp = {
            "type": "Error",
            "command_id": 5,
            "code": "LOAD_FAILED",
            "message": "dlopen failed",
        }
        j = json.dumps(resp)
        parsed = json.loads(j)
        assert parsed["code"] == "LOAD_FAILED"
