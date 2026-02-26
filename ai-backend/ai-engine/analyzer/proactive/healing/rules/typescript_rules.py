"""
TypeScript-specific healing rules.

Extends JavaScript rules with TypeScript-specific fixes:
- Missing type annotations in obvious cases
- Unused type imports
- Missing type imports for known types
- 'any' type usage warnings
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

# Re-use JavaScript rules for TypeScript
from . import javascript_rules  # noqa - triggers JS rule registration


# Known TypeScript type imports
_KNOWN_TS_TYPE_IMPORTS: Dict[str, str] = {
    'FC': "import type { FC } from 'react';",
    'ReactNode': "import type { ReactNode } from 'react';",
    'ReactElement': "import type { ReactElement } from 'react';",
    'ChangeEvent': "import type { ChangeEvent } from 'react';",
    'FormEvent': "import type { FormEvent } from 'react';",
    'MouseEvent': "import type { MouseEvent } from 'react';",
    'KeyboardEvent': "import type { KeyboardEvent } from 'react';",
    'RefObject': "import type { RefObject } from 'react';",
    'MutableRefObject': "import type { MutableRefObject } from 'react';",
    'Dispatch': "import type { Dispatch } from 'react';",
    'SetStateAction': "import type { SetStateAction } from 'react';",
    'PropsWithChildren': "import type { PropsWithChildren } from 'react';",
    'CSSProperties': "import type { CSSProperties } from 'react';",
    'NextPage': "import type { NextPage } from 'next';",
    'GetServerSideProps': "import type { GetServerSideProps } from 'next';",
    'GetStaticProps': "import type { GetStaticProps } from 'next';",
    'AppProps': "import type { AppProps } from 'next/app';",
    'NextApiRequest': "import type { NextApiRequest } from 'next';",
    'NextApiResponse': "import type { NextApiResponse } from 'next';",
}


@healing_rule(
    rule_id="TS_HEAL_001",
    category=HealingCategory.MISSING_SEMICOLON,
    languages={"typescript", "ts", "tsx"},
    description="Add missing semicolons in TypeScript",
)
def detect_missing_semicolons_ts(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect missing semicolons in TypeScript (delegates to JS rule)."""
    return javascript_rules.detect_missing_semicolons_js(code, "javascript", file_path)


