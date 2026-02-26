"""
Python-specific healing rules.

Detects and provides fixes for common Python micro-issues:
- Missing colons after def/class/if/for/while/etc.
- Unused imports
- Missing imports for known symbols
- Comparison to None using == instead of 'is'
- Mutable default arguments
"""

from __future__ import annotations

import ast
import re
from typing import Dict, List, Set, Tuple

from ..healing.types import (
    HealingCategory,
    HealingSeverity,
    HealingAction,
    HealingFix,
)
from ..healing.rule_registry import healing_rule


# Python block statement keywords that require a colon
_BLOCK_KEYWORDS = {
    'def', 'class', 'if', 'elif', 'else', 'for', 'while',
    'try', 'except', 'finally', 'with', 'async',
}

# Common Python standard library imports
_KNOWN_STDLIB_IMPORTS: Dict[str, str] = {
    'os': 'import os',
    'sys': 'import sys',
    'json': 'import json',
    'math': 'import math',
    're': 'import re',
    'time': 'import time',
    'datetime': 'from datetime import datetime',
    'timedelta': 'from datetime import timedelta',
    'Path': 'from pathlib import Path',
    'defaultdict': 'from collections import defaultdict',
    'Counter': 'from collections import Counter',
    'OrderedDict': 'from collections import OrderedDict',
    'namedtuple': 'from collections import namedtuple',
    'deque': 'from collections import deque',
    'Dict': 'from typing import Dict',
    'List': 'from typing import List',
    'Optional': 'from typing import Optional',
    'Tuple': 'from typing import Tuple',
    'Set': 'from typing import Set',
    'Union': 'from typing import Union',
    'Any': 'from typing import Any',
    'Callable': 'from typing import Callable',
    'Iterator': 'from typing import Iterator',
    'Generator': 'from typing import Generator',
    'dataclass': 'from dataclasses import dataclass',
    'field': 'from dataclasses import field',
    'Enum': 'from enum import Enum',
    'ABC': 'from abc import ABC',
    'abstractmethod': 'from abc import abstractmethod',
    'asyncio': 'import asyncio',
    'logging': 'import logging',
    'copy': 'import copy',
    'deepcopy': 'from copy import deepcopy',
    'wraps': 'from functools import wraps',
    'partial': 'from functools import partial',
    'lru_cache': 'from functools import lru_cache',
    'sleep': 'from time import sleep',
    'randint': 'from random import randint',
    'choice': 'from random import choice',
    'shuffle': 'from random import shuffle',
}


