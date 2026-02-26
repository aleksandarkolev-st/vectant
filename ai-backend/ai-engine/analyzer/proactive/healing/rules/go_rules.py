"""
Self-healing rules for Go.

Rules:
  GO_HEAL_001 – Missing semicolons (auto-inserted by Go, but can help with error recovery)
  GO_HEAL_002 – Unused imports
  GO_HEAL_003 – Missing imports for common stdlib packages
  GO_HEAL_004 – Missing error check (warn only, not auto-fixed)
"""

import re
from ..rule_registry import healing_rule
from ..types import HealingFix, HealingCategory, HealingSeverity, HealingAction

# ── Known Go stdlib packages ──────────────────────────────────────────
GO_KNOWN_IMPORTS = {
    # fmt
    'Println': 'fmt', 'Printf': 'fmt', 'Sprintf': 'fmt', 'Fprintf': 'fmt',
    'Errorf': 'fmt', 'Sscanf': 'fmt', 'Fscanf': 'fmt',
    # strings
    'HasPrefix': 'strings', 'HasSuffix': 'strings', 'Contains': 'strings',
    'TrimSpace': 'strings', 'Split': 'strings', 'Join': 'strings',
    'Replace': 'strings', 'ToLower': 'strings', 'ToUpper': 'strings',
    'NewReader': 'strings', 'Repeat': 'strings', 'Index': 'strings',
    # strconv
    'Itoa': 'strconv', 'Atoi': 'strconv', 'ParseInt': 'strconv',
    'ParseFloat': 'strconv', 'FormatInt': 'strconv', 'FormatFloat': 'strconv',
    # os
    'Exit': 'os', 'Getenv': 'os', 'Setenv': 'os',
    'Open': 'os', 'Create': 'os', 'Remove': 'os', 'Mkdir': 'os',
    'ReadFile': 'os', 'WriteFile': 'os',
    'Stdin': 'os', 'Stdout': 'os', 'Stderr': 'os',
    # io
    'ReadAll': 'io', 'Copy': 'io', 'EOF': 'io',
    # path/filepath
    'Abs': 'filepath', 'Base': 'filepath', 'Dir': 'filepath',
    'Ext': 'filepath', 'Walk': 'filepath',
    # net/http
    'ListenAndServe': 'http', 'HandleFunc': 'http', 'Get': 'http',
    'NewRequest': 'http', 'StatusOK': 'http',
    # encoding/json
    'Marshal': 'json', 'Unmarshal': 'json', 'NewDecoder': 'json',
    'NewEncoder': 'json',
    # sync
    'Mutex': 'sync', 'WaitGroup': 'sync', 'Once': 'sync',
    'RWMutex': 'sync',
    # context
    'Background': 'context', 'TODO': 'context', 'WithCancel': 'context',
    'WithTimeout': 'context', 'WithDeadline': 'context',
    # errors
    'New': 'errors', 'Is': 'errors', 'As': 'errors', 'Unwrap': 'errors',
    # log
    'Fatal': 'log', 'Fatalf': 'log', 'Panic': 'log',
    # math
    'Abs': 'math', 'Max': 'math', 'Min': 'math', 'Sqrt': 'math',
    'Floor': 'math', 'Ceil': 'math',
    # time
    'Now': 'time', 'Sleep': 'time', 'Second': 'time',
    'Duration': 'time', 'After': 'time', 'Tick': 'time',
    # sort
    'Ints': 'sort', 'Strings': 'sort', 'Slice': 'sort',
    # regexp
    'Compile': 'regexp', 'MustCompile': 'regexp', 'MatchString': 'regexp',
}

# Full import paths for packages that aren't top-level
GO_IMPORT_PATHS = {
    'fmt': '"fmt"',
    'strings': '"strings"',
    'strconv': '"strconv"',
    'os': '"os"',
    'io': '"io"',
    'filepath': '"path/filepath"',
    'http': '"net/http"',
    'json': '"encoding/json"',
    'sync': '"sync"',
    'context': '"context"',
    'errors': '"errors"',
    'log': '"log"',
    'math': '"math"',
    'time': '"time"',
    'sort': '"sort"',
    'regexp': '"regexp"',
}


@healing_rule(
    rule_id='GO_HEAL_001',
    name='Go unused import removal',
    languages=['go'],
    category=HealingCategory.UNUSED_IMPORT,
)
def go_unused_imports(code: str, file_path: str = '', **kwargs) -> list:
    """Detect and remove unused import statements in Go."""
    fixes = []
    lines = code.split('\n')

    # Find import block
    import_lines = []
    in_import_block = False
    import_block_start = None
    import_block_end = None
    single_imports = []

    for i, line in enumerate(lines):
        stripped = line.strip()

        # Single import: import "pkg"
        m_single = re.match(r'^import\s+"([^"]+)"', stripped)
        if m_single and not in_import_block:
            single_imports.append((i, m_single.group(1), None))
            continue

        # Single import with alias: import alias "pkg"
        m_alias = re.match(r'^import\s+(\w+)\s+"([^"]+)"', stripped)
        if m_alias and not in_import_block:
            single_imports.append((i, m_alias.group(2), m_alias.group(1)))
            continue

        # Import block start
        if stripped == 'import (' or stripped.startswith('import ('):
            in_import_block = True
            import_block_start = i
            continue

        if in_import_block:
            if stripped == ')':
                import_block_end = i
                in_import_block = False
                continue
            # Parse import line
            m_pkg = re.match(r'^"([^"]+)"', stripped)
            m_apkg = re.match(r'^(\w+)\s+"([^"]+)"', stripped)
            if m_apkg:
                import_lines.append((i, m_apkg.group(2), m_apkg.group(1)))
            elif m_pkg:
                import_lines.append((i, m_pkg.group(1), None))

    all_imports = single_imports + import_lines

    # For each import, check if the package name is used in the code
    # (excluding import lines and comments)
    code_lines = []
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith('//') or stripped.startswith('import'):
            continue
        if import_block_start is not None and import_block_start <= i <= (import_block_end or len(lines)):
            continue
        code_lines.append(line)
    code_body = '\n'.join(code_lines)

    for line_idx, pkg_path, alias in all_imports:
        # Determine the identifier used in code
        if alias and alias != '_':
            used_name = alias
        else:
            # Package name is last segment of path
            used_name = pkg_path.split('/')[-1]

        # Check if the identifier appears in code body
        if not re.search(r'\b' + re.escape(used_name) + r'\b', code_body):
            if alias == '_':
                continue  # Side-effect imports
            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_IMPORT,
                description=f'Remove unused import: {pkg_path}',
                start_line=line_idx,
                start_col=0,
                end_line=line_idx,
                end_col=len(lines[line_idx]),
                replacement_text='',
                confidence=0.92,
                severity=HealingSeverity.LOW,
                action=HealingAction.DELETE,
                is_safe=True,
            ))

    return fixes


