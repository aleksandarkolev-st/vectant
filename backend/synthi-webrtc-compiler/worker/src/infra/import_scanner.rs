//! Import scanner for projects without manifest files.
//!
//! When `dep_installer` finds no manifest (no `package.json`, `requirements.txt`,
//! `Cargo.toml`, etc.), this module scans source files for import/include patterns
//! and installs the detected third-party packages.
//!
//! This solves the "standalone file" problem where a user has a single `main.py`
//! with `import flask` but no `requirements.txt`.  The scanner recognises standard
//! import syntax for every supported language and filters out stdlib/local modules.
//!
//! Design principles:
//! - Best-effort: failures never prevent LSP startup.
//! - Fast: regex-based line scanning, no AST parsing.
//! - Conservative: only installs packages that look like third-party names.
//! - Idempotent: skipped if `.synthi_imports_scanned` marker exists.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tokio::process::Command;
use std::process::Stdio;

/// Directories we never descend into.
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "__pycache__", "target", "build", "dist",
    ".gradle", ".idea", "bin", "obj", ".dart_tool", "_build", "deps",
    ".elixir_ls", ".jdtls-data", "zig-cache", ".next", "vendor",
    "zig-out", ".zig-cache", "coverage", ".nyc_output", ".tox",
    "venv", ".venv", "env", ".env", ".mypy_cache", ".pytest_cache",
];

const MAX_DEPTH: usize = 4;
/// Max file size to scan (skip very large files).
const MAX_FILE_SIZE: u64 = 500_000; // 500KB

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/// Scan workspace source files for imports and install detected third-party
/// packages.  Only runs when no manifest files were found by `dep_installer`.
///
/// `lang` is the primary language being used (from the LSP channel label).
/// Returns the number of packages successfully installed.
pub async fn scan_and_install(workspace: &Path, lang: &str, force: bool) -> usize {
    let marker = workspace.join(".synthi_imports_scanned");
    if !force && marker.exists() {
        println!("[IMPORT-SCAN] Already scanned (marker exists), skipping.");
        return 0;
    }

    println!("[IMPORT-SCAN] Scanning source files for imports (lang={})...", lang);
    let packages = scan_imports(workspace, lang);

    if packages.is_empty() {
        println!("[IMPORT-SCAN] No third-party imports detected.");
        let _ = std::fs::write(&marker, "done-no-deps");
        return 0;
    }

    println!("[IMPORT-SCAN] Detected {} third-party package(s): {:?}",
        packages.len(), packages.iter().take(20).collect::<Vec<_>>());

    let ok_count = install_packages(workspace, lang, &packages).await;

    println!("[IMPORT-SCAN] Installed {}/{} packages.", ok_count, packages.len());
    let _ = std::fs::write(&marker, format!("installed {} of {}", ok_count, packages.len()));
    ok_count
}

// ────────────────────────────────────────────────────────────────
// Import scanning
// ────────────────────────────────────────────────────────────────

fn scan_imports(root: &Path, lang: &str) -> Vec<String> {
    let mut imports = HashSet::new();
    let extensions = extensions_for_lang(lang);
    walk_source_files(root, 0, &extensions, &mut |path| {
        if let Ok(metadata) = std::fs::metadata(path) {
            if metadata.len() > MAX_FILE_SIZE {
                return;
            }
        }
        if let Ok(content) = std::fs::read_to_string(path) {
            extract_imports(&content, lang, &mut imports);
        }
    });

    // Filter out known stdlib modules and local imports
    let stdlib = stdlib_modules(lang);
    imports.into_iter()
        .filter(|pkg| !stdlib.contains(pkg.as_str()))
        .filter(|pkg| !is_likely_local(pkg))
        .collect()
}

fn extensions_for_lang(lang: &str) -> Vec<&'static str> {
    match lang {
        "python" | "py" => vec!["py"],
        "javascript" | "js" => vec!["js", "jsx", "mjs", "cjs"],
        "typescript" | "ts" => vec!["ts", "tsx", "mts", "cts", "js", "jsx"],
        "go" => vec!["go"],
        "rust" => vec!["rs"],
        "java" => vec!["java"],
        "cpp" | "c" => vec!["cpp", "cc", "cxx", "c", "h", "hpp", "hxx"],
        "csharp" | "cs" => vec!["cs"],
        "ruby" | "rb" => vec!["rb"],
        "php" => vec!["php"],
        "kotlin" | "kt" => vec!["kt", "kts"],
        "dart" => vec!["dart"],
        "elixir" | "ex" => vec!["ex", "exs"],
        "lua" => vec!["lua"],
        "zig" => vec!["zig"],
        "svelte" => vec!["svelte", "ts", "js"],
        _ => vec![],
    }
}

