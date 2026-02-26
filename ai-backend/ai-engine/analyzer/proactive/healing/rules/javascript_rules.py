"""
JavaScript-specific healing rules.

Detects and provides fixes for common JavaScript micro-issues:
- Missing semicolons
- Unused imports (ES modules)
- Missing imports for known symbols
- const/let/var issues
- Common typos in JS APIs
"""

from __future__ import annotations

import re
from typing import Dict, List, Set, Tuple

from ..healing.types import (
    HealingCategory,
    HealingSeverity,
    HealingAction,
    HealingFix,
)
from ..healing.rule_registry import healing_rule


# Common JS/Node.js imports that can be auto-suggested
_KNOWN_JS_IMPORTS: Dict[str, str] = {
    'useState': "import { useState } from 'react';",
    'useEffect': "import { useEffect } from 'react';",
    'useCallback': "import { useCallback } from 'react';",
    'useMemo': "import { useMemo } from 'react';",
    'useRef': "import { useRef } from 'react';",
    'useContext': "import { useContext } from 'react';",
    'useReducer': "import { useReducer } from 'react';",
    'createContext': "import { createContext } from 'react';",
    'React': "import React from 'react';",
    'Fragment': "import { Fragment } from 'react';",
    'Suspense': "import { Suspense } from 'react';",
    'lazy': "import { lazy } from 'react';",
    'memo': "import { memo } from 'react';",
    'forwardRef': "import { forwardRef } from 'react';",
    'clsx': "import clsx from 'clsx';",
    'cn': "import { cn } from '@/lib/utils';",
    'axios': "import axios from 'axios';",
    'Link': "import Link from 'next/link';",
    'useRouter': "import { useRouter } from 'next/navigation';",
    'usePathname': "import { usePathname } from 'next/navigation';",
    'useSearchParams': "import { useSearchParams } from 'next/navigation';",
    'Image': "import Image from 'next/image';",
    'Head': "import Head from 'next/head';",
}


@healing_rule(
    rule_id="JS_HEAL_001",
    category=HealingCategory.MISSING_SEMICOLON,
    languages={"javascript", "js"},
    description="Add missing semicolons in JavaScript",
)
def detect_missing_semicolons_js(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect missing semicolons in JavaScript."""
    fixes = []
    lines = code.split('\n')
    
    for idx, line in enumerate(lines):
        stripped = line.rstrip()
        if not stripped:
            continue
        
        lstripped = stripped.lstrip()
        
        # Skip lines that don't need semicolons
        if (lstripped.startswith('//') or lstripped.startswith('/*') or
            lstripped.startswith('*') or lstripped.endswith('*/') or
            lstripped.startswith('import ') or lstripped.startswith('export ') or
            lstripped.endswith('{') or lstripped.endswith('}') or
            lstripped.endswith(',') or lstripped.endswith('(') or
            lstripped.endswith(':') or lstripped.endswith(';') or
            lstripped.endswith('\\') or lstripped.endswith('=>') or
            lstripped.endswith('&&') or lstripped.endswith('||') or
            lstripped.endswith('+') or lstripped.endswith('-') or
            lstripped.endswith('?') or
            lstripped.startswith('if') or lstripped.startswith('else') or
            lstripped.startswith('for') or lstripped.startswith('while') or
            lstripped.startswith('switch') or lstripped.startswith('case') or
            lstripped.startswith('default:') or
            lstripped.startswith('function ') or
            lstripped.startswith('class ') or
            lstripped.startswith('@') or  # decorators
            lstripped == '}' or lstripped == ')' or lstripped == ']'):
            continue
        
        # Detect statements that should end with semicolons
        statement_patterns = [
            r'^(const|let|var)\s+\w+\s*=\s*.+[^;{,]\s*$',  # variable declaration
            r'^return\s+.+[^;{,]\s*$',  # return statement
            r'^throw\s+.+[^;{,]\s*$',  # throw statement
            r'^\w+\s*\(.*\)\s*$',  # function call
            r'^\w+\.\w+\s*\(.*\)\s*$',  # method call
            r'^(this|super)\.\w+\s*=.+[^;{,]\s*$',  # property assignment
            r'^\w+\s*=\s*.+[^;{,]\s*$',  # assignment
            r'^break\s*$',  # break
            r'^continue\s*$',  # continue
        ]
        
        for pattern in statement_patterns:
            if re.match(pattern, lstripped):
                col = len(stripped)
                fixes.append(HealingFix(
                    category=HealingCategory.MISSING_SEMICOLON,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.INSERT,
                    description="Add missing semicolon",
                    line=idx,
                    column=col,
                    end_line=idx,
                    end_column=col,
                    original_text="",
                    replacement_text=";",
                    confidence=0.85,  # Lower confidence - JS semicolons are optional in many cases
                    is_safe=True,
                ))
                break
    
    return fixes


@healing_rule(
    rule_id="JS_HEAL_002",
    category=HealingCategory.UNUSED_IMPORT,
    languages={"javascript", "js"},
    description="Remove unused JavaScript ES module imports",
)
def detect_unused_imports_js(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect unused ES module imports in JavaScript."""
    fixes = []
    lines = code.split('\n')
    
    # Parse import statements
    imports: List[Tuple[str, int, str]] = []  # (name, line_idx, full_line)
    
    for idx, line in enumerate(lines):
        stripped = line.strip()
        
        # Default import: import Foo from '...'
        match = re.match(r"import\s+(\w+)\s+from\s+['\"]", stripped)
        if match:
            imports.append((match.group(1), idx, line.rstrip()))
            continue
        
        # Named imports: import { Foo, Bar } from '...'
        match = re.match(r"import\s*\{([^}]+)\}\s*from\s+['\"]", stripped)
        if match:
            names = match.group(1)
            for name_part in names.split(','):
                name_part = name_part.strip()
                if ' as ' in name_part:
                    name_part = name_part.split(' as ')[1].strip()
                if name_part:
                    imports.append((name_part, idx, line.rstrip()))
            continue
        
        # Side-effect import: import '...' - skip these
        if re.match(r"import\s+['\"]", stripped):
            continue
    
    # Collect all identifiers used in the code (excluding import lines)
    import_lines = {line_idx for _, line_idx, _ in imports}
    code_without_imports = '\n'.join(
        l for i, l in enumerate(lines)
        if i not in import_lines
    )
    
    # Find all identifiers in the rest of the code
    used_identifiers = set(re.findall(r'\b([A-Za-z_$]\w*)\b', code_without_imports))
    
    # Find unused imports
    for name, line_idx, full_line in imports:
        if name not in used_identifiers:
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
                confidence=0.90,
                is_safe=True,
            ))
    
    return fixes