@healing_rule(
    rule_id="PY_HEAL_001",
    category=HealingCategory.MISSING_COLON,
    languages={"python", "py"},
    description="Add missing colon after Python block statement",
)
def detect_missing_colon(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect missing colons after Python block statements."""
    fixes = []
    lines = code.split('\n')
    
    for idx, line in enumerate(lines):
        stripped = line.rstrip()
        if not stripped:
            continue
        
        # Check if line looks like a block statement without a colon
        lstripped = stripped.lstrip()
        
        # Match patterns like "def foo(args)" without trailing colon
        patterns = [
            (r'^(async\s+)?def\s+\w+\s*\(.*\)\s*(->\s*\S+\s*)?$', 'function definition'),
            (r'^class\s+\w+(\s*\(.*\))?\s*$', 'class definition'),
            (r'^if\s+.+\s*$', 'if statement'),
            (r'^elif\s+.+\s*$', 'elif statement'),
            (r'^else\s*$', 'else clause'),
            (r'^for\s+.+\s+in\s+.+\s*$', 'for loop'),
            (r'^while\s+.+\s*$', 'while loop'),
            (r'^try\s*$', 'try block'),
            (r'^except\s*(\s+\w+(\s+as\s+\w+)?)?\s*$', 'except clause'),
            (r'^finally\s*$', 'finally clause'),
            (r'^with\s+.+\s*$', 'with statement'),
            (r'^(async\s+)?for\s+.+\s+in\s+.+\s*$', 'async for loop'),
            (r'^(async\s+)?with\s+.+\s*$', 'async with statement'),
        ]
        
        for pattern, desc in patterns:
            if re.match(pattern, lstripped) and not stripped.endswith(':'):
                # Don't flag if line ends with a comment that has a colon
                if '#' in stripped:
                    comment_start = stripped.index('#')
                    before_comment = stripped[:comment_start].rstrip()
                    if before_comment.endswith(':'):
                        continue
                
                # Don't flag multi-line statements (ends with \)
                if stripped.endswith('\\'):
                    continue
                
                # Don't flag incomplete parentheses (multi-line def)
                open_parens = stripped.count('(') - stripped.count(')')
                if open_parens > 0:
                    continue
                
                col = len(stripped)
                fixes.append(HealingFix(
                    category=HealingCategory.MISSING_COLON,
                    severity=HealingSeverity.CRITICAL,
                    action=HealingAction.INSERT,
                    description=f"Add missing colon after {desc}",
                    line=idx,
                    column=col,
                    end_line=idx,
                    end_column=col,
                    original_text="",
                    replacement_text=":",
                    confidence=0.95,
                    is_safe=True,
                ))
                break  # One fix per line
    
    return fixes


@healing_rule(
    rule_id="PY_HEAL_002",
    category=HealingCategory.UNUSED_IMPORT,
    languages={"python", "py"},
    description="Remove unused Python imports",
)
def detect_unused_imports(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect unused imports in Python code."""
    fixes = []
    
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return fixes
    
    # Collect all imports
    imports: List[Tuple[str, int, str]] = []  # (name, line, full_line)
    lines = code.split('\n')
    
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                name = alias.asname or alias.name
                if node.lineno - 1 < len(lines):
                    imports.append((name, node.lineno - 1, lines[node.lineno - 1]))
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == '*':
                    continue  # Skip wildcard imports
                name = alias.asname or alias.name
                if node.lineno - 1 < len(lines):
                    imports.append((name, node.lineno - 1, lines[node.lineno - 1]))
    
    # Collect all names used in the code (excluding import lines)
    used_names: Set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            used_names.add(node.id)
        elif isinstance(node, ast.Attribute):
            # For x.y.z, we care about x
            obj = node
            while isinstance(obj, ast.Attribute):
                obj = obj.value
            if isinstance(obj, ast.Name):
                used_names.add(obj.id)
    
    # Find unused imports
    for name, line_idx, full_line in imports:
        # Check if the imported name is used anywhere
        # For dotted imports like 'os.path', check 'os'
        root_name = name.split('.')[0]
        
        if root_name not in used_names:
            # Double-check: might be used in type comments or decorators
            code_without_imports = '\n'.join(
                l for i, l in enumerate(lines)
                if i != line_idx
            )
            if root_name in code_without_imports:
                continue
            
            stripped = full_line.rstrip()
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_IMPORT,
                severity=HealingSeverity.LOW,
                action=HealingAction.DELETE,
                description=f"Remove unused import '{name}'",
                line=line_idx,
                column=0,
                end_line=line_idx,
                end_column=len(stripped),
                original_text=stripped,
                replacement_text="",
                confidence=0.92,
                is_safe=True,
            ))
    
    return fixes