fn walk_source_files(dir: &Path, depth: usize, extensions: &[&str], cb: &mut dyn FnMut(&Path)) {
    if depth > MAX_DEPTH {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if path.is_dir() {
            let lower = name_str.to_ascii_lowercase();
            if SKIP_DIRS.contains(&lower.as_str()) {
                continue;
            }
            subdirs.push(path);
            continue;
        }

        if let Some(ext) = path.extension() {
            let ext_str = ext.to_string_lossy().to_ascii_lowercase();
            if extensions.iter().any(|e| *e == ext_str.as_str()) {
                cb(&path);
            }
        }
    }
    for sub in subdirs {
        walk_source_files(&sub, depth + 1, extensions, cb);
    }
}

fn extract_imports(content: &str, lang: &str, imports: &mut HashSet<String>) {
    for line in content.lines() {
        let trimmed = line.trim();
        match lang {
            "python" | "py" => extract_python_imports(trimmed, imports),
            "javascript" | "js" | "typescript" | "ts" | "svelte" => extract_js_imports(trimmed, imports),
            "go" => extract_go_imports(trimmed, imports),
            "rust" => extract_rust_imports(trimmed, imports),
            "java" | "kotlin" | "kt" => extract_java_imports(trimmed, imports),
            "cpp" | "c" => extract_cpp_includes(trimmed, imports),
            "csharp" | "cs" => extract_csharp_imports(trimmed, imports),
            "ruby" | "rb" => extract_ruby_imports(trimmed, imports),
            "php" => extract_php_imports(trimmed, imports),
            "dart" => extract_dart_imports(trimmed, imports),
            "elixir" | "ex" => extract_elixir_imports(trimmed, imports),
            "lua" => extract_lua_imports(trimmed, imports),
            _ => {}
        }
    }
}

// ── Language-specific extractors ────────────────────────────────

fn extract_python_imports(line: &str, imports: &mut HashSet<String>) {
    // `import flask` → "flask"
    // `from flask import Blueprint` → "flask"
    // `import flask.views` → "flask"
    // `from . import foo` → skip (relative)
    if let Some(rest) = line.strip_prefix("import ") {
        for part in rest.split(',') {
            let module = part.trim().split_whitespace().next().unwrap_or("");
            let top = module.split('.').next().unwrap_or("");
            if !top.is_empty() && !top.starts_with('.') {
                imports.insert(top.to_string());
            }
        }
    } else if let Some(rest) = line.strip_prefix("from ") {
        if rest.starts_with('.') {
            return; // relative import
        }
        let module = rest.split_whitespace().next().unwrap_or("");
        let top = module.split('.').next().unwrap_or("");
        if !top.is_empty() {
            imports.insert(top.to_string());
        }
    }
}

fn extract_js_imports(line: &str, imports: &mut HashSet<String>) {
    // `import express from 'express'` → "express"
    // `import { foo } from "@scope/bar"` → "@scope/bar"
    // `const x = require('lodash')` → "lodash"
    // Skip relative imports: './foo', '../bar'
    let extract_from_quotes = |s: &str| -> Option<String> {
        let start = s.find(|c| c == '\'' || c == '"')?;
        let rest = &s[start + 1..];
        let end = rest.find(|c| c == '\'' || c == '"')?;
        let pkg = &rest[..end];
        if pkg.starts_with('.') || pkg.starts_with('/') {
            return None;
        }
        // Scoped packages: @scope/name → return full "@scope/name"
        if pkg.starts_with('@') {
            let parts: Vec<&str> = pkg.splitn(3, '/').collect();
            if parts.len() >= 2 {
                return Some(format!("{}/{}", parts[0], parts[1]));
            }
        }
        // Regular: 'lodash/fp' → "lodash"
        Some(pkg.split('/').next().unwrap_or(pkg).to_string())
    };

    if line.starts_with("import ") || line.starts_with("export ") {
        if let Some(from_idx) = line.find(" from ") {
            if let Some(pkg) = extract_from_quotes(&line[from_idx..]) {
                imports.insert(pkg);
            }
        } else if let Some(pkg) = extract_from_quotes(line) {
            // `import 'side-effect-package'`
            imports.insert(pkg);
        }
    }
    if line.contains("require(") {
        if let Some(pkg) = extract_from_quotes(line) {
            imports.insert(pkg);
        }
    }
}

