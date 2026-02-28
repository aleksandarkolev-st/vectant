"""
Unit tests for the self-healing rule registry and universal rules.
"""

import pytest
from analyzer.proactive.healing.rule_registry import get_registry, HealingRuleRegistry
from analyzer.proactive.healing.types import HealingFix, HealingCategory


class TestRuleRegistry:
    """Tests for the healing rule registry."""

    def test_registry_singleton(self):
        r1 = get_registry()
        r2 = get_registry()
        assert r1 is r2

    def test_rules_registered(self):
        registry = get_registry()
        assert registry.rule_count > 0, "No rules registered"

    def test_all_rules_are_universal(self):
        """Every rule must have languages={'*'}."""
        registry = get_registry()
        for rule in registry.list_rules():
            assert "*" in rule.languages, (
                f"Rule {rule.rule_id} is not universal: languages={rule.languages}"
            )

    def test_all_rules_have_valid_ids(self):
        """Rule IDs must start with UNI_."""
        registry = get_registry()
        for rule in registry.list_rules():
            assert rule.rule_id.startswith("UNI_"), (
                f"Rule {rule.rule_id} does not follow UNI_ naming convention"
            )

    def test_no_duplicate_rule_ids(self):
        """No two rules should have the same ID."""
        registry = get_registry()
        ids = [r.rule_id for r in registry.list_rules()]
        assert len(ids) == len(set(ids)), (
            f"Duplicate rule IDs found: {[x for x in ids if ids.count(x) > 1]}"
        )

    def test_get_rules_for_language(self):
        """All rules should match every language since they are universal."""
        registry = get_registry()
        py_rules = registry.get_rules_for_language("python")
        js_rules = registry.get_rules_for_language("javascript")
        assert len(py_rules) == len(js_rules), (
            "Universal rules should return same count for all languages"
        )

    def test_enable_disable_rule(self):
        registry = get_registry()
        rules = registry.list_rules()
        if not rules:
            pytest.skip("No rules to test")
        rule = rules[0]
        original = rule.enabled

        rule.enabled = False
        assert registry.enabled_rule_count < registry.rule_count
        rule.enabled = original