@healing_rule(
    rule_id="PY_HEAL_003",
    category=HealingCategory.MISSING_IMPORT,
    languages={"python", "py"},
    description="Add missing import for known Python symbols",
)
def detect_missing_imports(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect missing imports for well-known Python symbols."""
    fixes = []
    
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return fixes
    
    # Collect already-imported names
    imported_names: Set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imported_names.add(alias.asname or alias.name)
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                imported_names.add(alias.asname or alias.name)
    
    # Collect all names used
    used_names: Set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            used_names.add(node.id)
    
    # Collect all defined names (functions, classes, variables)
    defined_names: Set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            defined_names.add(node.name)
            for arg in node.args.args:
                defined_names.add(arg.arg)
        elif isinstance(node, ast.ClassDef):
            defined_names.add(node.name)
        elif isinstance(node, ast.Name) and isinstance(getattr(node, 'ctx', None), ast.Store):
            defined_names.add(node.id)
        elif isinstance(node, ast.For):
            if isinstance(node.target, ast.Name):
                defined_names.add(node.target.id)
        elif isinstance(node, ast.With):
            for item in node.items:
                if item.optional_vars and isinstance(item.optional_vars, ast.Name):
                    defined_names.add(item.optional_vars.id)
    
    # Find last import line for insertion point
    last_import_line = 0
    lines = code.split('\n')
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith('import ') or stripped.startswith('from '):
            last_import_line = i
    
    # Check for undefined names that we know how to import
    for name in used_names:
        if name in imported_names:
            continue
        if name in defined_names:
            continue
        if name in ('True', 'False', 'None', 'self', 'cls', 'super',
                     'print', 'len', 'range', 'int', 'str', 'float',
                     'bool', 'list', 'dict', 'set', 'tuple', 'type',
                     'isinstance', 'issubclass', 'hasattr', 'getattr',
                     'setattr', 'delattr', 'property', 'staticmethod',
                     'classmethod', 'enumerate', 'zip', 'map', 'filter',
                     'sorted', 'reversed', 'min', 'max', 'sum', 'abs',
                     'round', 'id', 'hash', 'repr', 'format', 'open',
                     'input', 'Exception', 'ValueError', 'TypeError',
                     'KeyError', 'IndexError', 'AttributeError',
                     'RuntimeError', 'StopIteration', 'NotImplementedError',
                     'OSError', 'IOError', 'FileNotFoundError',
                     '__name__', '__file__', '__doc__', '__all__'):
            continue
        
        if name in _KNOWN_STDLIB_IMPORTS:
            import_statement = _KNOWN_STDLIB_IMPORTS[name]
            insert_line = last_import_line + 1 if last_import_line > 0 else 0
            
            fixes.append(HealingFix(
                category=HealingCategory.MISSING_IMPORT,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.INSERT,
                description=f"Add missing import: {import_statement}",
                line=insert_line,
                column=0,
                end_line=insert_line,
                end_column=0,
                original_text="",
                replacement_text=import_statement + "\n",
                confidence=0.95,
                is_safe=True,
            ))
    
    return fixes


@healing_rule(
    rule_id="PY_HEAL_004",
    category=HealingCategory.COMPARISON_TO_NONE,
    languages={"python", "py"},
    description="Replace '== None' with 'is None' and '!= None' with 'is not None'",
)
def detect_comparison_to_none(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect comparison to None using == instead of 'is'."""
    fixes = []
    lines = code.split('\n')
    
    for idx, line in enumerate(lines):
        # Skip comments
        stripped = line.lstrip()
        if stripped.startswith('#'):
            continue
        
        # Find == None patterns
        for match in re.finditer(r'(\w+)\s*==\s*None\b', line):
            col = match.start()
            end_col = match.end()
            var_name = match.group(1)
            
            fixes.append(HealingFix(
                category=HealingCategory.COMPARISON_TO_NONE,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description=f"Use 'is None' instead of '== None'",
                line=idx,
                column=col,
                end_line=idx,
                end_column=end_col,
                original_text=match.group(0),
                replacement_text=f"{var_name} is None",
                confidence=0.98,
                is_safe=True,
            ))
        
        # Find != None patterns
        for match in re.finditer(r'(\w+)\s*!=\s*None\b', line):
            col = match.start()
            end_col = match.end()
            var_name = match.group(1)
            
            fixes.append(HealingFix(
                category=HealingCategory.COMPARISON_TO_NONE,
                severity=HealingSeverity.LOW,
                action=HealingAction.REPLACE,
                description=f"Use 'is not None' instead of '!= None'",
                line=idx,
                column=col,
                end_line=idx,
                end_column=end_col,
                original_text=match.group(0),
                replacement_text=f"{var_name} is not None",
                confidence=0.98,
                is_safe=True,
            ))
    
    return fixes


@healing_rule(
    rule_id="PY_HEAL_005",
    category=HealingCategory.DUPLICATE_IMPORT,
    languages={"python", "py"},
    description="Remove duplicate Python imports",
)
def detect_duplicate_imports(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect duplicate imports in Python code."""
    fixes = []
    
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return fixes
    
    lines = code.split('\n')
    seen_imports: Dict[str, int] = {}  # import_key -> first_line
    
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                key = f"import:{alias.name}:{alias.asname or ''}"
                line_idx = node.lineno - 1
                if key in seen_imports:
                    # This is a duplicate
                    if line_idx < len(lines):
                        stripped = lines[line_idx].rstrip()
                        fixes.append(HealingFix(
                            category=HealingCategory.DUPLICATE_IMPORT,
                            severity=HealingSeverity.LOW,
                            action=HealingAction.DELETE,
                            description=f"Remove duplicate import '{alias.name}'",
                            line=line_idx,
                            column=0,
                            end_line=line_idx,
                            end_column=len(stripped),
                            original_text=stripped,
                            replacement_text="",
                            confidence=0.99,
                            is_safe=True,
                        ))
                else:
                    seen_imports[key] = line_idx
        
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                module = node.module or ''
                key = f"from:{module}:{alias.name}:{alias.asname or ''}"
                line_idx = node.lineno - 1
                if key in seen_imports:
                    if line_idx < len(lines):
                        stripped = lines[line_idx].rstrip()
                        fixes.append(HealingFix(
                            category=HealingCategory.DUPLICATE_IMPORT,
                            severity=HealingSeverity.LOW,
                            action=HealingAction.DELETE,
                            description=f"Remove duplicate import '{alias.name}' from '{module}'",
                            line=line_idx,
                            column=0,
                            end_line=line_idx,
                            end_column=len(stripped),
                            original_text=stripped,
                            replacement_text="",
                            confidence=0.99,
                            is_safe=True,
                        ))
                else:
                    seen_imports[key] = line_idx
    
    return fixes