fn extract_go_imports(line: &str, imports: &mut HashSet<String>) {
    // `import "github.com/gin-gonic/gin"` → "github.com/gin-gonic/gin"
    // Inside import block: `"github.com/gin-gonic/gin"`
    // Skip stdlib (no dots in path)
    let extract = |s: &str| -> Option<String> {
        let start = s.find('"')?;
        let rest = &s[start + 1..];
        let end = rest.find('"')?;
        let pkg = &rest[..end];
        // Go stdlib has no dots (e.g., "fmt", "os", "net/http")
        // Third-party always has a domain (e.g., "github.com/...")
        if pkg.contains('.') {
            Some(pkg.to_string())
        } else {
            None
        }
    };

    if line.starts_with("import ") || line.trim_start().starts_with('"') {
        if let Some(pkg) = extract(line) {
            imports.insert(pkg);
        }
    }
}

fn extract_rust_imports(line: &str, imports: &mut HashSet<String>) {
    // `use serde::Serialize;` → "serde"
    // `extern crate rand;` → "rand"
    // Skip `std`, `core`, `alloc`, `self`, `super`, `crate`
    if let Some(rest) = line.strip_prefix("use ") {
        let crate_name = rest.split("::").next().unwrap_or("").trim();
        if !crate_name.is_empty() {
            imports.insert(crate_name.to_string());
        }
    } else if let Some(rest) = line.strip_prefix("extern crate ") {
        let crate_name = rest.trim_end_matches(';').trim();
        if !crate_name.is_empty() {
            imports.insert(crate_name.to_string());
        }
    }
}

fn extract_java_imports(line: &str, imports: &mut HashSet<String>) {
    // `import com.google.gson.Gson;` → "com.google.gson"
    // Skip `java.*`, `javax.*`, `kotlin.*`, `kotlinx.*`
    if let Some(rest) = line.strip_prefix("import ") {
        let rest = rest.strip_prefix("static ").unwrap_or(rest);
        let pkg = rest.trim_end_matches(';').trim();
        // Take up to the third dot for the group ID approximation
        let parts: Vec<&str> = pkg.split('.').collect();
        if parts.len() >= 3 {
            let group = format!("{}.{}.{}", parts[0], parts[1], parts[2]);
            imports.insert(group);
        }
    }
}

fn extract_cpp_includes(line: &str, imports: &mut HashSet<String>) {
    // `#include <boost/asio.hpp>` → "boost"
    // `#include <opencv2/core.hpp>` → "opencv2"
    // `#include "myheader.h"` → skip (local)
    // `#include <iostream>` → skip (stdlib, no slash)
    if let Some(rest) = line.strip_prefix("#include") {
        let rest = rest.trim();
        if rest.starts_with('<') {
            if let Some(end) = rest.find('>') {
                let header = &rest[1..end];
                // Only third-party includes have a slash (boost/..., opencv2/...)
                // Pure stdlib like <iostream>, <vector> have no slash
                if let Some(top) = header.split('/').next() {
                    if header.contains('/') {
                        imports.insert(top.to_string());
                    }
                }
            }
        }
    }
}

fn extract_csharp_imports(line: &str, imports: &mut HashSet<String>) {
    // `using Newtonsoft.Json;` → "Newtonsoft.Json"
    // Skip `System.*`, `Microsoft.*`
    if let Some(rest) = line.strip_prefix("using ") {
        let rest = rest.strip_prefix("static ").unwrap_or(rest);
        // Skip `using Alias = ...`
        if rest.contains('=') {
            return;
        }
        let ns = rest.trim_end_matches(';').trim();
        if !ns.is_empty() {
            // Take first two parts as package name
            let parts: Vec<&str> = ns.split('.').collect();
            if parts.len() >= 2 {
                imports.insert(format!("{}.{}", parts[0], parts[1]));
            } else {
                imports.insert(ns.to_string());
            }
        }
    }
}

