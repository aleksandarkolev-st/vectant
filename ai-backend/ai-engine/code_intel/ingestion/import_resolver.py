from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, Tuple

from .parser_base import ImportStatement


@dataclass
class ResolvedImports:
    files: Set[str]
    symbols_by_file: Dict[str, Set[str]]


def resolve_imports(
    workspace_root: str,
    file_path: str,
    imports: List[ImportStatement],
    language: str,
    file_set: Optional[Set[str]] = None,
) -> ResolvedImports:
    """Resolve import statements to workspace-relative file paths."""
    file_set = {p.replace("\\", "/") for p in (file_set or set())}
    base_dir = "/".join(file_path.replace("\\", "/").split("/")[:-1])

    resolved: Set[str] = set()
    symbols_by_file: Dict[str, Set[str]] = {}

    def add_symbols(target: str, names: Iterable[str]) -> None:
        if not target:
            return
        if target not in symbols_by_file:
            symbols_by_file[target] = set()
        for name in names:
            if name:
                symbols_by_file[target].add(name)

    def add_candidate(rel: str, target_set: Set[str]) -> None:
        rel_norm = rel.replace("\\", "/").lstrip("/")
        if rel_norm in file_set:
            target_set.add(rel_norm)

    def try_extensions(rel_base: str, exts: List[str], target_set: Set[str]) -> None:
        for ext in exts:
            add_candidate(f"{rel_base}{ext}", target_set)
        for ext in exts:
            add_candidate(f"{rel_base}/index{ext}", target_set)

    def resolve_relative(module: str, exts: List[str], target_set: Set[str]) -> None:
        rel = _normalize_path(f"{base_dir}/{module}") if base_dir else _normalize_path(module)
        try_extensions(rel, exts, target_set)
        add_candidate(rel, target_set)

    def resolve_absolute(module: str, exts: List[str], target_set: Set[str]) -> None:
        rel = _normalize_path(module.lstrip("/"))
        try_extensions(rel, exts, target_set)
        add_candidate(rel, target_set)

    def resolve_bare(module: str, exts: List[str], target_set: Set[str]) -> None:
        rel = _normalize_path(module)
        try_extensions(rel, exts, target_set)
        add_candidate(rel, target_set)
        # Fallback: suffix match
        for candidate in list(file_set):
            if candidate.endswith(f"/{rel}") or candidate == rel:
                target_set.add(candidate)

    js_exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]
    py_exts = [".py", "/__init__.py"]
    go_exts = [".go"]
    rs_exts = [".rs"]
    java_exts = [".java"]
    cpp_exts = [".cpp", ".cc", ".cxx", ".c", ".hpp", ".h"]

    for imp in imports:
        module = (imp.module or "").strip()
        names = imp.names or []
        resolved_for_import: Set[str] = set()

        def record() -> None:
            for target in resolved_for_import:
                resolved.add(target)
                add_symbols(target, names)

        if language in ("typescript", "javascript"):
            if module.startswith("@/"):
                module = "src/" + module[2:]
            if module.startswith("."):
                resolve_relative(module, js_exts, resolved_for_import)
            elif module.startswith("/"):
                resolve_absolute(module, js_exts, resolved_for_import)
            else:
                resolve_bare(module, js_exts, resolved_for_import)
            record()

        elif language == "python":
            if imp.is_relative and imp.level:
                base = Path(base_dir) if base_dir else Path(".")
                for _ in range(max(0, imp.level - 1)):
                    base = base.parent
                rel_base = base.as_posix()
                if module:
                    rel_base = _normalize_path(f"{rel_base}/{module.replace('.', '/')}")
                # from . import x
                if not module and names:
                    for name in names:
                        try_extensions(_normalize_path(f"{rel_base}/{name}"), [".py"], resolved_for_import)
                        add_candidate(_normalize_path(f"{rel_base}/{name}/__init__.py"), resolved_for_import)
                else:
                    try_extensions(rel_base, [".py"], resolved_for_import)
                    add_candidate(_normalize_path(f"{rel_base}/__init__.py"), resolved_for_import)
            else:
                rel = _normalize_path(module.replace(".", "/"))
                try_extensions(rel, [".py"], resolved_for_import)
                add_candidate(_normalize_path(f"{rel}/__init__.py"), resolved_for_import)
            record()

        elif language == "go":
            if module.startswith("."):
                resolve_relative(module, go_exts, resolved_for_import)
            else:
                resolve_bare(module, go_exts, resolved_for_import)
            record()

        elif language == "rust":
            if module.startswith("crate::"):
                module = module.replace("crate::", "src/").replace("::", "/")
                resolve_bare(module, rs_exts, resolved_for_import)
            elif module.startswith("self::") or module.startswith("super::"):
                module = module.replace("self::", "").replace("super::", "../").replace("::", "/")
                resolve_relative(module, rs_exts, resolved_for_import)
            else:
                resolve_bare(module.replace("::", "/"), rs_exts, resolved_for_import)
            record()

        elif language == "java":
            if module:
                rel = module.replace(".", "/")
                resolve_bare(rel, java_exts, resolved_for_import)
            record()

        elif language in ("c", "cpp", "c++"):
            if module.startswith("."):
                resolve_relative(module, cpp_exts, resolved_for_import)
            else:
                resolve_bare(module, cpp_exts, resolved_for_import)
            record()

        else:
            if module.startswith("."):
                resolve_relative(module, js_exts, resolved_for_import)
            else:
                resolve_bare(module, js_exts, resolved_for_import)
            record()

    return ResolvedImports(files=resolved, symbols_by_file=symbols_by_file)


def _normalize_path(path: str) -> str:
    return "/".join([p for p in path.replace("\\", "/").split("/") if p and p != "."])
