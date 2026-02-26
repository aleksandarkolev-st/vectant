"""
C/C++ specific healing rules.

Detects and provides fixes for common C/C++ micro-issues:
- Missing semicolons
- Missing #include for known headers
- Unmatched brackets
- Missing header guards
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


# Common C++ standard library headers and their symbols
_KNOWN_CPP_INCLUDES: Dict[str, str] = {
    'cout': '#include <iostream>',
    'cin': '#include <iostream>',
    'cerr': '#include <iostream>',
    'endl': '#include <iostream>',
    'string': '#include <string>',
    'vector': '#include <vector>',
    'map': '#include <map>',
    'unordered_map': '#include <unordered_map>',
    'set': '#include <set>',
    'unordered_set': '#include <unordered_set>',
    'list': '#include <list>',
    'deque': '#include <deque>',
    'stack': '#include <stack>',
    'queue': '#include <queue>',
    'priority_queue': '#include <queue>',
    'pair': '#include <utility>',
    'make_pair': '#include <utility>',
    'sort': '#include <algorithm>',
    'find': '#include <algorithm>',
    'reverse': '#include <algorithm>',
    'min_element': '#include <algorithm>',
    'max_element': '#include <algorithm>',
    'unique_ptr': '#include <memory>',
    'shared_ptr': '#include <memory>',
    'weak_ptr': '#include <memory>',
    'make_unique': '#include <memory>',
    'make_shared': '#include <memory>',
    'thread': '#include <thread>',
    'mutex': '#include <mutex>',
    'lock_guard': '#include <mutex>',
    'unique_lock': '#include <mutex>',
    'ifstream': '#include <fstream>',
    'ofstream': '#include <fstream>',
    'fstream': '#include <fstream>',
    'stringstream': '#include <sstream>',
    'istringstream': '#include <sstream>',
    'ostringstream': '#include <sstream>',
    'array': '#include <array>',
    'tuple': '#include <tuple>',
    'optional': '#include <optional>',
    'variant': '#include <variant>',
    'any': '#include <any>',
    'filesystem': '#include <filesystem>',
    'chrono': '#include <chrono>',
    'regex': '#include <regex>',
    'stoi': '#include <string>',
    'stod': '#include <string>',
    'stof': '#include <string>',
    'to_string': '#include <string>',
    'printf': '#include <cstdio>',
    'scanf': '#include <cstdio>',
    'malloc': '#include <cstdlib>',
    'free': '#include <cstdlib>',
    'memcpy': '#include <cstring>',
    'strlen': '#include <cstring>',
    'strcmp': '#include <cstring>',
    'abs': '#include <cmath>',
    'sqrt': '#include <cmath>',
    'pow': '#include <cmath>',
    'sin': '#include <cmath>',
    'cos': '#include <cmath>',
    'assert': '#include <cassert>',
    'size_t': '#include <cstddef>',
    'nullptr_t': '#include <cstddef>',
    'int8_t': '#include <cstdint>',
    'int16_t': '#include <cstdint>',
    'int32_t': '#include <cstdint>',
    'int64_t': '#include <cstdint>',
    'uint8_t': '#include <cstdint>',
    'uint16_t': '#include <cstdint>',
    'uint32_t': '#include <cstdint>',
    'uint64_t': '#include <cstdint>',
}

# C-specific headers
_KNOWN_C_INCLUDES: Dict[str, str] = {
    'printf': '#include <stdio.h>',
    'scanf': '#include <stdio.h>',
    'fprintf': '#include <stdio.h>',
    'fopen': '#include <stdio.h>',
    'fclose': '#include <stdio.h>',
    'malloc': '#include <stdlib.h>',
    'free': '#include <stdlib.h>',
    'calloc': '#include <stdlib.h>',
    'realloc': '#include <stdlib.h>',
    'exit': '#include <stdlib.h>',
    'atoi': '#include <stdlib.h>',
    'strlen': '#include <string.h>',
    'strcpy': '#include <string.h>',
    'strcmp': '#include <string.h>',
    'strcat': '#include <string.h>',
    'memcpy': '#include <string.h>',
    'memset': '#include <string.h>',
    'abs': '#include <math.h>',
    'sqrt': '#include <math.h>',
    'pow': '#include <math.h>',
    'assert': '#include <assert.h>',
    'bool': '#include <stdbool.h>',
    'true': '#include <stdbool.h>',
    'false': '#include <stdbool.h>',
    'size_t': '#include <stddef.h>',
    'int8_t': '#include <stdint.h>',
    'uint8_t': '#include <stdint.h>',
}


@healing_rule(
    rule_id="CPP_HEAL_001",
    category=HealingCategory.MISSING_SEMICOLON,
    languages={"cpp", "c", "c++"},
    description="Add missing semicolons in C/C++",
)
def detect_missing_semicolons_cpp(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect missing semicolons in C/C++ code."""
    fixes = []
    lines = code.split('\n')
    
    in_block_comment = False
    
    for idx, line in enumerate(lines):
        stripped = line.rstrip()
        if not stripped:
            continue
        
        lstripped = stripped.lstrip()
        
        # Handle block comments
        if '/*' in lstripped:
            in_block_comment = True
        if '*/' in lstripped:
            in_block_comment = False
            continue
        if in_block_comment:
            continue
        
        # Skip lines that don't need semicolons
        if (lstripped.startswith('//') or lstripped.startswith('#') or
            lstripped.endswith('{') or lstripped.endswith('}') or
            lstripped.endswith(',') or lstripped.endswith('(') or
            lstripped.endswith(';') or lstripped.endswith(':') or
            lstripped.endswith('\\') or
            lstripped.startswith('if') or lstripped.startswith('else') or
            lstripped.startswith('for') or lstripped.startswith('while') or
            lstripped.startswith('switch') or lstripped.startswith('case') or
            lstripped.startswith('default:') or
            lstripped.startswith('template') or
            lstripped.startswith('namespace') or
            lstripped.startswith('public:') or lstripped.startswith('private:') or
            lstripped.startswith('protected:') or
            lstripped == '}' or lstripped == ')' or lstripped == ']'):
            continue
        
        # Function/class declarations don't need semicolons
        if re.match(r'^\w[\w\s*&:<>,]*\([^)]*\)\s*(const)?\s*(override)?\s*$', lstripped):
            # This could be a function definition (without body yet)
            continue
        
        # Detect statements that need semicolons
        stmt_patterns = [
            r'^return\s+.+[^;{,]\s*$',
            r'^(int|float|double|char|long|short|unsigned|void|bool|auto|string|size_t)\s+\w+\s*=.+[^;{,]\s*$',
            r'^(int|float|double|char|long|short|unsigned|void|bool|auto|string|size_t)\s+\w+\s*$',
            r'^(std::)?\w+(::\w+)*\s+\w+\s*=.+[^;{,]\s*$',
            r'^(std::)?\w+(::\w+)*\s+\w+\s*\(.*\)\s*$',  # function call
            r'^\w+\s*\.\w+\s*\(.*\)\s*$',  # method call
            r'^break\s*$',
            r'^continue\s*$',
            r'^delete\s+.+[^;{,]\s*$',
            r'^throw\s+.+[^;{,]\s*$',
        ]
        
        for pattern in stmt_patterns:
            if re.match(pattern, lstripped):
                col = len(stripped)
                fixes.append(HealingFix(
                    category=HealingCategory.MISSING_SEMICOLON,
                    severity=HealingSeverity.CRITICAL,
                    action=HealingAction.INSERT,
                    description="Add missing semicolon",
                    line=idx,
                    column=col,
                    end_line=idx,
                    end_column=col,
                    original_text="",
                    replacement_text=";",
                    confidence=0.90,
                    is_safe=True,
                ))
                break
    
    return fixes