fn extract_ruby_imports(line: &str, imports: &mut HashSet<String>) {
    // `require 'sinatra'` → "sinatra"
    // `require "rails"` → "rails"
    // Skip `require_relative`
    if line.starts_with("require_relative") {
        return;
    }
    if let Some(rest) = line.strip_prefix("require ") {
        let rest = rest.trim();
        if let Some(start) = rest.find(|c| c == '\'' || c == '"') {
            let rest = &rest[start + 1..];
            if let Some(end) = rest.find(|c| c == '\'' || c == '"') {
                let gem = &rest[..end];
                // Skip paths with '/' (likely local)
                if !gem.contains('/') && !gem.is_empty() {
                    imports.insert(gem.to_string());
                }
            }
        }
    }
}

fn extract_php_imports(line: &str, imports: &mut HashSet<String>) {
    // `use Monolog\Logger;` → "monolog"
    // `use GuzzleHttp\Client;` → "guzzlehttp"
    if let Some(rest) = line.strip_prefix("use ") {
        let ns = rest.trim_end_matches(';').trim();
        if let Some(top) = ns.split('\\').next() {
            let pkg = top.to_lowercase();
            if !pkg.is_empty() {
                imports.insert(pkg);
            }
        }
    }
}

fn extract_dart_imports(line: &str, imports: &mut HashSet<String>) {
    // `import 'package:http/http.dart';` → "http"
    // Skip `dart:*` (stdlib)
    if let Some(rest) = line.strip_prefix("import ") {
        let rest = rest.trim().trim_matches(|c| c == '\'' || c == '"');
        if let Some(pkg) = rest.strip_prefix("package:") {
            if let Some(name) = pkg.split('/').next() {
                imports.insert(name.to_string());
            }
        }
    }
}

fn extract_elixir_imports(line: &str, imports: &mut HashSet<String>) {
    // `{:phoenix, "~> 1.7"}` in mix.exs — but for standalone files:
    // `import Plug.Conn` → skip (stdlib-ish)
    // Actually for Elixir standalone, imports don't really indicate deps.
    // We look for `{:package_name, ...}` tuples in mix.exs-like content.
    if line.trim_start().starts_with("{:") {
        if let Some(rest) = line.trim_start().strip_prefix("{:") {
            if let Some(name) = rest.split(',').next() {
                let pkg = name.trim();
                if !pkg.is_empty() {
                    imports.insert(pkg.to_string());
                }
            }
        }
    }
}

fn extract_lua_imports(line: &str, imports: &mut HashSet<String>) {
    // `local http = require("socket.http")` → "socket"
    // `require("lfs")` → "lfs"  
    if line.contains("require") {
        if let Some(start) = line.find(|c: char| c == '\'' || c == '"') {
            let rest = &line[start + 1..];
            if let Some(end) = rest.find(|c: char| c == '\'' || c == '"') {
                let module = &rest[..end];
                let top = module.split('.').next().unwrap_or(module);
                if !top.is_empty() {
                    imports.insert(top.to_string());
                }
            }
        }
    }
}

// ── Stdlib filters ──────────────────────────────────────────────

