"""
Repository Summarizer - Generate high-level repository overview.

Target: 300-800 tokens
Contents:
- Architecture description
- Entry points
- Major subsystems
- Coding conventions
- Tech stack
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
from collections import Counter, defaultdict
from typing import Dict, List, Optional, Set, Tuple

from ..core.types import RepoSummary, FileSummary
from ..ingestion import FileWalker, detect_language


logger = logging.getLogger("code_intel.summaries.repo")


# Framework detection patterns
FRAMEWORK_PATTERNS = {
    # Python
    "FastAPI": [r"from\s+fastapi\s+import", r"FastAPI\(\)"],
    "Django": [r"from\s+django", r"INSTALLED_APPS"],
    "Flask": [r"from\s+flask\s+import", r"Flask\(__name__\)"],
    "Pytest": [r"import\s+pytest", r"@pytest\."],
    
    # JavaScript/TypeScript
    "React": [r"from\s+['\"]react['\"]", r"import\s+React"],
    "Next.js": [r"from\s+['\"]next", r"next\.config"],
    "Vue": [r"from\s+['\"]vue['\"]", r"\.vue$"],
    "Express": [r"from\s+['\"]express['\"]", r"require\(['\"]express['\"]"],
    "NestJS": [r"from\s+['\"]@nestjs", r"@Module\("],
    
    # Other
    "Rust/Tokio": [r"tokio::", r"#\[tokio::main\]"],
    "Go/Gin": [r"github\.com/gin-gonic", r"gin\.Default\(\)"],
}


class RepoSummarizer:
    """
    Generate repository-level summaries.
    
    Analyzes:
    - File structure
    - Tech stack
    - Entry points
    - Subsystem organization
    - Conventions
    """
    
    def __init__(
        self,
        workspace_root: str,
        file_summaries: Optional[Dict[str, FileSummary]] = None,
    ):
        self.workspace_root = workspace_root
        self.file_summaries = file_summaries or {}
        self.walker = FileWalker(workspace_root)
    
    def summarize(self) -> RepoSummary:
        """
        Generate repository summary.
        
        Returns:
            RepoSummary object
        """
        # Collect file metadata
        files = list(self.walker.walk())
        
        # Detect languages
        languages = self._detect_languages(files)
        
        # Detect frameworks
        frameworks = self._detect_frameworks(files)
        
        # Detect architecture
        architecture = self._infer_architecture(files)
        
        # Find entry points
        entry_points = self._find_entry_points(files)
        
        # Identify subsystems
        subsystems = self._identify_subsystems(files)
        
        # Detect conventions
        conventions = self._detect_conventions(files)
        
        # Count stats
        total_symbols = sum(
            len(fs.public_api) for fs in self.file_summaries.values()
        )
        
        # Create state hash
        state_hash = self._compute_state_hash(files)
        
        return RepoSummary(
            architecture=architecture,
            entry_points=entry_points,
            subsystems=subsystems,
            conventions=conventions,
            languages=languages,
            frameworks=frameworks,
            total_files=len(files),
            total_symbols=total_symbols,
            state_hash=state_hash,
        )
    
    def _detect_languages(self, files: List) -> List[str]:
        """Detect primary languages used."""
        lang_counts = Counter()
        
        for file in files:
            lang = detect_language(file.path, file.content)
            if lang and lang != "unknown":
                lang_counts[lang] += 1
        
        # Return top languages (at least 5% of files)
        total = sum(lang_counts.values())
        threshold = max(1, total * 0.05)
        
        return [
            lang for lang, count in lang_counts.most_common(5)
            if count >= threshold
        ]
    
    def _detect_frameworks(self, files: List) -> List[str]:
        """Detect frameworks used."""
        detected = []
        
        # Sample files for efficiency
        sample_files = files[:100] if len(files) > 100 else files
        
        for framework, patterns in FRAMEWORK_PATTERNS.items():
            for file in sample_files:
                for pattern in patterns:
                    if re.search(pattern, file.content):
                        if framework not in detected:
                            detected.append(framework)
                        break
                else:
                    continue
                break
        
        return detected
    
    def _infer_architecture(self, files: List) -> str:
        """Infer overall architecture pattern."""
        paths = [f.relative_path for f in files]
        
        # Check for common patterns
        has_src = any(p.startswith("src/") for p in paths)
        has_lib = any(p.startswith("lib/") for p in paths)
        has_app = any(p.startswith("app/") for p in paths)
        has_pages = any(p.startswith("pages/") for p in paths)
        has_components = any("/components/" in p for p in paths)
        has_controllers = any("/controllers/" in p or "/controller/" in p for p in paths)
        has_services = any("/services/" in p or "/service/" in p for p in paths)
        has_models = any("/models/" in p or "/model/" in p for p in paths)
        has_api = any("/api/" in p for p in paths)
        has_routes = any("/routes/" in p for p in paths)
        
        # Determine architecture
        if has_pages and has_components:
            return "Next.js/Pages-based web application with components"
        
        if has_app and has_components:
            return "React/Component-based web application"
        
        if has_controllers and has_services and has_models:
            return "MVC/Service-layered backend application"
        
        if has_api and has_routes:
            return "REST API backend with route-based organization"
        
        if has_services and not has_controllers:
            return "Service-oriented architecture"
        
        if has_lib and has_src:
            return "Library/SDK with source and lib directories"
        
        if has_src:
            return "Standard src-based project structure"
        
        # Check for monorepo
        package_dirs = set()
        for p in paths:
            parts = p.split("/")
            if len(parts) > 1 and parts[0] in ("packages", "apps", "libs", "modules"):
                package_dirs.add(parts[0])
        
        if package_dirs:
            return f"Monorepo with {', '.join(package_dirs)}"
        
        return "Flat project structure"
    
    def _find_entry_points(self, files: List) -> List[str]:
        """Find likely entry points."""
        entry_points = []
        
        # Common entry point names
        entry_names = {
            "main.py", "app.py", "server.py", "index.py",
            "main.ts", "index.ts", "app.ts", "server.ts",
            "main.js", "index.js", "app.js", "server.js",
            "main.go", "main.rs", "Main.java",
        }
        
        for file in files:
            filename = file.relative_path.split("/")[-1]
            
            # Check for known entry point names
            if filename in entry_names:
                entry_points.append(file.relative_path)
                continue
            
            # Check for main function patterns
            content = file.content[:2000]  # Only check beginning
            if re.search(r'if\s+__name__\s*==\s*["\']__main__["\']', content):
                entry_points.append(file.relative_path)
            elif re.search(r'func\s+main\s*\(\)', content):
                entry_points.append(file.relative_path)
            elif re.search(r'public\s+static\s+void\s+main', content):
                entry_points.append(file.relative_path)
        
        # Sort by likelihood (shorter paths first)
        entry_points.sort(key=lambda p: (p.count("/"), len(p)))
        
        return entry_points[:5]
    
    def _identify_subsystems(self, files: List) -> List[str]:
        """Identify major subsystems from directory structure."""
        # Count files per top-level directory
        dir_counts = defaultdict(int)
        
        for file in files:
            parts = file.relative_path.split("/")
            if len(parts) > 1:
                top_dir = parts[0]
                # Skip common non-subsystem directories
                if top_dir not in ("node_modules", ".git", "__pycache__", "dist", "build"):
                    dir_counts[top_dir] += 1
        
        # Identify significant directories
        subsystems = []
        total_files = len(files)
        
        for dir_name, count in sorted(dir_counts.items(), key=lambda x: -x[1]):
            # Include if has >3% of files or >5 files
            if count > total_files * 0.03 or count > 5:
                # Describe the subsystem
                description = self._describe_subsystem(dir_name, files)
                subsystems.append(f"{dir_name}/: {description}")
        
        return subsystems[:8]
    
    def _describe_subsystem(self, dir_name: str, files: List) -> str:
        """Generate a brief description for a subsystem."""
        # Common directory meanings
        meanings = {
            "src": "Main source code",
            "lib": "Library code",
            "app": "Application code",
            "api": "API endpoints",
            "components": "UI components",
            "pages": "Page components",
            "models": "Data models",
            "services": "Business logic",
            "controllers": "Request handlers",
            "utils": "Utility functions",
            "helpers": "Helper functions",
            "tests": "Test files",
            "test": "Test files",
            "__tests__": "Test files",
            "config": "Configuration",
            "types": "Type definitions",
            "interfaces": "Interface definitions",
            "hooks": "React hooks",
            "store": "State management",
            "redux": "Redux state",
            "styles": "Stylesheets",
            "assets": "Static assets",
            "public": "Public assets",
            "docs": "Documentation",
            "scripts": "Build/utility scripts",
            "migrations": "Database migrations",
            "middleware": "Middleware functions",
            "routes": "Route definitions",
            "views": "View templates",
        }
        
        if dir_name.lower() in meanings:
            return meanings[dir_name.lower()]
        
        # Analyze files in directory
        dir_files = [f for f in files if f.relative_path.startswith(dir_name + "/")]
        if not dir_files:
            return "Unknown purpose"
        
        # Check for patterns
        has_tests = any("test" in f.relative_path.lower() for f in dir_files)
        if has_tests:
            return "Tests"
        
        return f"{len(dir_files)} files"
    
    def _detect_conventions(self, files: List) -> List[str]:
        """Detect coding conventions."""
        conventions = []
        
        # Sample files
        sample = files[:50] if len(files) > 50 else files
        
        # Check for common conventions
        uses_type_hints = any(
            re.search(r'def\s+\w+\([^)]*:\s*\w+', f.content) for f in sample
            if f.relative_path.endswith(".py")
        )
        if uses_type_hints:
            conventions.append("Python type hints")
        
        uses_typescript = any(
            f.relative_path.endswith(".ts") or f.relative_path.endswith(".tsx")
            for f in files
        )
        if uses_typescript:
            conventions.append("TypeScript for type safety")
        
        uses_async = any(
            re.search(r'\basync\s+def|\basync\s+function|\basync\s*\(', f.content)
            for f in sample
        )
        if uses_async:
            conventions.append("Async/await patterns")
        
        uses_docstrings = any(
            re.search(r'"""[\s\S]*?"""', f.content) for f in sample
            if f.relative_path.endswith(".py")
        )
        if uses_docstrings:
            conventions.append("Docstrings for documentation")
        
        uses_jsdoc = any(
            re.search(r'/\*\*[\s\S]*?\*/', f.content) for f in sample
            if f.relative_path.endswith((".js", ".ts"))
        )
        if uses_jsdoc:
            conventions.append("JSDoc comments")
        
        # Check for testing
        has_tests = any("test" in f.relative_path.lower() for f in files)
        if has_tests:
            conventions.append("Includes test coverage")
        
        return conventions[:5]
    
    def _compute_state_hash(self, files: List) -> str:
        """Compute hash representing current repo state."""
        hashes = sorted(f.content_hash for f in files)
        combined = "".join(hashes)
        return hashlib.md5(combined.encode()).hexdigest()[:16]


def summarize_repository(
    workspace_root: str,
    file_summaries: Optional[Dict[str, FileSummary]] = None,
) -> RepoSummary:
    """Convenience function to summarize a repository."""
    summarizer = RepoSummarizer(workspace_root, file_summaries)
    return summarizer.summarize()
