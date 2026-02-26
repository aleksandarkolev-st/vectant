"""
Healing Rule Registry

Central registry for all healing rules. Each rule detects a specific
type of micro-issue and produces a HealingFix. Rules are organized
by language and category.
"""

from __future__ import annotations

from typing import Callable, Dict, List, Optional, Set, Tuple, Type
from .types import HealingCategory, HealingFix


# Type alias for a healing rule function
# Takes (code: str, language: str, file_path: str) -> List[HealingFix]
HealingRuleFunc = Callable[[str, str, str], List[HealingFix]]


class HealingRule:
    """A single healing rule with metadata."""
    
    def __init__(
        self,
        rule_id: str,
        category: HealingCategory,
        languages: Set[str],
        detect_func: HealingRuleFunc,
        description: str = "",
        enabled: bool = True,
    ):
        self.rule_id = rule_id
        self.category = category
        self.languages = languages
        self.detect_func = detect_func
        self.description = description
        self.enabled = enabled
    
    def applies_to(self, language: str) -> bool:
        """Check if this rule applies to the given language."""
        if "*" in self.languages:
            return True
        return language.lower() in self.languages
    
    def detect(self, code: str, language: str, file_path: str = "") -> List[HealingFix]:
        """Run the detection function."""
        if not self.enabled:
            return []
        if not self.applies_to(language):
            return []
        fixes = self.detect_func(code, language, file_path)
        # Tag each fix with the rule ID
        for fix in fixes:
            fix.rule_id = self.rule_id
        return fixes


class HealingRuleRegistry:
    """
    Central registry for healing rules.
    
    Rules are registered at import time and can be queried by
    language or category.
    """
    
    _instance: Optional[HealingRuleRegistry] = None
    
    def __init__(self):
        self._rules: Dict[str, HealingRule] = {}
        self._by_category: Dict[HealingCategory, List[str]] = {}
        self._by_language: Dict[str, List[str]] = {}
    
    @classmethod
    def get_instance(cls) -> HealingRuleRegistry:
        """Get or create the singleton registry."""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance
    
    def register(self, rule: HealingRule) -> None:
        """Register a healing rule."""
        self._rules[rule.rule_id] = rule
        
        # Index by category
        if rule.category not in self._by_category:
            self._by_category[rule.category] = []
        self._by_category[rule.category].append(rule.rule_id)
        
        # Index by language
        for lang in rule.languages:
            if lang not in self._by_language:
                self._by_language[lang] = []
            self._by_language[lang].append(rule.rule_id)
    
    def get_rules_for_language(self, language: str) -> List[HealingRule]:
        """Get all rules that apply to the given language."""
        result = []
        for rule in self._rules.values():
            if rule.applies_to(language):
                result.append(rule)
        return result
    
    def get_rules_for_category(self, category: HealingCategory) -> List[HealingRule]:
        """Get all rules for a specific category."""
        rule_ids = self._by_category.get(category, [])
        return [self._rules[rid] for rid in rule_ids if rid in self._rules]
    
    def get_rule(self, rule_id: str) -> Optional[HealingRule]:
        """Get a specific rule by ID."""
        return self._rules.get(rule_id)
    
    def list_rules(self) -> List[HealingRule]:
        """List all registered rules."""
        return list(self._rules.values())
    
    def enable_rule(self, rule_id: str) -> None:
        """Enable a specific rule."""
        if rule_id in self._rules:
            self._rules[rule_id].enabled = True
    
    def disable_rule(self, rule_id: str) -> None:
        """Disable a specific rule."""
        if rule_id in self._rules:
            self._rules[rule_id].enabled = False
    
    @property
    def rule_count(self) -> int:
        return len(self._rules)
    
    @property
    def enabled_rule_count(self) -> int:
        return sum(1 for r in self._rules.values() if r.enabled)


def healing_rule(
    rule_id: str,
    category: HealingCategory,
    languages: Set[str],
    description: str = "",
):
    """Decorator to register a function as a healing rule."""
    def decorator(func: HealingRuleFunc) -> HealingRuleFunc:
        rule = HealingRule(
            rule_id=rule_id,
            category=category,
            languages=languages,
            detect_func=func,
            description=description,
        )
        HealingRuleRegistry.get_instance().register(rule)
        return func
    return decorator


def get_registry() -> HealingRuleRegistry:
    """Get the global healing rule registry."""
    return HealingRuleRegistry.get_instance()