fn stdlib_modules(lang: &str) -> HashSet<&'static str> {
    match lang {
        "python" | "py" => {
            // Python stdlib top-level modules (comprehensive but not exhaustive)
            [
                "abc", "aifc", "argparse", "array", "ast", "asynchat", "asyncio",
                "asyncore", "atexit", "audioop", "base64", "bdb", "binascii",
                "binhex", "bisect", "builtins", "bz2", "calendar", "cgi", "cgitb",
                "chunk", "cmath", "cmd", "code", "codecs", "codeop", "collections",
                "colorsys", "compileall", "concurrent", "configparser", "contextlib",
                "contextvars", "copy", "copyreg", "cProfile", "crypt", "csv",
                "ctypes", "curses", "dataclasses", "datetime", "dbm", "decimal",
                "difflib", "dis", "distutils", "doctest", "email", "encodings",
                "enum", "errno", "faulthandler", "fcntl", "filecmp", "fileinput",
                "fnmatch", "formatter", "fractions", "ftplib", "functools", "gc",
                "getopt", "getpass", "gettext", "glob", "grp", "gzip", "hashlib",
                "heapq", "hmac", "html", "http", "idlelib", "imaplib", "imghdr",
                "imp", "importlib", "inspect", "io", "ipaddress", "itertools",
                "json", "keyword", "lib2to3", "linecache", "locale", "logging",
                "lzma", "mailbox", "mailcap", "marshal", "math", "mimetypes",
                "mmap", "modulefinder", "multiprocessing", "netrc", "nis", "nntplib",
                "numbers", "operator", "optparse", "os", "ossaudiodev", "parser",
                "pathlib", "pdb", "pickle", "pickletools", "pipes", "pkgutil",
                "platform", "plistlib", "poplib", "posix", "posixpath", "pprint",
                "profile", "pstats", "pty", "pwd", "py_compile", "pyclbr",
                "pydoc", "queue", "quopri", "random", "re", "readline", "reprlib",
                "resource", "rlcompleter", "runpy", "sched", "secrets", "select",
                "selectors", "shelve", "shlex", "shutil", "signal", "site",
                "smtpd", "smtplib", "sndhdr", "socket", "socketserver", "sqlite3",
                "ssl", "stat", "statistics", "string", "stringprep", "struct",
                "subprocess", "sunau", "symtable", "sys", "sysconfig", "syslog",
                "tabnanny", "tarfile", "telnetlib", "tempfile", "termios", "test",
                "textwrap", "threading", "time", "timeit", "tkinter", "token",
                "tokenize", "tomllib", "trace", "traceback", "tracemalloc",
                "tty", "turtle", "turtledemo", "types", "typing", "unicodedata",
                "unittest", "urllib", "uu", "uuid", "venv", "warnings", "wave",
                "weakref", "webbrowser", "winreg", "winsound", "wsgiref",
                "xdrlib", "xml", "xmlrpc", "zipapp", "zipfile", "zipimport",
                "zlib", "_thread", "__future__",
            ].iter().copied().collect()
        }
        "rust" => {
            ["std", "core", "alloc", "self", "super", "crate", "proc_macro"]
                .iter().copied().collect()
        }
        "go" => {
            // Go stdlib is detected by absence of dots — handled in extract_go_imports
            HashSet::new()
        }
        "java" | "kotlin" | "kt" => {
            ["java", "javax", "kotlin", "kotlinx", "sun", "com.sun", "org.xml", "org.w3c"]
                .iter().copied().collect()
        }
        "csharp" | "cs" => {
            ["System", "Microsoft", "Windows"]
                .iter().copied().collect()
        }
        "ruby" | "rb" => {
            // Ruby stdlib gems
            [
                "abbrev", "base64", "benchmark", "bigdecimal", "bundler", "cgi",
                "csv", "date", "delegate", "digest", "drb", "english", "erb",
                "etc", "fcntl", "fiddle", "fileutils", "find", "forwardable",
                "getoptlong", "io", "ipaddr", "irb", "json", "logger", "matrix",
                "minitest", "monitor", "mutex_m", "net", "nkf", "observer",
                "open3", "openssl", "optparse", "ostruct", "pathname", "pp",
                "prettyprint", "prime", "pstore", "psych", "racc", "rake",
                "rdoc", "readline", "reline", "resolv", "rinda", "ripper",
                "securerandom", "set", "shellwords", "singleton", "socket",
                "stringio", "strscan", "syslog", "tempfile", "test",
                "time", "timeout", "tmpdir", "tsort", "un", "uri", "weakref",
                "yaml", "zlib",
            ].iter().copied().collect()
        }
        "cpp" | "c" => {
            // C/C++ system headers with slashes that look third-party but aren't
            [
                "sys", "net", "arpa", "linux", "asm", "bits", "gnu",
                "X11", "GL", "EGL", "GLES", "GLES2", "GLES3",
            ].iter().copied().collect()
        }
        "lua" => {
            ["string", "table", "math", "io", "os", "coroutine", "debug", "package", "utf8"]
                .iter().copied().collect()
        }
        _ => HashSet::new(),
    }
}

fn is_likely_local(pkg: &str) -> bool {
    // Names that look like local modules
    pkg.starts_with('.')
        || pkg.starts_with('/')
        || pkg.starts_with("./")
        || pkg.starts_with("../")
        || pkg == "_"
        || pkg.is_empty()
}

// ── Package name mapping ────────────────────────────────────────
// Some import names differ from package manager names.
// e.g., `import cv2` → `pip install opencv-python`
//       `import PIL` → `pip install Pillow`

