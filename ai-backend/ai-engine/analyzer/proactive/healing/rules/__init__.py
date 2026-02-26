"""
Healing rules package.

ALL rules are universal — each rule handles every language from a single
entry point, dispatching internally based on the `language` parameter.
No language-specific rule files exist. This ensures every rule works
across all supported languages.

Import all rule modules here to trigger registration via @healing_rule decorator.
"""

from . import universal_rules
from . import terminators
