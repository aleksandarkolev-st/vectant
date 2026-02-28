"""
Tests for the dependency graph (ai_deps.py).
"""

import os
import tempfile
import pytest

from analyzer.proactive.healing.ai_deps import (
    DependencyGraph,
    _extract_import_specifiers,
    get_dependency_graph,
)


class TestImportExtraction:
    """Test import specifier parsing for each language."""

    def test_js_esm_imports(self):
        code = """
import React from 'react';
import { useState } from 'react';
import utils from './utils';
import { helper } from '../lib/helpers';
"""
        result = _extract_import_specifiers(code, "javascript")
        assert "react" in result
        assert "./utils" in result
        assert "../lib/helpers" in result

    def test_js_require(self):
        code = """
const fs = require('fs');
const local = require('./local');
const deep = require('../deep/module');
"""
        result = _extract_import_specifiers(code, "javascript")
        assert "fs" in result
        assert "./local" in result
        assert "../deep/module" in result

    def test_ts_imports(self):
        code = """
import type { Config } from './config';
import { run } from '../runner';
"""
        result = _extract_import_specifiers(code, "typescript")
        assert "./config" in result
        assert "../runner" in result

    def test_python_imports(self):
        code = """
import os
from pathlib import Path
from . import utils
from ..models import User
import json
"""
        result = _extract_import_specifiers(code, "python")
        assert "os" in result
        assert "pathlib" in result
        assert "." in result or "utils" in result  # depends on regex capture
        assert "json" in result

    def test_rust_use(self):
        code = """
use crate::models::User;
use std::collections::HashMap;
use crate::utils;
"""
        result = _extract_import_specifiers(code, "rust")
        assert any("models" in s for s in result)
        assert any("utils" in s for s in result)

    def test_unknown_language(self):
        code = "import something"
        result = _extract_import_specifiers(code, "brainfuck")
        assert result == []


class TestDependencyGraph:
    """Test the DependencyGraph class."""

    def test_add_file_and_dependencies(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create real files for resolution
            os.makedirs(os.path.join(tmpdir, "src"), exist_ok=True)
            with open(os.path.join(tmpdir, "src", "utils.js"), "w") as f:
                f.write("export function helper() {}")
            with open(os.path.join(tmpdir, "src", "app.js"), "w") as f:
                f.write("import { helper } from './utils';")

            graph = DependencyGraph(workspace_root=tmpdir)
            graph.add_file(
                "src/app.js",
                "import { helper } from './utils';",
                "javascript",
            )

            deps = graph.dependencies_of("src/app.js")
            assert "src/utils.js" in deps

    def test_dependents_of(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            os.makedirs(os.path.join(tmpdir, "src"), exist_ok=True)
            with open(os.path.join(tmpdir, "src", "utils.js"), "w") as f:
                f.write("export const x = 1;")
            with open(os.path.join(tmpdir, "src", "app.js"), "w") as f:
                f.write("import { x } from './utils';")

            graph = DependencyGraph(workspace_root=tmpdir)
            graph.add_file("src/app.js", "import { x } from './utils';", "javascript")

            dependents = graph.dependents_of("src/utils.js")
            assert "src/app.js" in dependents

    def test_remove_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            os.makedirs(os.path.join(tmpdir, "src"), exist_ok=True)
            with open(os.path.join(tmpdir, "src", "utils.js"), "w") as f:
                f.write("export const x = 1;")

            graph = DependencyGraph(workspace_root=tmpdir)
            graph.add_file("src/app.js", "import { x } from './utils';", "javascript")
            assert graph.dependents_of("src/utils.js") == {"src/app.js"}

            graph.remove_file("src/app.js")
            assert graph.dependents_of("src/utils.js") == set()

    def test_transitive_dependents(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            os.makedirs(os.path.join(tmpdir, "src"), exist_ok=True)
            with open(os.path.join(tmpdir, "src", "a.js"), "w") as f:
                f.write("export const a = 1;")
            with open(os.path.join(tmpdir, "src", "b.js"), "w") as f:
                f.write("import { a } from './a';")
            with open(os.path.join(tmpdir, "src", "c.js"), "w") as f:
                f.write("import { b } from './b';")

            graph = DependencyGraph(workspace_root=tmpdir)
            graph.add_file("src/b.js", "import { a } from './a';", "javascript")
            graph.add_file("src/c.js", "import { b } from './b';", "javascript")

            transitive = graph.transitive_dependents("src/a.js")
            assert "src/b.js" in transitive
            assert "src/c.js" in transitive

    def test_summary(self):
        graph = DependencyGraph()
        assert graph.summary()["total_files"] == 0

        graph.add_file("a.py", "import os", "python")
        summary = graph.summary()
        assert summary["total_files"] >= 1

    def test_bare_specifiers_ignored(self):
        """npm package imports should not create edges."""
        graph = DependencyGraph(workspace_root="/tmp/fake")
        graph.add_file("app.js", "import React from 'react';", "javascript")
        assert graph.dependencies_of("app.js") == set()

    def test_files_property(self):
        graph = DependencyGraph()
        graph.add_file("a.js", "", "javascript")
        graph.add_file("b.js", "", "javascript")
        assert set(graph.files) == {"a.js", "b.js"}


class TestSingleton:
    """Test the module singleton."""

    def test_get_dependency_graph_creates_instance(self):
        g1 = get_dependency_graph("/tmp/workspace1")
        g2 = get_dependency_graph("/tmp/workspace1")
        assert g1 is g2

    def test_different_workspace_creates_new(self):
        g1 = get_dependency_graph("/tmp/ws_a")
        g2 = get_dependency_graph("/tmp/ws_b")
        assert g1 is not g2