fn map_python_package(import_name: &str) -> &str {
    match import_name {
        "cv2" => "opencv-python",
        "PIL" => "Pillow",
        "sklearn" => "scikit-learn",
        "skimage" => "scikit-image",
        "bs4" => "beautifulsoup4",
        "yaml" => "PyYAML",
        "attr" => "attrs",
        "dotenv" => "python-dotenv",
        "jwt" => "PyJWT",
        "serial" => "pyserial",
        "usb" => "pyusb",
        "gi" => "PyGObject",
        "wx" => "wxPython",
        "Crypto" => "pycryptodome",
        "lxml" => "lxml",
        "dateutil" => "python-dateutil",
        "magic" => "python-magic",
        "docx" => "python-docx",
        "pptx" => "python-pptx",
        "google" => "google-api-python-client",
        _ => import_name,
    }
}

/// Map C++ include directory names to apt package names.
fn map_cpp_package(include_dir: &str) -> Option<&'static str> {
    match include_dir {
        "boost" => Some("libboost-all-dev"),
        "opencv2" | "opencv4" => Some("libopencv-dev"),
        "eigen3" | "Eigen" => Some("libeigen3-dev"),
        "curl" => Some("libcurl4-openssl-dev"),
        "jsoncpp" | "json" => Some("libjsoncpp-dev"),
        "fmt" => Some("libfmt-dev"),
        "spdlog" => Some("libspdlog-dev"),
        "SDL2" | "SDL" => Some("libsdl2-dev"),
        "SFML" => Some("libsfml-dev"),
        "gtk" => Some("libgtk-3-dev"),
        "ncurses" | "curses" => Some("libncurses-dev"),
        "png" => Some("libpng-dev"),
        "jpeg" | "jpeglib" => Some("libjpeg-dev"),
        "tiff" => Some("libtiff-dev"),
        "freetype" => Some("libfreetype-dev"),
        "sqlite3" => Some("libsqlite3-dev"),
        "gtest" | "gmock" => Some("libgtest-dev"),
        "protobuf" => Some("libprotobuf-dev"),
        "grpc" | "grpcpp" => Some("libgrpc++-dev"),
        "yaml-cpp" => Some("libyaml-cpp-dev"),
        "zmq" => Some("libzmq3-dev"),
        "websocketpp" => Some("libwebsocketpp-dev"),
        "glfw" | "GLFW" => Some("libglfw3-dev"),
        "glm" => Some("libglm-dev"),
        "asio" => Some("libasio-dev"),
        "cryptopp" | "crypto++" => Some("libcrypto++-dev"),
        "openssl" => Some("libssl-dev"),
        "zlib" => Some("zlib1g-dev"),
        _ => None,
    }
}

// ────────────────────────────────────────────────────────────────
// Package installation
// ────────────────────────────────────────────────────────────────

async fn install_packages(workspace: &Path, lang: &str, packages: &[String]) -> usize {
    match lang {
        "python" | "py" => install_python_packages(packages).await,
        "javascript" | "js" | "typescript" | "ts" | "svelte" => {
            install_js_packages(workspace, packages).await
        }
        "go" => install_go_packages(workspace, packages).await,
        "ruby" | "rb" => install_ruby_packages(packages).await,
        "php" => install_php_packages(workspace, packages).await,
        "dart" => install_dart_packages(workspace, packages).await,
        "cpp" | "c" => install_cpp_packages(packages).await,
        "csharp" | "cs" => install_dotnet_packages(workspace, packages).await,
        "lua" => install_lua_packages(packages).await,
        // Rust/Java/Kotlin/Go need a proper project manifest; standalone import install
        // isn't practical. Just return 0.
        _ => {
            println!("[IMPORT-SCAN] No standalone package installer for lang={}", lang);
            0
        }
    }
}

async fn install_python_packages(packages: &[String]) -> usize {
    let mapped: Vec<&str> = packages.iter().map(|p| map_python_package(p)).collect();
    if mapped.is_empty() {
        return 0;
    }
    // Install all at once for speed.
    // --break-system-packages is needed on modern Debian/Ubuntu (PEP 668)
    // where the worker runs in an isolated container anyway.
    let result = run_cmd("pip", &[
        &["install", "--quiet", "--break-system-packages"],
        mapped.as_slice(),
    ].concat(), None).await;
    match result {
        Ok(()) => mapped.len(),
        Err(e) => {
            eprintln!("[IMPORT-SCAN] pip install failed: {}, trying individually...", e);
            // Try each individually
            let mut ok = 0;
            for pkg in &mapped {
                if run_cmd("pip", &["install", "--quiet", "--break-system-packages", pkg], None).await.is_ok() {
                    ok += 1;
                }
            }
            ok
        }
    }
}

