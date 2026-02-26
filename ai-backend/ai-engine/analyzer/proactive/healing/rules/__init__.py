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
from . import imports
from . import brackets
from . import comparisons
from . import whitespace
from . import comments
from . import naming
from . import strings
from . import dead_code
from . import type_hints
from . import error_handling
from . import operators
from . import line_length
from . import returns
from . import variables
from . import loops
from . import conditionals
from . import logging_debug