@healing_rule(
    rule_id="TS_HEAL_002",
    category=HealingCategory.UNUSED_IMPORT,
    languages={"typescript", "ts", "tsx"},
    description="Remove unused TypeScript imports including type imports",
)
def detect_unused_imports_ts(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect unused imports in TypeScript, including type-only imports."""
    fixes = []
    lines = code.split('\n')
    
    # Parse import statements (including type imports)
    imports: List[Tuple[str, int, str, bool]] = []  # (name, line_idx, full_line, is_type)
    
    for idx, line in enumerate(lines):
        stripped = line.strip()
        
        # Type-only import: import type { Foo } from '...'
        is_type = 'import type' in stripped
        
        # Default import
        match = re.match(r"import\s+(?:type\s+)?(\w+)\s+from\s+['\"]", stripped)
        if match:
            imports.append((match.group(1), idx, line.rstrip(), is_type))
            continue
        
        # Named imports
        match = re.match(r"import\s+(?:type\s+)?\{([^}]+)\}\s*from\s+['\"]", stripped)
        if match:
            names = match.group(1)
            for name_part in names.split(','):
                name_part = name_part.strip()
                if ' as ' in name_part:
                    name_part = name_part.split(' as ')[1].strip()
                if name_part:
                    imports.append((name_part, idx, line.rstrip(), is_type))
            continue
    
    # Collect all identifiers used (excluding import lines)
    import_lines = {line_idx for _, line_idx, _, _ in imports}
    code_without_imports = '\n'.join(
        l for i, l in enumerate(lines) if i not in import_lines
    )
    
    used_identifiers = set(re.findall(r'\b([A-Za-z_$]\w*)\b', code_without_imports))
    
    # Also check type annotations (: Type, <Type>, as Type)
    type_pattern = r':\s*([A-Z]\w*)|<\s*([A-Z]\w*)|as\s+([A-Z]\w*)'
    type_matches = re.findall(type_pattern, code_without_imports)
    for groups in type_matches:
        for g in groups:
            if g:
                used_identifiers.add(g)
    
    for name, line_idx, full_line, is_type in imports:
        if name not in used_identifiers:
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_IMPORT,
                severity=HealingSeverity.LOW,
                action=HealingAction.DELETE,
                description=f"Remove unused {'type ' if is_type else ''}import '{name}'",
                line=line_idx,
                column=0,
                end_line=line_idx,
                end_column=len(full_line),
                original_text=full_line,
                replacement_text="",
                confidence=0.92,
                is_safe=True,
            ))
    
    return fixes


@healing_rule(
    rule_id="TS_HEAL_003",
    category=HealingCategory.MISSING_IMPORT,
    languages={"typescript", "ts", "tsx"},
    description="Add missing type import for known TypeScript/React types",
)
def detect_missing_type_imports_ts(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect missing type imports for well-known TS/React types."""
    fixes = []
    lines = code.split('\n')
    
    # Collect already-imported names
    imported_names: Set[str] = set()
    last_import_line = -1
    
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith('import '):
            last_import_line = idx
            match = re.match(r"import\s+(?:type\s+)?(\w+)", stripped)
            if match:
                imported_names.add(match.group(1))
            match = re.match(r"import\s+(?:type\s+)?\{([^}]+)\}", stripped)
            if match:
                for name in match.group(1).split(','):
                    name = name.strip()
                    if ' as ' in name:
                        name = name.split(' as ')[1].strip()
                    if name:
                        imported_names.add(name)
    
    # Find type annotations that reference unknown types
    type_refs: Set[str] = set()
    for line in lines:
        # : Type
        for match in re.finditer(r':\s*([A-Z]\w*)', line):
            type_refs.add(match.group(1))
        # <Type>
        for match in re.finditer(r'<\s*([A-Z]\w*)', line):
            type_refs.add(match.group(1))
        # as Type
        for match in re.finditer(r'\bas\s+([A-Z]\w*)', line):
            type_refs.add(match.group(1))
    
    # Collect defined types
    defined_names: Set[str] = set()
    for line in lines:
        for match in re.finditer(r'(?:type|interface|class|enum)\s+(\w+)', line):
            defined_names.add(match.group(1))
    
    # TS builtins to exclude
    ts_builtins = {
        'string', 'number', 'boolean', 'void', 'null', 'undefined',
        'any', 'never', 'unknown', 'object', 'symbol', 'bigint',
        'Array', 'Object', 'String', 'Number', 'Boolean', 'Function',
        'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet',
        'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit',
        'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'Parameters',
        'InstanceType', 'ConstructorParameters', 'ThisType',
        'HTMLElement', 'HTMLDivElement', 'HTMLInputElement',
        'HTMLButtonElement', 'HTMLFormElement', 'HTMLAnchorElement',
        'Event', 'CustomEvent', 'Response', 'Request', 'Headers',
        'Error', 'TypeError', 'RangeError', 'SyntaxError',
        'Date', 'RegExp', 'JSON', 'Math',
    }
    
    for type_name in type_refs:
        if type_name in imported_names or type_name in defined_names:
            continue
        if type_name in ts_builtins:
            continue
        
        if type_name in _KNOWN_TS_TYPE_IMPORTS:
            import_statement = _KNOWN_TS_TYPE_IMPORTS[type_name]
            insert_line = last_import_line + 1 if last_import_line >= 0 else 0
            
            fixes.append(HealingFix(
                category=HealingCategory.MISSING_IMPORT,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.INSERT,
                description=f"Add missing type import: {import_statement}",
                line=insert_line,
                column=0,
                end_line=insert_line,
                end_column=0,
                original_text="",
                replacement_text=import_statement + "\n",
                confidence=0.93,
                is_safe=True,
            ))
    
    # Also check for regular JS imports via the JS rule
    js_fixes = javascript_rules.detect_missing_imports_js(code, "javascript", file_path)
    fixes.extend(js_fixes)
    
    return fixes