@healing_rule(
    rule_id="CPP_HEAL_002",
    category=HealingCategory.MISSING_IMPORT,
    languages={"cpp", "c++"},
    description="Add missing #include for known C++ standard library symbols",
)
def detect_missing_includes_cpp(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect missing #include for known C++ standard library symbols."""
    fixes = []
    lines = code.split('\n')
    
    # Collect existing includes
    existing_includes: Set[str] = set()
    last_include_line = -1
    
    for idx, line in enumerate(lines):
        stripped = line.strip()
        match = re.match(r'#\s*include\s*[<"]([^>"]+)[>"]', stripped)
        if match:
            existing_includes.add(match.group(1))
            last_include_line = idx
    
    # Find all identifiers in code
    all_identifiers: Set[str] = set()
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('#'):
            continue
        # Find word-like tokens
        for match in re.finditer(r'\b([a-zA-Z_]\w*)\b', line):
            all_identifiers.add(match.group(1))
    
    # Also check for std:: prefixed usage
    std_symbols: Set[str] = set()
    for match in re.finditer(r'std::(\w+)', code):
        std_symbols.add(match.group(1))
    
    # Check for missing includes
    needed_includes: Dict[str, str] = {}
    
    for symbol in (all_identifiers | std_symbols):
        if symbol in _KNOWN_CPP_INCLUDES:
            include = _KNOWN_CPP_INCLUDES[symbol]
            # Extract header name
            header_match = re.match(r'#include\s*<([^>]+)>', include)
            if header_match:
                header = header_match.group(1)
                if header not in existing_includes:
                    needed_includes[header] = include
    
    # Generate fixes for each missing include
    insert_line = last_include_line + 1 if last_include_line >= 0 else 0
    for header, include in needed_includes.items():
        fixes.append(HealingFix(
            category=HealingCategory.MISSING_IMPORT,
            severity=HealingSeverity.MODERATE,
            action=HealingAction.INSERT,
            description=f"Add missing {include}",
            line=insert_line,
            column=0,
            end_line=insert_line,
            end_column=0,
            original_text="",
            replacement_text=include + "\n",
            confidence=0.92,
            is_safe=True,
        ))
    
    return fixes


@healing_rule(
    rule_id="CPP_HEAL_003",
    category=HealingCategory.MISSING_IMPORT,
    languages={"c"},
    description="Add missing #include for known C standard library symbols",
)
def detect_missing_includes_c(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect missing #include for known C standard library symbols."""
    fixes = []
    lines = code.split('\n')
    
    # Collect existing includes
    existing_includes: Set[str] = set()
    last_include_line = -1
    
    for idx, line in enumerate(lines):
        stripped = line.strip()
        match = re.match(r'#\s*include\s*[<"]([^>"]+)[>"]', stripped)
        if match:
            existing_includes.add(match.group(1))
            last_include_line = idx
    
    # Find all identifiers
    all_identifiers: Set[str] = set()
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('#'):
            continue
        for match in re.finditer(r'\b([a-zA-Z_]\w*)\b', line):
            all_identifiers.add(match.group(1))
    
    # Check for missing includes
    needed_includes: Dict[str, str] = {}
    
    for symbol in all_identifiers:
        if symbol in _KNOWN_C_INCLUDES:
            include = _KNOWN_C_INCLUDES[symbol]
            header_match = re.match(r'#include\s*<([^>]+)>', include)
            if header_match:
                header = header_match.group(1)
                if header not in existing_includes:
                    needed_includes[header] = include
    
    insert_line = last_include_line + 1 if last_include_line >= 0 else 0
    for header, include in needed_includes.items():
        fixes.append(HealingFix(
            category=HealingCategory.MISSING_IMPORT,
            severity=HealingSeverity.MODERATE,
            action=HealingAction.INSERT,
            description=f"Add missing {include}",
            line=insert_line,
            column=0,
            end_line=insert_line,
            end_column=0,
            original_text="",
            replacement_text=include + "\n",
            confidence=0.92,
            is_safe=True,
        ))
    
    return fixes
