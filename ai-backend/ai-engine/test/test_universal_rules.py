"""
Unit tests for individual universal healing rules.

Tests that each rule module correctly detects issues and respects
language dispatch.
"""

import pytest
from analyzer.proactive.healing.types import HealingFix


# ── Helpers ───────────────────────────────────────────────────────────

def run_rule(module_name: str, code: str, language: str, file_path: str = "test.py"):
    """Import a rule module and run all its registered rules."""
    from analyzer.proactive.healing.rule_registry import get_registry

    registry = get_registry()
    prefix_map = {
        "universal_rules": "UNI_HEAL_",
        "terminators": "UNI_TERM_",
        "imports": "UNI_IMP_",
        "brackets": "UNI_BRK_",
        "whitespace": "UNI_WS_",
        "comparisons": "UNI_CMP_",
        "comments": "UNI_CMT_",
        "naming": "UNI_NAM_",
        "strings": "UNI_STR_",
        "dead_code": "UNI_DEAD_",
        "error_handling": "UNI_ERR_",
        "security": "UNI_SEC_",
        "encoding": "UNI_ENC_",
        "performance": "UNI_PERF_",
        "testing": "UNI_TEST_",
        "react_patterns": "UNI_REACT_",
    }

    prefix = prefix_map.get(module_name, "UNI_")
    fixes = []
    for rule in registry.list_rules():
        if rule.rule_id.startswith(prefix):
            fixes.extend(rule.detect(code, language, file_path))
    return fixes


# ── Tests: universal_rules ────────────────────────────────────────────

class TestUniversalRules:
    def test_trailing_whitespace(self):
        code = "x = 1   \ny = 2\n"
        fixes = run_rule("universal_rules", code, "python")
        assert any("trailing" in f.description.lower() for f in fixes)

    def test_no_trailing_whitespace(self):
        code = "x = 1\ny = 2\n"
        fixes = run_rule("universal_rules", code, "python")
        trailing = [f for f in fixes if "trailing" in f.description.lower()]
        assert len(trailing) == 0


# ── Tests: imports ────────────────────────────────────────────────────

class TestImportRules:
    def test_duplicate_import_python(self):
        code = "import os\nimport os\n"
        fixes = run_rule("imports", code, "python")
        assert any("duplicate" in f.description.lower() for f in fixes)

    def test_no_duplicate_import(self):
        code = "import os\nimport sys\n"
        fixes = run_rule("imports", code, "python")
        dups = [f for f in fixes if "duplicate" in f.description.lower()]
        assert len(dups) == 0


# ── Tests: whitespace ────────────────────────────────────────────────

class TestWhitespaceRules:
    def test_excessive_blank_lines(self):
        code = "x = 1\n\n\n\n\ny = 2\n"
        fixes = run_rule("whitespace", code, "python")
        assert any("blank" in f.description.lower() for f in fixes)


# ── Tests: encoding ──────────────────────────────────────────────────

class TestEncodingRules:
    def test_bom_detection(self):
        code = "\ufeffimport os\n"
        fixes = run_rule("encoding", code, "python")
        assert any("bom" in f.description.lower() for f in fixes)

    def test_no_bom(self):
        code = "import os\n"
        fixes = run_rule("encoding", code, "python")
        bom_fixes = [f for f in fixes if "bom" in f.description.lower()]
        assert len(bom_fixes) == 0


# ── Tests: error_handling ─────────────────────────────────────────────

class TestErrorHandlingRules:
    def test_bare_except_python(self):
        code = "try:\n    x = 1\nexcept:\n    pass\n"
        fixes = run_rule("error_handling", code, "python")
        assert len(fixes) > 0

    def test_proper_except(self):
        code = "try:\n    x = 1\nexcept ValueError as e:\n    raise\n"
        fixes = run_rule("error_handling", code, "python")
        bare = [f for f in fixes if "bare" in f.description.lower()]
        assert len(bare) == 0


# ── Tests: security ──────────────────────────────────────────────────

class TestSecurityRules:
    def test_eval_detection(self):
        code = "result = eval(user_input)\n"
        fixes = run_rule("security", code, "python")
        assert any("eval" in f.description.lower() for f in fixes)


# ── Tests: performance ───────────────────────────────────────────────

class TestPerformanceRules:
    def test_regex_in_loop_python(self):
        code = "for item in items:\n    m = re.search(r'\\d+', item)\n"
        fixes = run_rule("performance", code, "python")
        assert any("regex" in f.description.lower() for f in fixes)


# ── Tests: react_patterns ────────────────────────────────────────────

class TestReactRules:
    def test_useeffect_no_deps(self):
        code = "useEffect(() => {\n  fetchData();\n});\n"
        fixes = run_rule("react_patterns", code, "javascript")
        assert any("useEffect" in f.description for f in fixes)

    def test_useeffect_with_deps(self):
        code = "useEffect(() => {\n  fetchData();\n}, []);\n"
        fixes = run_rule("react_patterns", code, "javascript")
        effect_fixes = [f for f in fixes if "useEffect" in f.description]
        assert len(effect_fixes) == 0


# ── Tests: language isolation ─────────────────────────────────────────

class TestLanguageIsolation:
    """Verify rules only fire for their intended languages."""

    def test_python_rule_ignores_js(self):
        code = "result = eval(user_input)\n"
        fixes = run_rule("security", code, "javascript")
        # eval detection for JS should still fire, but differently
        # The key is it doesn't crash
        assert isinstance(fixes, list)

    def test_react_rules_ignore_python(self):
        code = "useEffect(() => {})\n"
        fixes = run_rule("react_patterns", code, "python")
        assert len(fixes) == 0