@healing_rule(
    rule_id='GO_HEAL_002',
    name='Go missing import detection',
    languages=['go'],
    category=HealingCategory.MISSING_IMPORT,
)
def go_missing_imports(code: str, file_path: str = '', **kwargs) -> list:
    """Detect usage of known Go stdlib functions without import."""
    fixes = []
    lines = code.split('\n')

    # Gather existing imports
    existing_packages = set()
    for line in lines:
        stripped = line.strip()
        m = re.match(r'^import\s+"([^"]+)"', stripped)
        if m:
            existing_packages.add(m.group(1).split('/')[-1])
        m = re.match(r'"([^"]+)"', stripped)
        if m:
            existing_packages.add(m.group(1).split('/')[-1])

    # Scan for known function calls: pkg.Function(
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith('//') or stripped.startswith('import'):
            continue

        # Look for pkg.Function patterns
        for match in re.finditer(r'\b(\w+)\.(\w+)\b', line):
            pkg_name = match.group(1)
            func_name = match.group(2)

            # Check if func is in our known imports and package isn't imported
            if func_name in GO_KNOWN_IMPORTS:
                expected_pkg = GO_KNOWN_IMPORTS[func_name]
                if expected_pkg == pkg_name and pkg_name not in existing_packages:
                    import_path = GO_IMPORT_PATHS.get(pkg_name, f'"{pkg_name}"')

                    # Find where to insert (after package declaration or existing import)
                    insert_line = 0
                    for j, l in enumerate(lines):
                        if l.strip().startswith('package '):
                            insert_line = j + 1
                            break

                    # Check for existing import block
                    for j, l in enumerate(lines):
                        if l.strip() == 'import (' or l.strip().startswith('import ('):
                            # Find the closing paren
                            for k in range(j + 1, len(lines)):
                                if lines[k].strip() == ')':
                                    # Insert before closing paren
                                    insert_line = k
                                    break
                            break

                    fix_text = f'\t{import_path}\n'
                    if insert_line == 0:
                        # No import block, create one after package
                        for j, l in enumerate(lines):
                            if l.strip().startswith('package '):
                                insert_line = j + 1
                                break
                        fix_text = f'\nimport (\n\t{import_path}\n)\n'

                    fixes.append(HealingFix(
                        category=HealingCategory.MISSING_IMPORT,
                        description=f'Add import for {pkg_name} ({import_path})',
                        start_line=insert_line,
                        start_col=0,
                        end_line=insert_line,
                        end_col=0,
                        replacement_text=fix_text,
                        confidence=0.88,
                        severity=HealingSeverity.MODERATE,
                        action=HealingAction.INSERT,
                        is_safe=True,
                    ))
                    existing_packages.add(pkg_name)  # Avoid duplicates

    return fixes


@healing_rule(
    rule_id='GO_HEAL_003',
    name='Go missing closing brace',
    languages=['go'],
    category=HealingCategory.MISSING_BRACKET,
)
def go_missing_brace(code: str, file_path: str = '', **kwargs) -> list:
    """Detect and fix missing closing braces in Go functions."""
    fixes = []
    lines = code.split('\n')
    brace_depth = 0
    in_string = False
    in_comment = False

    for i, line in enumerate(lines):
        stripped = line.strip()

        # Skip comments
        if stripped.startswith('//'):
            continue
        if '/*' in stripped:
            in_comment = True
        if '*/' in stripped:
            in_comment = False
            continue
        if in_comment:
            continue

        for ch in line:
            if ch == '"' and not in_comment:
                in_string = not in_string
            if in_string:
                continue
            if ch == '{':
                brace_depth += 1
            elif ch == '}':
                brace_depth -= 1

    if brace_depth > 0:
        # Missing closing braces
        for _ in range(brace_depth):
            last_line = len(lines) - 1
            indent = ''
            # Try to match the indentation of the last non-empty line
            for j in range(last_line, -1, -1):
                if lines[j].strip():
                    # Reduce indent by one tab/4 spaces
                    leading = len(lines[j]) - len(lines[j].lstrip())
                    indent = lines[j][:max(0, leading - 1)]
                    break

            fixes.append(HealingFix(
                category=HealingCategory.MISSING_BRACKET,
                description='Add missing closing brace',
                start_line=last_line + 1,
                start_col=0,
                end_line=last_line + 1,
                end_col=0,
                replacement_text=f'{indent}}}\n',
                confidence=0.85,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.INSERT,
                is_safe=True,
            ))

    return fixes
