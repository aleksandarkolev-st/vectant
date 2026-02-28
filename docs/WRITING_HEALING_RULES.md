# Writing Universal Healing Rules

This guide explains how to add new rules to the Synthi self-healing system.

## Rule Structure

Every rule module lives in:
```
ai-backend/ai-engine/analyzer/proactive/healing/rules/
```

Each module contains one or more rule functions decorated with `@healing_rule`.

## Template

```python
"""
Universal healing rule: <Category Name>.
"""

from __future__ import annotations

import re
from typing import List

from ..types import (
    HealingCategory,
    HealingSeverity,
    HealingAction,
    HealingFix,
)
from ..rule_registry import healing_rule


# Language sets for internal dispatch
_PY_LANGS = {"python", "py"}
_JS_LANGS = {"javascript", "js", "jsx", "typescript", "ts", "tsx"}


@healing_rule(
    rule_id="UNI_XXX_001",                          # Unique ID
    category=HealingCategory.TRAILING_WHITESPACE,    # From enum
    description="Short human-readable description",
)
def detect_something(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Docstring explaining what this rule detects."""
    lang = language.lower()
    
    # Language dispatch — return empty if language not applicable
    if lang not in _PY_LANGS:
        return []
    
    fixes: List[HealingFix] = []
    lines = code.split("\n")
    
    for idx, line in enumerate(lines):
        # Detection logic here...
        if should_flag:
            fixes.append(HealingFix(
                category=HealingCategory.TRAILING_WHITESPACE,
                severity=HealingSeverity.LOW,        # CRITICAL/MODERATE/LOW
                action=HealingAction.DELETE,          # INSERT/DELETE/REPLACE/REORDER
                description="What's wrong and how to fix it",
                line=idx,                             # 0-indexed line number
                column=start_col,                     # 0-indexed column
                end_line=idx,
                end_column=end_col,
                original_text="text being replaced",
                replacement_text="new text",
                confidence=0.95,                      # 0.0 - 1.0
                is_safe=True,                         # Safe to auto-apply?
                affects_logic=False,                  # Changes program behaviour?
            ))
    
    return fixes
```

## Key Conventions

### Rule IDs
- Format: `UNI_{CATEGORY}_{NUMBER}` (e.g., `UNI_SEC_001`)
- Categories: HEAL, TERM, IMP, BRK, CMP, WS, CMT, NAM, STR, DEAD, TYPE, ERR,
  OP, FMT, RET, VAR, LOOP, COND, LOG, CMPLX, SYN, DOC, ASYNC, SEC, CLS, FN,
  EXC, RES, DEP, PERF, TEST, ENC, MOD, MAGIC, API, REACT, A11Y, CONC

### Language Dispatch
Rules must be **universal** — they handle all languages from a single function.
Use internal language checks:
```python
if lang not in _PY_LANGS:
    return []
```

### Confidence Levels
- **0.90+**: Safe to auto-apply without user confirmation
- **0.70-0.89**: Show to user, require confirmation
- **0.50-0.69**: Suggestion only, never auto-apply
- **< 0.50**: Don't report (too unreliable)

### Safety Rules
- `is_safe=True` + `affects_logic=False` → can be auto-applied
- `is_safe=True` + `affects_logic=True` → show but don't auto-apply
- `is_safe=False` → always require user approval

## Registration

After creating a rule file, add it to `rules/__init__.py`:
```python
from . import your_new_module
```

## Testing

Add tests in `ai-backend/ai-engine/test/`:
```python
class TestYourRules:
    def test_detects_issue(self):
        code = "problematic code here"
        fixes = run_rule("your_module", code, "python")
        assert any("expected" in f.description.lower() for f in fixes)

    def test_no_false_positive(self):
        code = "clean code here"
        fixes = run_rule("your_module", code, "python")
        assert len(fixes) == 0
```