@healing_rule(
    rule_id="JS_HEAL_003",
    category=HealingCategory.MISSING_IMPORT,
    languages={"javascript", "js"},
    description="Add missing import for known JavaScript/React symbols",
)
def detect_missing_imports_js(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect missing imports for well-known JS/React symbols."""
    fixes = []
    lines = code.split('\n')
    
    # Collect already-imported names
    imported_names: Set[str] = set()
    last_import_line = -1
    
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith('import '):
            last_import_line = idx
            # Extract imported names
            # Default: import Foo from '...'
            match = re.match(r"import\s+(\w+)", stripped)
            if match:
                imported_names.add(match.group(1))
            # Named: import { Foo, Bar } from '...'
            match = re.match(r"import\s*\{([^}]+)\}", stripped)
            if match:
                for name in match.group(1).split(','):
                    name = name.strip()
                    if ' as ' in name:
                        name = name.split(' as ')[1].strip()
                    if name:
                        imported_names.add(name)
    
    # Collect all identifiers used in the code
    all_identifiers = set(re.findall(r'\b([A-Za-z_$]\w*)\b', code))
    
    # Collect defined identifiers
    defined_names: Set[str] = set()
    for line in lines:
        # const/let/var declarations
        for match in re.finditer(r'(?:const|let|var)\s+(\w+)', line):
            defined_names.add(match.group(1))
        # Function declarations
        for match in re.finditer(r'function\s+(\w+)', line):
            defined_names.add(match.group(1))
        # Class declarations
        for match in re.finditer(r'class\s+(\w+)', line):
            defined_names.add(match.group(1))
        # Parameters
        for match in re.finditer(r'(?:\(|,)\s*(\w+)\s*[,)=]', line):
            defined_names.add(match.group(1))
    
    # JS builtins to exclude
    js_builtins = {
        'console', 'window', 'document', 'navigator', 'fetch', 'URL',
        'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean',
        'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Proxy',
        'Error', 'TypeError', 'RangeError', 'SyntaxError',
        'JSON', 'Math', 'Date', 'RegExp', 'parseInt', 'parseFloat',
        'isNaN', 'isFinite', 'undefined', 'null', 'NaN', 'Infinity',
        'true', 'false', 'this', 'super', 'arguments', 'globalThis',
        'require', 'module', 'exports', 'process', 'Buffer', '__dirname',
        'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
        'requestAnimationFrame', 'cancelAnimationFrame',
        'alert', 'confirm', 'prompt', 'atob', 'btoa',
    }
    
    # Common JS keywords to exclude
    js_keywords = {
        'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
        'continue', 'return', 'throw', 'try', 'catch', 'finally',
        'new', 'delete', 'typeof', 'instanceof', 'in', 'of',
        'const', 'let', 'var', 'function', 'class', 'extends',
        'import', 'export', 'default', 'from', 'as', 'async', 'await',
        'yield', 'void', 'with', 'debugger', 'static', 'get', 'set',
    }
    
    # Check for undefined names that we know how to import
    for name in all_identifiers:
        if name in imported_names or name in defined_names:
            continue
        if name in js_builtins or name in js_keywords:
            continue
        if len(name) < 2:  # Skip single-char variables
            continue
        
        if name in _KNOWN_JS_IMPORTS:
            import_statement = _KNOWN_JS_IMPORTS[name]
            insert_line = last_import_line + 1 if last_import_line >= 0 else 0
            
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
                confidence=0.93,
                is_safe=True,
            ))
    
    return fixes


@healing_rule(
    rule_id="JS_HEAL_004",
    category=HealingCategory.MISSING_BRACKET,
    languages={"javascript", "js"},
    description="Detect unmatched brackets in JavaScript",
)
def detect_unmatched_brackets_js(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect unmatched brackets in JavaScript code."""
    fixes = []
    
    # Track bracket pairs
    stack: List[Tuple[str, int, int]] = []  # (char, line, col)
    lines = code.split('\n')
    
    in_string = False
    string_char = None
    in_template = False
    in_line_comment = False
    in_block_comment = False
    
    for idx, line in enumerate(lines):
        in_line_comment = False
        
        for col, ch in enumerate(line):
            # Handle comments
            if in_block_comment:
                if ch == '*' and col + 1 < len(line) and line[col + 1] == '/':
                    in_block_comment = False
                continue
            
            if in_line_comment:
                continue
            
            if ch == '/' and col + 1 < len(line):
                if line[col + 1] == '/':
                    in_line_comment = True
                    continue
                if line[col + 1] == '*':
                    in_block_comment = True
                    continue
            
            # Handle strings
            if in_string:
                if ch == string_char and (col == 0 or line[col - 1] != '\\'):
                    in_string = False
                    string_char = None
                continue
            
            if ch in ('"', "'", '`'):
                in_string = True
                string_char = ch
                continue
            
            # Track brackets
            if ch in ('(', '[', '{'):
                stack.append((ch, idx, col))
            elif ch in (')', ']', '}'):
                expected = {'(': ')', '[': ']', '{': '}'}
                if stack:
                    open_ch, open_line, open_col = stack[-1]
                    if expected.get(open_ch) == ch:
                        stack.pop()
                    # Mismatched - don't try to fix
    
    # Check for unclosed brackets at end of file
    for open_ch, open_line, open_col in stack:
        closing = {'(': ')', '[': ']', '{': '}'}[open_ch]
        
        # Find the best place to insert the closing bracket
        # Usually at the end of the last non-empty line
        insert_line = len(lines) - 1
        while insert_line > open_line and not lines[insert_line].strip():
            insert_line -= 1
        
        insert_col = len(lines[insert_line].rstrip()) if insert_line < len(lines) else 0
        
        fixes.append(HealingFix(
            category=HealingCategory.MISSING_BRACKET,
            severity=HealingSeverity.CRITICAL,
            action=HealingAction.INSERT,
            description=f"Add missing closing '{closing}' to match '{open_ch}' at line {open_line + 1}",
            line=insert_line,
            column=insert_col,
            end_line=insert_line,
            end_column=insert_col,
            original_text="",
            replacement_text=closing,
            confidence=0.80,  # Lower confidence for bracket matching
            is_safe=False,  # Bracket fixes can be tricky
        ))
    
    return fixes