async fn install_js_packages(workspace: &Path, packages: &[String]) -> usize {
    // Create a minimal package.json if none exists, then npm install
    let pkg_json = workspace.join("package.json");
    if !pkg_json.exists() {
        let content = serde_json::json!({
            "name": "synthi-workspace",
            "version": "0.0.0",
            "private": true,
            "dependencies": {}
        });
        let _ = std::fs::write(&pkg_json, serde_json::to_string_pretty(&content).unwrap_or_default());
    }

    let pkgs: Vec<&str> = packages.iter().map(|s| s.as_str()).collect();
    let mut args = vec!["install", "--save", "--ignore-scripts"];
    args.extend_from_slice(&pkgs);

    match run_cmd("npm", &args, Some(workspace)).await {
        Ok(()) => packages.len(),
        Err(e) => {
            eprintln!("[IMPORT-SCAN] npm install failed: {}", e);
            0
        }
    }
}

async fn install_go_packages(workspace: &Path, packages: &[String]) -> usize {
    // Initialize go.mod if it doesn't exist
    let go_mod = workspace.join("go.mod");
    if !go_mod.exists() {
        let _ = run_cmd("go", &["mod", "init", "synthi-workspace"], Some(workspace)).await;
    }
    let mut ok = 0;
    for pkg in packages {
        if run_cmd("go", &["get", pkg], Some(workspace)).await.is_ok() {
            ok += 1;
        }
    }
    ok
}

async fn install_ruby_packages(packages: &[String]) -> usize {
    let mut ok = 0;
    for pkg in packages {
        if run_cmd("gem", &["install", pkg, "--no-document"], None).await.is_ok() {
            ok += 1;
        }
    }
    ok
}

async fn install_php_packages(workspace: &Path, packages: &[String]) -> usize {
    let mut ok = 0;
    for pkg in packages {
        if run_cmd("composer", &["require", "--no-interaction", pkg], Some(workspace)).await.is_ok() {
            ok += 1;
        }
    }
    ok
}

async fn install_dart_packages(workspace: &Path, packages: &[String]) -> usize {
    let mut ok = 0;
    for pkg in packages {
        if run_cmd("dart", &["pub", "add", pkg], Some(workspace)).await.is_ok() {
            ok += 1;
        }
    }
    ok
}

async fn install_cpp_packages(packages: &[String]) -> usize {
    // For C/C++, install system packages via apt-get
    let apt_packages: Vec<&str> = packages.iter()
        .filter_map(|p| map_cpp_package(p))
        .collect();
    if apt_packages.is_empty() {
        return 0;
    }
    let mut args = vec!["install", "-y", "-qq"];
    args.extend_from_slice(&apt_packages);
    // Run apt-get update first
    let _ = run_cmd("apt-get", &["update", "-qq"], None).await;
    match run_cmd("apt-get", &args, None).await {
        Ok(()) => apt_packages.len(),
        Err(e) => {
            eprintln!("[IMPORT-SCAN] apt-get install failed: {}", e);
            0
        }
    }
}

async fn install_dotnet_packages(workspace: &Path, packages: &[String]) -> usize {
    let mut ok = 0;
    for pkg in packages {
        if run_cmd("dotnet", &["add", "package", pkg], Some(workspace)).await.is_ok() {
            ok += 1;
        }
    }
    ok
}

async fn install_lua_packages(packages: &[String]) -> usize {
    let mut ok = 0;
    for pkg in packages {
        if run_cmd("luarocks", &["install", pkg], None).await.is_ok() {
            ok += 1;
        }
    }
    ok
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

async fn run_cmd(program: &str, args: &[&str], cwd: Option<&Path>) -> Result<(), String> {
    println!("[IMPORT-SCAN] Running: {} {}", program, args.join(" "));
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let status = cmd.status().await
        .map_err(|e| format!("Failed to run {}: {}", program, e))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{} exited with code {:?}", program, status.code()))
    }
}
