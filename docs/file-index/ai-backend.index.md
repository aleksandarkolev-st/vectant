---
area: ai-backend
generated: 2026-08-25
files: 692
---

# File Index — ai-backend (692 files)

Kinds: asset: 13, source/config: 523, test: 156


## asset

| File | Bytes | Note |
|---|---|---|
| `ai-backend/.gitignore` | 565 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/agent-runner/Dockerfile` | 877 | FROM node:22-bookworm-slim@sha256:a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066 |
| `ai-backend/agent-runner/entrypoint.sh` | 460 | Credentials arrive through a read-only volume. Each CLI gets a private |

## asset

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/.dockerignore` | 47 | binary or generated artifact |
| `ai-backend/ai-engine/.gitignore` | 6 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/0naokfjy/.code_intel/chunking_version.txt` | 1 | txt file: chunking_version.txt |
| `ai-backend/ai-engine/0naokfjy/.code_intel/index_generation.txt` | 13 | txt file: index_generation.txt |
| `ai-backend/ai-engine/0naokfjy/.code_intel/summaries/summary_metadata.json` | 137 | JSON data (summary_metadata.json) |
| `ai-backend/ai-engine/0naokfjy/.synthi/rag/doc_content/6e8459c85101766157c1e42d.txt` | 20 | txt file: 6e8459c85101766157c1e42d.txt |
| `ai-backend/ai-engine/0naokfjy/.synthi/rag/doc_content/7af2606a158e197df5540b38.txt` | 13 | txt file: 7af2606a158e197df5540b38.txt |
| `ai-backend/ai-engine/0naokfjy/.synthi/rag/doc_content/90fb5d993e0be5751d2b3ff3.txt` | 1 | txt file: 90fb5d993e0be5751d2b3ff3.txt |
| `ai-backend/ai-engine/0naokfjy/.synthi/rag/documents.json` | 1 | JSON data (documents.json) |
| `ai-backend/ai-engine/0naokfjy/.synthi/rag/keyword_index.json` | 362 | JSON data (keyword_index.json) |
| `ai-backend/ai-engine/0naokfjy/.synthi/rag/summaries.json` | 1 | JSON data (summaries.json) |

## asset

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/0naokfjy/.synthi/rag/summary_vectors.npz` | 36 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/0naokfjy/.synthi/rag/toc_trees.json` | 1 | JSON data (toc_trees.json) |
| `ai-backend/ai-engine/Dockerfile` | 2 | Synthi IDE — AI Engine (Python 3.10, FastAPI + Uvicorn) |
| `ai-backend/ai-engine/MULTI_FILE_GUIDE.txt` | 7 | This document explains how to enable and supply multi-file context to the AI engine so the model |
| `ai-backend/ai-engine/agents/__init__.py` | 398 | GPU HMR agent package — see docs/GPU_HMR_ULTRAPLAN.md §5.6. |
| `ai-backend/ai-engine/agents/abi_stamper.py` | 6 | Deterministic ABI stamps for GPU kernels. |
| `ai-backend/ai-engine/agents/gpu_detect.py` | 13 | Phase-0 entry point for the GPU HMR pipeline. Scans a project's source |
| `ai-backend/ai-engine/agents/gpu_device_mapping.py` | 18 | Deterministic source-to-generated mappings for GPU device roles. |
| `ai-backend/ai-engine/agents/gpu_device_markers.py` | 1010 | Shared GPU device marker detection. |
| `ai-backend/ai-engine/agents/gpu_error_triage.py` | 3 | Mechanical GPU diagnostics triage. |
| `ai-backend/ai-engine/agents/gpu_healer.py` | 4 | GPU healer agent wrapper. |
| `ai-backend/ai-engine/agents/gpu_launch_indirection.py` | 5 | Launch-indirection report for GPU split artifacts. |
| `ai-backend/ai-engine/agents/gpu_mod_delta.py` | 39 | GPU edit classifier and GPU diff-patch helpers. |
| `ai-backend/ai-engine/agents/gpu_source_context.py` | 40 | Deterministic source-context selection for GPU HMR splits. |
| `ai-backend/ai-engine/agents/gpu_split_repair.py` | 116 | Deterministic repair helpers for GPU split artifacts. |
| `ai-backend/ai-engine/agents/kernel_splitter.py` | 74 | Spec: docs/GPU_HMR_ULTRAPLAN.md §5.6 item 2. |
| `ai-backend/ai-engine/agents/launch_graph_extractor.py` | 12 | Launch-graph extractor for Synthi GPU HMR. |

## asset

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/analyzer/.gitignore` | 25 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/analyzer/AllLanguageAnalyzers.py` | 30 | Convert HealingFix objects from the terminators rule into |
| `ai-backend/ai-engine/analyzer/__init__.py` | 1 | imports __future__ |
| `ai-backend/ai-engine/analyzer/baseAnalyzer.py` | 629 | Base class all language specific analyzers must extend. |
| `ai-backend/ai-engine/analyzer/comment_masker.py` | 4 | imports __future__ |
| `ai-backend/ai-engine/analyzer/proactive/__init__.py` | 1 | Proactive Code Analysis Module |
| `ai-backend/ai-engine/analyzer/proactive/ai_predictor.py` | 53 | AI-Powered Error Predictor |
| `ai-backend/ai-engine/analyzer/proactive/cache.py` | 5 | Analysis cache using content-hash based caching. |
| `ai-backend/ai-engine/analyzer/proactive/dependency_tracker.py` | 15 | Dependency Tracker for Multi-File Analysis |
| `ai-backend/ai-engine/analyzer/proactive/healing/__init__.py` | 3 | Self-Healing Engine |
| `ai-backend/ai-engine/analyzer/proactive/healing/ai_agent.py` | 22 | AI Healing Agent — the core agentic loop. |
| `ai-backend/ai-engine/analyzer/proactive/healing/ai_context.py` | 13 | AI context collector. |
| `ai-backend/ai-engine/analyzer/proactive/healing/ai_deps.py` | 6 | Cross-file dependency tracker for AI agent. |
| `ai-backend/ai-engine/analyzer/proactive/healing/ai_fix_utils.py` | 4 | Fix deduplication and grouping utilities. |
| `ai-backend/ai-engine/analyzer/proactive/healing/ai_memory.py` | 10 | AI Agent Memory — learns from user feedback. |
| `ai-backend/ai-engine/analyzer/proactive/healing/ai_parser.py` | 11 | AI response parser. |
| `ai-backend/ai-engine/analyzer/proactive/healing/ai_policy.py` | 9 | AI Suppression Policy Store — backend-side, user/team-scoped. |
| `ai-backend/ai-engine/analyzer/proactive/healing/ai_prompt_cache.py` | 4 | ai_prompt_cache.py — Short-lived LRU cache for AI detection results. |
| `ai-backend/ai-engine/analyzer/proactive/healing/ai_prompts.py` | 13 | AI-powered error detection prompts. |
| `ai-backend/ai-engine/analyzer/proactive/healing/ai_rate_limiter.py` | 5 | ai-backend/ai-engine/analyzer/proactive/healing/ai_rate_limiter.py |
| `ai-backend/ai-engine/analyzer/proactive/healing/ai_retry.py` | 3 | ai-backend/ai-engine/analyzer/proactive/healing/ai_retry.py |
| `ai-backend/ai-engine/analyzer/proactive/healing/ai_streaming.py` | 4 | Streaming AI analysis. |
| `ai-backend/ai-engine/analyzer/proactive/healing/ai_telemetry.py` | 4 | AI Agent telemetry and metrics. |
| `ai-backend/ai-engine/analyzer/proactive/healing/batch_engine.py` | 5 | Batch analysis engine for the self-healing system. |
| `ai-backend/ai-engine/analyzer/proactive/healing/cache.py` | 4 | Healing result cache. |
| `ai-backend/ai-engine/analyzer/proactive/healing/canary.py` | 17 | Canary / Staged Rollout System. |
| `ai-backend/ai-engine/analyzer/proactive/healing/classifier.py` | 12 | Healing Classifier — Safety Gate |
| `ai-backend/ai-engine/analyzer/proactive/healing/config_schema.py` | 3 | Healing system configuration schema and defaults. |
| `ai-backend/ai-engine/analyzer/proactive/healing/diagnosis.py` | 24 | Root-Cause Diagnosis Layer. |
| `ai-backend/ai-engine/analyzer/proactive/healing/engine.py` | 22 | Targeted Auto-Fix Engine |
| `ai-backend/ai-engine/analyzer/proactive/healing/failure_distiller.py` | 112 | Evidence-backed reduction of a failing command into a logical capsule. |
| `ai-backend/ai-engine/analyzer/proactive/healing/failure_distiller_adapters.py` | 10 | Typed failure-adapter contracts for Failure Distiller. |
| `ai-backend/ai-engine/analyzer/proactive/healing/failure_distiller_execution.py` | 10 | Fail-closed execution backends for Failure Distiller. |
| `ai-backend/ai-engine/analyzer/proactive/healing/lang_families.py` | 2 | Centralised language family definitions. |
| `ai-backend/ai-engine/analyzer/proactive/healing/metrics_export.py` | 5 | Healing metrics exporter. |
| `ai-backend/ai-engine/analyzer/proactive/healing/multi_file.py` | 18 | Multi-File Repair Coordinator. |
| `ai-backend/ai-engine/analyzer/proactive/healing/observability.py` | 19 | Observability-Based Healing Triggers. |
| `ai-backend/ai-engine/analyzer/proactive/healing/planner.py` | 37 | Repair Planner & Tool Orchestration. |
| `ai-backend/ai-engine/analyzer/proactive/healing/policy.py` | 17 | Policy Engine. |
| `ai-backend/ai-engine/analyzer/proactive/healing/precision_telemetry.py` | 18 | Precision & Revert Telemetry. |
| `ai-backend/ai-engine/analyzer/proactive/healing/redaction.py` | 20 | Secret & PII Redaction Engine. |
| `ai-backend/ai-engine/analyzer/proactive/healing/repair_episode.py` | 23 | Repair Episode State Machine. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rollback.py` | 20 | Transactional Rollback System. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rule_registry.py` | 5 | Healing Rule Registry |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/__init__.py` | 1 | Healing rules package. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/accessibility.py` | 5 | Universal healing rule: Accessibility (a11y) patterns. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/api_patterns.py` | 7 | Universal healing rule: API and interface consistency. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/async_patterns.py` | 8 | Universal healing rule: Async/await patterns. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/brackets.py` | 7 | Universal healing rule: Bracket / parenthesis / brace matching. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/classes.py` | 9 | Universal healing rule: Class and OOP patterns. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/comments.py` | 9 | Universal healing rule: Comment formatting. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/comparisons.py` | 7 | Universal healing rule: Comparison patterns. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/complexity.py` | 8 | Universal healing rule: Complexity analysis. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/concurrency.py` | 6 | Universal healing rule: Concurrency and thread-safety patterns. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/conditionals.py` | 9 | Universal healing rule: Conditional patterns. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/dead_code.py` | 9 | Universal healing rule: Dead code detection. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/deprecation.py` | 6 | Universal healing rule: Deprecated / legacy API usage. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/documentation.py` | 9 | Universal healing rule: Documentation patterns. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/encoding.py` | 5 | Universal healing rule: Encoding & line-ending issues. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/error_handling.py` | 10 | Universal healing rule: Error handling patterns. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/exception_patterns.py` | 9 | Universal healing rule: Exception & error hierarchy patterns. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/function_patterns.py` | 6 | Universal healing rule: Function-level anti-patterns. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/imports.py` | 8 | Universal healing rule: Import management. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/line_length.py` | 7 | Universal healing rule: Line length and formatting. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/logging_debug.py` | 8 | Universal healing rule: Logging and debugging. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/loops.py` | 7 | Universal healing rule: Loop patterns. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/magic_numbers.py` | 6 | Universal healing rule: Magic number and constant extraction. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/module_structure.py` | 4 | Universal healing rule: Module structure patterns. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/naming.py` | 8 | Universal healing rule: Naming conventions. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/operators.py` | 7 | Universal healing rule: Operator issues. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/performance.py` | 5 | Universal healing rule: Performance anti-patterns. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/react_patterns.py` | 7 | Universal healing rule: React and JSX specific patterns. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/resource_management.py` | 7 | Universal healing rule: Resource management patterns. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/returns.py` | 9 | Universal healing rule: Return statement patterns. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/security.py` | 8 | Universal healing rule: Security patterns. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/strings.py` | 8 | Universal healing rule: String literal issues. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/syntax_consistency.py` | 8 | Universal healing rule: Syntax consistency. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/terminators.py` | 8 | Universal healing rule: Missing statement terminators. |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/testing.py` | 7 | Universal healing rule: Testing anti-patterns. |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/type_hints.py` | 8 | Universal healing rule: Type annotation helpers. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/universal_rules.py` | 8 | Universal healing rules that apply to all languages. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/variables.py` | 9 | Universal healing rule: Variable issues. |
| `ai-backend/ai-engine/analyzer/proactive/healing/rules/whitespace.py` | 7 | Universal healing rule: Whitespace and indentation. |
| `ai-backend/ai-engine/analyzer/proactive/healing/runtime_healing.py` | 19 | Runtime Exception Healing. |
| `ai-backend/ai-engine/analyzer/proactive/healing/sandbox.py` | 23 | Sandboxed Execution Environment. |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/analyzer/proactive/healing/test/test_ai_agent.py` | 17 | Tests for the AI healing agent subsystem. |
| `ai-backend/ai-engine/analyzer/proactive/healing/test/test_ai_integration.py` | 18 | test_ai_integration.py |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/analyzer/proactive/healing/types.py` | 10 | Type definitions for the Targeted Auto-Fix system. |
| `ai-backend/ai-engine/analyzer/proactive/healing/verification.py` | 30 | Verification Pipeline. |
| `ai-backend/ai-engine/analyzer/proactive/hunk_applier.py` | 2 | Hunk-level diff application for incremental workspace analysis. |
| `ai-backend/ai-engine/analyzer/proactive/orchestrator.py` | 10 | Proactive Analysis Orchestrator |
| `ai-backend/ai-engine/analyzer/proactive/semantic_analyzer.py` | 62 | Semantic Analyzer - Deep AST-based code analysis. |
| `ai-backend/ai-engine/analyzer/proactive/types.py` | 19 | Type definitions for the Proactive Analysis system. |
| `ai-backend/ai-engine/analyzer/proactive/workspace_analyzer.py` | 37 | Workspace Analyzer - Multi-File Analysis Coordinator |
| `ai-backend/ai-engine/analyzer/utils.py` | 2 | A suggested fix for a diagnostic. |
| `ai-backend/ai-engine/bench/__init__.py` | 193 | Synthi Genome offline evaluation harness. Master plan §15. |

## asset

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/.gitkeep` | 527 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/go-nil-deref/metadata.json` | 172 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/go-nil-deref/request.txt` | 212 | `Find(users []*User, id int)` panics with a nil-pointer dereference when no user matches because it returns user.Name from a nil pointer. Re |
| `ai-backend/ai-engine/bench/corpus/go-nil-deref/seed_patches.json` | 324 | JSON data (seed_patches.json) |

## asset

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/go-nil-deref/workspace/go.mod` | 34 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/go-nil-deref/workspace/users.go` | 357 | Find returns (name, found). The current implementation panics |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/go-nil-deref/workspace/users_test.go` | 524 | func TestFindHit(t *testing.T) { |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/html-aria-missing/metadata.json` | 153 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/html-aria-missing/request.txt` | 224 | The icon button has no accessible name — htmlhint flags `attr-lowercase` and visual-only icons fail the alt-required rule. Add aria-label="C |
| `ai-backend/ai-engine/bench/corpus/html-aria-missing/seed_patches.json` | 314 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/html-aria-missing/workspace/index.html` | 199 | html asset |
| `ai-backend/ai-engine/bench/corpus/js-array-sort-numeric/metadata.json` | 173 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/js-array-sort-numeric/request.txt` | 198 | `sortNumbers([10, 2, 33, 4])` returns [10, 2, 33, 4] sorted as strings → [10, 2, 33, 4] becomes [10, 2, 33, 4] which is wrong. Pass an expli |
| `ai-backend/ai-engine/bench/corpus/js-array-sort-numeric/seed_patches.json` | 169 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/js-array-sort-numeric/workspace/sort.js` | 169 | bug: default sort is lexicographic — [10, 2, 33, 4] -> [10, 2, 33, 4] |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/js-array-sort-numeric/workspace/sort.test.js` | 346 | const { sortNumbers } = require("./sort"); |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/js-equality-loose/metadata.json` | 172 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/js-equality-loose/request.txt` | 205 | `isAdmin(role)` uses `==` so the string "0" matches the number 0 and a falsy admin role slips through. Replace with `===` and update the fun |
| `ai-backend/ai-engine/bench/corpus/js-equality-loose/seed_patches.json` | 149 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/js-equality-loose/workspace/auth.js` | 154 | bug: == coerces; "admin" == something_truthy_truthy may surprise |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/js-equality-loose/workspace/auth.test.js` | 365 | const { isAdmin } = require("./auth"); |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/js-null-guard/metadata.json` | 162 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/js-null-guard/request.txt` | 164 | parseAge crashes when input is null or undefined. Add a null guard so it returns null in those cases, and keep the trim+parseInt behaviour f |
| `ai-backend/ai-engine/bench/corpus/js-null-guard/seed_patches.json` | 376 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/js-null-guard/workspace/parseAge.js` | 241 | Bug: parseAge does not handle null / undefined inputs and crashes. |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/js-null-guard/workspace/parseAge.test.js` | 391 | const { parseAge } = require('./parseAge'); |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/js-promise-unhandled/metadata.json` | 168 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/js-promise-unhandled/request.txt` | 228 | `sumAsync(xs)` returns the unresolved Promises themselves added together, so the caller sees `[object Promise][object Promise]` instead of a |
| `ai-backend/ai-engine/bench/corpus/js-promise-unhandled/seed_patches.json` | 295 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/js-promise-unhandled/workspace/asyncSum.js` | 259 | defines `sumAsync` |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/js-promise-unhandled/workspace/asyncSum.test.js` | 372 | const { sumAsync } = require("./asyncSum"); |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/js-prototype-pollution/metadata.json` | 172 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/js-prototype-pollution/request.txt` | 263 | `assignDeep(target, src)` walks every key from `src` recursively, including __proto__ and constructor — which lets an attacker pollute Objec |
| `ai-backend/ai-engine/bench/corpus/js-prototype-pollution/seed_patches.json` | 513 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/js-prototype-pollution/workspace/assignDeep.js` | 304 | defines `assignDeep` |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/js-prototype-pollution/workspace/assignDeep.test.js` | 615 | const { assignDeep } = require("./assignDeep"); |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/js-refactor-async/metadata.json` | 167 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/js-refactor-async/request.txt` | 249 | Convert loadProfile in loadProfile.js from a promise chain to async/await. Preserve the existing behaviour: on success return { user, orgs } |
| `ai-backend/ai-engine/bench/corpus/js-refactor-async/seed_patches.json` | 460 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/js-refactor-async/workspace/api.js` | 312 | Tiny mock of the network surface used by loadProfile. |
| `ai-backend/ai-engine/bench/corpus/js-refactor-async/workspace/loadProfile.js` | 518 | Refactor target: convert the promise-chain implementation to async/await |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/js-refactor-async/workspace/loadProfile.test.js` | 554 | const { loadProfile } = require('./loadProfile'); |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/js-regex-catastrophic/metadata.json` | 180 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/js-regex-catastrophic/request.txt` | 230 | `isValidEmail(s)` uses a nested-quantifier regex that backtracks catastrophically on inputs like "aaaa…!". Replace it with a simple anchored |
| `ai-backend/ai-engine/bench/corpus/js-regex-catastrophic/seed_patches.json` | 284 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/js-regex-catastrophic/workspace/email.js` | 212 | Catastrophic backtracking on inputs like "a".repeat(30) + "!". |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/js-regex-catastrophic/workspace/email.test.js` | 561 | const { isValidEmail } = require("./email"); |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/js-shallow-merge/metadata.json` | 180 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/js-shallow-merge/request.txt` | 258 | `merge(a, b)` uses Object.assign, which does a shallow merge. The tests require a deep merge — overlapping nested objects should be merged k |
| `ai-backend/ai-engine/bench/corpus/js-shallow-merge/seed_patches.json` | 454 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/js-shallow-merge/workspace/merge.js` | 144 | bug: shallow — b.config wholly replaces a.config |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/js-shallow-merge/workspace/merge.test.js` | 508 | const { merge } = require("./merge"); |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/js-this-binding/metadata.json` | 179 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/js-this-binding/request.txt` | 202 | `Counter.tick(steps)` passes `this.add` as a callback to forEach but loses the `this` binding so `this.value` becomes undefined. Use an arro |
| `ai-backend/ai-engine/bench/corpus/js-this-binding/seed_patches.json` | 283 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/js-this-binding/workspace/counter.js` | 269 | bug: `this` is lost when forEach calls add() without a binding |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/js-this-binding/workspace/counter.test.js` | 267 | const { Counter } = require("./counter"); |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/multi-file-feature-flag/metadata.json` | 182 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/multi-file-feature-flag/request.txt` | 251 | Add a `dark_mode` boolean to the central `flags.py`, default False, and update `theme.py` so it returns "dark" when the flag is on, "light"  |
| `ai-backend/ai-engine/bench/corpus/multi-file-feature-flag/seed_patches.json` | 335 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/multi-file-feature-flag/workspace/flags.py` | 59 | Central feature flags. Add new flags here. |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/multi-file-feature-flag/workspace/test_theme.py` | 459 | defines `test_default_light` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/multi-file-feature-flag/workspace/theme.py` | 95 | Return the active theme name. |
| `ai-backend/ai-engine/bench/corpus/multi-rename/metadata.json` | 174 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/multi-rename/request.txt` | 193 | Rename `getUserById` to `find_user_by_id` to match Python naming conventions. Update both the definition in users.py and the importing call  |
| `ai-backend/ai-engine/bench/corpus/multi-rename/seed_patches.json` | 436 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/multi-rename/workspace/routes.py` | 182 | defines `user_route` |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/multi-rename/workspace/test_routes.py` | 336 | defines `test_known_user` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/multi-rename/workspace/users.py` | 103 | defines `getUserById` |
| `ai-backend/ai-engine/bench/corpus/py-async-await-missing/metadata.json` | 162 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/py-async-await-missing/request.txt` | 231 | `fetch_total()` is awaiting only one of the two coroutines. The second call returns a coroutine object that's added to a number, raising Typ |
| `ai-backend/ai-engine/bench/corpus/py-async-await-missing/seed_patches.json` | 301 | JSON data (seed_patches.json) |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-async-await-missing/workspace/test_totals.py` | 267 | defines `test_fetch_total_returns_int` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-async-await-missing/workspace/totals.py` | 265 | imports asyncio |
| `ai-backend/ai-engine/bench/corpus/py-context-manager/metadata.json` | 184 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/py-context-manager/request.txt` | 190 | `read_lines(path)` opens the file but never closes it — a resource leak the test suite picks up via tracemalloc. Rewrite using a `with` bloc |
| `ai-backend/ai-engine/bench/corpus/py-context-manager/seed_patches.json` | 206 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/py-context-manager/workspace/io_utils.py` | 149 | Read a file's lines. |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-context-manager/workspace/test_io_utils.py` | 580 | defines `test_reads_lines` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-dep-add-requests/metadata.json` | 185 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/py-dep-add-requests/request.txt` | 247 | `fetch_status(url)` uses urllib.request which is hard to mock and clunky. Switch to the `requests` library — add it to requirements.txt and  |
| `ai-backend/ai-engine/bench/corpus/py-dep-add-requests/seed_patches.json` | 237 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/py-dep-add-requests/workspace/fetcher.py` | 131 | defines `fetch_status` |
| `ai-backend/ai-engine/bench/corpus/py-dep-add-requests/workspace/requirements.txt` | 0 | txt file: requirements.txt |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-dep-add-requests/workspace/test_fetcher.py` | 550 | defines `_StubResp` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-dep-change/metadata.json` | 163 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/py-dep-change/request.txt` | 159 | slugify_text drops unicode characters. Switch to the python-slugify package so "Café au lait" becomes "cafe-au-lait". Add the dependency to  |
| `ai-backend/ai-engine/bench/corpus/py-dep-change/seed_patches.json` | 339 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/py-dep-change/workspace/requirements.txt` | 12 | txt file: requirements.txt |
| `ai-backend/ai-engine/bench/corpus/py-dep-change/workspace/slugify_text.py` | 302 | Convert a title to a URL slug. The current implementation is naive and |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-dep-change/workspace/test_slugify.py` | 269 | The naive impl drops the diacritics; python-slugify transliterates. |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-divide-by-zero/metadata.json` | 170 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/py-divide-by-zero/request.txt` | 130 | `average([])` raises ZeroDivisionError. Return `0.0` for an empty input list instead of crashing. Don't swallow other exceptions. |
| `ai-backend/ai-engine/bench/corpus/py-divide-by-zero/seed_patches.json` | 236 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/py-divide-by-zero/workspace/stats.py` | 108 | Return the arithmetic mean of `values`. |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-divide-by-zero/workspace/test_stats.py` | 257 | defines `test_non_empty` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-json-decode/metadata.json` | 171 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/py-json-decode/request.txt` | 183 | `load_config(text)` raises json.JSONDecodeError on malformed input. Wrap the parse so invalid JSON returns the empty dict instead of crashin |
| `ai-backend/ai-engine/bench/corpus/py-json-decode/seed_patches.json` | 269 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/py-json-decode/workspace/cfg.py` | 104 | Parse a JSON config payload. |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-json-decode/workspace/test_cfg.py` | 244 | defines `test_valid_json` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-multi-file-callsites/metadata.json` | 184 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/py-multi-file-callsites/request.txt` | 194 | `format_amount(value, currency)` currently returns "USD 100.00". Reverse the order to "100.00 USD" — and update both call sites in api.py an |
| `ai-backend/ai-engine/bench/corpus/py-multi-file-callsites/seed_patches.json` | 135 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/py-multi-file-callsites/workspace/api.py` | 114 | defines `render_invoice` |
| `ai-backend/ai-engine/bench/corpus/py-multi-file-callsites/workspace/money.py` | 73 | defines `format_amount` |
| `ai-backend/ai-engine/bench/corpus/py-multi-file-callsites/workspace/report.py` | 130 | defines `render_summary` |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-multi-file-callsites/workspace/test_money.py` | 366 | defines `test_format_amount_value_first` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-multi-file-rename/metadata.json` | 172 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/py-multi-file-rename/request.txt` | 122 | Rename auth.chk_token to auth.is_token_valid and update the only caller in api.py. The tests already expect the new name. |
| `ai-backend/ai-engine/bench/corpus/py-multi-file-rename/seed_patches.json` | 371 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/py-multi-file-rename/workspace/api.py` | 113 | defines `authorize` |
| `ai-backend/ai-engine/bench/corpus/py-multi-file-rename/workspace/auth.py` | 226 | Auth utilities. The team decided to rename `chk_token` to |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-multi-file-rename/workspace/test_api.py` | 313 | defines `test_authorize_ok` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-mutable-default/metadata.json` | 176 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/py-mutable-default/request.txt` | 243 | Calling `add_item("a")` then `add_item("b")` returns `["a", "b"]` instead of `["b"]`. The mutable-default-argument anti-pattern is leaking s |
| `ai-backend/ai-engine/bench/corpus/py-mutable-default/seed_patches.json` | 246 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/py-mutable-default/workspace/cart.py` | 132 | Append `item` to a basket and return the basket. |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-mutable-default/workspace/test_cart.py` | 300 | defines `test_first_call_one_item` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-off-by-one/metadata.json` | 158 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/py-off-by-one/request.txt` | 206 | factorial(0) and factorial(1) both return 1 in tests but the implementation returns 1 for them by accident, and factorial(5) returns 24 inst |
| `ai-backend/ai-engine/bench/corpus/py-off-by-one/seed_patches.json` | 362 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/py-off-by-one/workspace/factorial.py` | 312 | Return n! for non-negative integers. |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-off-by-one/workspace/test_factorial.py` | 316 | defines `test_factorial_zero` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-perf-quadratic/metadata.json` | 179 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/py-perf-quadratic/request.txt` | 216 | `first_duplicate(seq)` is O(n²) — it does `seq.index(x)` inside a loop. Refactor to O(n) using a set, preserving the existing return value ( |
| `ai-backend/ai-engine/bench/corpus/py-perf-quadratic/seed_patches.json` | 285 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/py-perf-quadratic/workspace/dedup.py` | 198 | Return the first element that appears twice in `seq`, or None. |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-perf-quadratic/workspace/test_dedup.py` | 334 | defines `test_returns_first_repeat` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-perf-string-concat/metadata.json` | 173 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/py-perf-string-concat/request.txt` | 181 | `join_lines(lines)` builds the result with `+=` inside a loop, which is O(n²) on large inputs. Replace with `"\n".join(...)` so it runs in O |
| `ai-backend/ai-engine/bench/corpus/py-perf-string-concat/seed_patches.json` | 229 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/py-perf-string-concat/workspace/joiner.py` | 169 | Join `lines` with newlines. |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-perf-string-concat/workspace/test_joiner.py` | 221 | defines `test_basic` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-recursion-depth/metadata.json` | 178 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/py-recursion-depth/request.txt` | 200 | `sum_to(n)` is recursive and overflows the default recursion limit at n=2000. Convert it to an iterative implementation that runs in O(n) ti |
| `ai-backend/ai-engine/bench/corpus/py-recursion-depth/seed_patches.json` | 263 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/py-recursion-depth/workspace/sums.py` | 137 | Return 1+2+...+n. Recursion overflows for n>=1000. |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-recursion-depth/workspace/test_sums.py` | 280 | defines `test_small` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-security-eval/metadata.json` | 171 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/py-security-eval/request.txt` | 229 | `safe_int(s)` uses `eval()` to parse user-supplied strings, which is a code-injection foothold. Replace with `int(s)` that only accepts inte |
| `ai-backend/ai-engine/bench/corpus/py-security-eval/seed_patches.json` | 237 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/py-security-eval/workspace/parser.py` | 140 | Parse a user-supplied string as an integer. |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-security-eval/workspace/test_parser.py` | 418 | defines `test_parses_integer` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-shallow-copy/metadata.json` | 172 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/py-shallow-copy/request.txt` | 267 | `without_first(seq)` is supposed to return the input list with the first element removed *without* mutating the input. Right now it deletes  |
| `ai-backend/ai-engine/bench/corpus/py-shallow-copy/seed_patches.json` | 179 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/py-shallow-copy/workspace/seq.py` | 167 | Return a copy of `seq` with the first element removed. |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-shallow-copy/workspace/test_seq.py` | 261 | defines `test_returns_tail` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-string-format/metadata.json` | 175 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/py-string-format/request.txt` | 255 | `format_user(name)` calls "{name}: {age}".format(name=name) without supplying an `age`, raising KeyError. Either remove the unused `{age}` p |
| `ai-backend/ai-engine/bench/corpus/py-string-format/seed_patches.json` | 191 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/py-string-format/workspace/fmt.py` | 122 | Render a user line. |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-string-format/workspace/test_fmt.py` | 184 | defines `test_default_age` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-thread-race/metadata.json` | 174 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/py-thread-race/request.txt` | 220 | `Counter.increment()` is racy under threads — repeated `value = value + 1` from many workers loses updates. Add a threading.Lock and protect |
| `ai-backend/ai-engine/bench/corpus/py-thread-race/seed_patches.json` | 364 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/py-thread-race/workspace/counter.py` | 301 | bug: read-modify-write across threads loses updates |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-thread-race/workspace/test_counter.py` | 328 | defines `test_threaded_increments` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-type-error/metadata.json` | 153 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/py-type-error/request.txt` | 173 | total_value() multiplies the CSV-parsed quantity (a str) by the unit price (a float). mypy flags it; the runtime gives wrong values too. Fix |
| `ai-backend/ai-engine/bench/corpus/py-type-error/seed_patches.json` | 337 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/py-type-error/workspace/inventory.py` | 424 | Compute total inventory value. Has a type bug: `quantity` is parsed |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/py-type-error/workspace/test_inventory.py` | 239 | defines `test_basic` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/rust-unwrap-panic/metadata.json` | 171 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/rust-unwrap-panic/request.txt` | 224 | `parse_pos(s)` calls .unwrap() on str::parse, which panics on bad input. Return Result<u32, ParseIntError> instead so callers can decide. Th |
| `ai-backend/ai-engine/bench/corpus/rust-unwrap-panic/seed_patches.json` | 593 | JSON data (seed_patches.json) |
| `ai-backend/ai-engine/bench/corpus/rust-unwrap-panic/workspace/Cargo.toml` | 94 | toml file: Cargo.toml |
| `ai-backend/ai-engine/bench/corpus/rust-unwrap-panic/workspace/src/lib.rs` | 552 | bug: panics on bad input |
| `ai-backend/ai-engine/bench/corpus/ts-strict-null/metadata.json` | 178 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/ts-strict-null/request.txt` | 268 | `firstChar(s)` accesses `s[0].toUpperCase()` even when `s` may be undefined or empty, producing TS strictNullChecks errors and runtime "Cann |
| `ai-backend/ai-engine/bench/corpus/ts-strict-null/seed_patches.json` | 179 | JSON data (seed_patches.json) |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/ts-strict-null/workspace/firstChar.test.ts` | 293 | import { firstChar } from "./firstChar"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/ts-strict-null/workspace/firstChar.ts` | 120 | bug: no null/empty guard |
| `ai-backend/ai-engine/bench/corpus/ts-type-narrow/metadata.json` | 180 | JSON data (metadata.json) |
| `ai-backend/ai-engine/bench/corpus/ts-type-narrow/request.txt` | 234 | `describe(value)` accepts `string / number / null` but accesses `.toUpperCase()` and `.toFixed(2)` without narrowing, producing TS errors. A |
| `ai-backend/ai-engine/bench/corpus/ts-type-narrow/seed_patches.json` | 290 | JSON data (seed_patches.json) |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/ts-type-narrow/workspace/describe.test.ts` | 330 | import { describe as describeValue } from "./describe"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/corpus/ts-type-narrow/workspace/describe.ts` | 192 | bug: no narrowing — these calls are type errors on the union. |
| `ai-backend/ai-engine/bench/failure_distiller/corpus/v1/browser_workflow.json` | 787 | JSON data (browser_workflow.json) |
| `ai-backend/ai-engine/bench/failure_distiller/corpus/v1/gpu_frame_sequence.json` | 583 | JSON data (gpu_frame_sequence.json) |
| `ai-backend/ai-engine/bench/failure_distiller/corpus/v1/hmr_event_sequence.json` | 482 | JSON data (hmr_event_sequence.json) |
| `ai-backend/ai-engine/bench/failure_distiller/corpus/v1/native_hmr_gpu.json` | 509 | JSON data (native_hmr_gpu.json) |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/bench/failure_distiller/corpus/v1/pytest_fixture.json` | 514 | JSON data (pytest_fixture.json) |
| `ai-backend/ai-engine/bench/failure_distiller/corpus/v1/vitest_config.json` | 649 | JSON data (vitest_config.json) |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/bench/failure_distiller/run.py` | 8 | Versioned, repeatable Failure Distiller benchmark runner. |
| `ai-backend/ai-engine/bench/harness.py` | 6 | Run the shadow pipeline against a corpus and emit metrics. |
| `ai-backend/ai-engine/bench/metrics.py` | 1 | Metrics summarizer for bench results. Master plan §15.2. |
| `ai-backend/ai-engine/bench/report.py` | 2 | Render bench summary as markdown. Used by CI gates (master plan §15.3). |
| `ai-backend/ai-engine/bench/synthi_report.md` | 11 | Synthi Integration Report — RAG + Shadow |
| `ai-backend/ai-engine/bench/synthi_report.py` | 52 | Comprehensive integration report for RAG + Shadow subsystems. |
| `ai-backend/ai-engine/bench/tune_weights.py` | 8 | Grid-search the §10 scoring weights against the bench corpus. |
| `ai-backend/ai-engine/build_manifest.py` | 63 | Build manifest schema + V1 validator for the universal split pipeline. |
| `ai-backend/ai-engine/cm/.code_intel_current_gen.txt` | 14 | txt file: .code_intel_current_gen.txt |

## asset

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/cm/.gitignore` | 100 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/code_intel/__init__.py` | 2 | A multi-file codebase understanding system that: |
| `ai-backend/ai-engine/code_intel/api.py` | 55 | Code Intelligence FastAPI Routes. |
| `ai-backend/ai-engine/code_intel/core/__init__.py` | 1 | Core module for code intelligence types and configuration. |
| `ai-backend/ai-engine/code_intel/core/config.py` | 12 | Configuration for the Code Intelligence System. |
| `ai-backend/ai-engine/code_intel/core/security.py` | 11 | Security Boundaries for Code Intelligence. |
| `ai-backend/ai-engine/code_intel/core/types.py` | 37 | Core type definitions for the Code Intelligence System. |
| `ai-backend/ai-engine/code_intel/editing/__init__.py` | 1 | Editing Workflow Module - Safe code modifications. |
| `ai-backend/ai-engine/code_intel/editing/conflict_detector.py` | 9 | Conflict Detector - Detect conflicts between edits and external changes. |
| `ai-backend/ai-engine/code_intel/editing/edit_executor.py` | 11 | Edit Executor - Execute validated edit plans. |
| `ai-backend/ai-engine/code_intel/editing/edit_planner.py` | 11 | Edit Planner - Plan multi-file edits before execution. |
| `ai-backend/ai-engine/code_intel/editing/edit_session.py` | 13 | Edit Session - Orchestrate complete edit workflow. |
| `ai-backend/ai-engine/code_intel/editing/edit_validator.py` | 13 | Edit Validator - Validate edits before execution. |
| `ai-backend/ai-engine/code_intel/editing/symbol_diff.py` | 21 | Symbol-Level Diffs - NOT Line Diffs. |
| `ai-backend/ai-engine/code_intel/engine.py` | 42 | Code Intelligence System - Main Integration Module. |
| `ai-backend/ai-engine/code_intel/evaluation/bench.py` | 3 | defines `RetrievalBenchmark` |
| `ai-backend/ai-engine/code_intel/evaluation/datasets/template.json` | 810 | JSON data (template.json) |
| `ai-backend/ai-engine/code_intel/evaluation/run_bench.py` | 1 | defines `main` |
| `ai-backend/ai-engine/code_intel/eviction/__init__.py` | 1 | Context Eviction Module - Manage context stability across conversation turns. |
| `ai-backend/ai-engine/code_intel/eviction/context_diff.py` | 8 | Context Diff - Track and communicate context changes. |
| `ai-backend/ai-engine/code_intel/eviction/context_pinner.py` | 6 | Context Pinner - Explicitly pin context to prevent eviction. |
| `ai-backend/ai-engine/code_intel/eviction/context_tracker.py` | 11 | Context Tracker - Track what context has been shown to the AI. |
| `ai-backend/ai-engine/code_intel/eviction/drift_detector.py` | 12 | Drift Detection - Detect when indexed content diverges from actual files. |
| `ai-backend/ai-engine/code_intel/eviction/eviction_policy.py` | 9 | Eviction Policies - Strategies for context eviction. |
| `ai-backend/ai-engine/code_intel/gitignore_guard.py` | 3 | Gitignore guard — ensures AI-generated index directories are excluded |
| `ai-backend/ai-engine/code_intel/indexer/__init__.py` | 1 | Dual Index Module - Vector + Structural + Lexical Indexing |
| `ai-backend/ai-engine/code_intel/indexer/dual_indexer.py` | 25 | Dual Indexer - Combines vector and structural indexing. |
| `ai-backend/ai-engine/code_intel/indexer/embedder.py` | 19 | Embedder - Generate embeddings for semantic chunks. |
| `ai-backend/ai-engine/code_intel/indexer/lexical_index.py` | 15 | BM25 Lexical Index - Exact symbol and file name search. |
| `ai-backend/ai-engine/code_intel/indexer/structural_index.py` | 32 | Structural Index - Symbol graph for dependency tracking. |
| `ai-backend/ai-engine/code_intel/indexer/vector_index.py` | 26 | Vector Index - Semantic similarity search over code chunks. |
| `ai-backend/ai-engine/code_intel/ingestion/__init__.py` | 1 | Code Ingestion Module |
| `ai-backend/ai-engine/code_intel/ingestion/chunk_extractor.py` | 13 | Chunk Extractor - Convert parsed results to semantic chunks. |
| `ai-backend/ai-engine/code_intel/ingestion/edge_extractor.py` | 12 | Edge Extractor - Extract symbol relationships with proper confidence scoring. |
| `ai-backend/ai-engine/code_intel/ingestion/file_walker.py` | 12 | File Walker - Traverse repository and discover files. |
| `ai-backend/ai-engine/code_intel/ingestion/import_resolver.py` | 6 | Resolve import statements to workspace-relative file paths. |
| `ai-backend/ai-engine/code_intel/ingestion/language_detector.py` | 7 | Language Detection - Determine the programming language of a file. |
| `ai-backend/ai-engine/code_intel/ingestion/normalizer.py` | 6 | Normalizer - Clean and normalize code for consistent processing. |
| `ai-backend/ai-engine/code_intel/ingestion/parser_base.py` | 7 | Base Parser Interface - Abstract base class for language parsers. |
| `ai-backend/ai-engine/code_intel/ingestion/parsers/__init__.py` | 1 | Language-specific Parsers |
| `ai-backend/ai-engine/code_intel/ingestion/parsers/cpp_parser.py` | 10 | C/C++ Parser - Pattern-based parsing for C and C++ code. |
| `ai-backend/ai-engine/code_intel/ingestion/parsers/go_parser.py` | 9 | Go Parser - Pattern-based parsing for Go code. |
| `ai-backend/ai-engine/code_intel/ingestion/parsers/java_parser.py` | 9 | Java Parser - Pattern-based parsing for Java code. |
| `ai-backend/ai-engine/code_intel/ingestion/parsers/python_parser.py` | 15 | Python Parser - AST-based parsing for Python code. |
| `ai-backend/ai-engine/code_intel/ingestion/parsers/rust_parser.py` | 11 | Rust Parser - Pattern-based parsing for Rust code. |
| `ai-backend/ai-engine/code_intel/ingestion/parsers/typescript_parser.py` | 18 | TypeScript/JavaScript Parser - AST-based parsing using a simple recursive descent approach. |
| `ai-backend/ai-engine/code_intel/lsp/lsp_importer.py` | 1 | defines `ingest_lsp_index` |
| `ai-backend/ai-engine/code_intel/rag/PLAN.md` | 45 | RAG: Agentic + Verified Plan |
| `ai-backend/ai-engine/code_intel/rag/README.md` | 3 | RAG Subsystem — Architecture Reference |
| `ai-backend/ai-engine/code_intel/rag/__init__.py` | 2 | RAG (Retrieval-Augmented Generation) Subsystem for Code Intelligence. |
| `ai-backend/ai-engine/code_intel/rag/api.py` | 12 | RAG API — FastAPI endpoints for the RAG subsystem. |
| `ai-backend/ai-engine/code_intel/rag/config.py` | 13 | Configuration for the RAG subsystem. |
| `ai-backend/ai-engine/code_intel/rag/exceptions.py` | 3 | Custom exception hierarchy for the RAG subsystem. |
| `ai-backend/ai-engine/code_intel/rag/ingestion/__init__.py` | 652 | Ingestion sub-package for the RAG subsystem. |
| `ai-backend/ai-engine/code_intel/rag/ingestion/content_hasher.py` | 3 | Content Hasher — Deterministic hashing for dedup and change detection. |
| `ai-backend/ai-engine/code_intel/rag/ingestion/document_loader.py` | 12 | Document Loader — Load documents from various formats into Document objects. |
| `ai-backend/ai-engine/code_intel/rag/ingestion/document_processor.py` | 15 | Document Processor — Orchestrates the full dual-ingestion pipeline. |
| `ai-backend/ai-engine/code_intel/rag/ingestion/section_splitter.py` | 7 | Section Splitter — Split documents into sections based on ToC boundaries. |
| `ai-backend/ai-engine/code_intel/rag/ingestion/summary_generator.py` | 14 | Summary Generator — Generate document-level summaries for macro-retrieval. |
| `ai-backend/ai-engine/code_intel/rag/ingestion/toc_extractor.py` | 24 | ToC Extractor — Build Table of Contents trees from documents. |
| `ai-backend/ai-engine/code_intel/rag/macro/__init__.py` | 565 | Macro-Retrieval Package (Step 2) |
| `ai-backend/ai-engine/code_intel/rag/macro/document_ranker.py` | 14 | Document Ranker — Hybrid scorer combining vector + keyword + recency signals. |
| `ai-backend/ai-engine/code_intel/rag/macro/keyword_filter.py` | 12 | Keyword Filter — BM25-style keyword search over document summaries. |
| `ai-backend/ai-engine/code_intel/rag/macro/query_analyzer.py` | 14 | Query Analyzer — Extracts structured information from a raw user query. |
| `ai-backend/ai-engine/code_intel/rag/macro/summary_searcher.py` | 5 | Summary Searcher — Vector similarity search over document summaries. |
| `ai-backend/ai-engine/code_intel/rag/micro/__init__.py` | 564 | Micro-Navigation Package (Step 3) |
| `ai-backend/ai-engine/code_intel/rag/micro/page_resolver.py` | 7 | Page Resolver — Maps section references to precise content locations. |
| `ai-backend/ai-engine/code_intel/rag/micro/relevance_scorer.py` | 8 | Relevance Scorer — Score section relevance to a query. |
| `ai-backend/ai-engine/code_intel/rag/micro/section_extractor.py` | 9 | Section Extractor — Extract precise section content from documents. |
| `ai-backend/ai-engine/code_intel/rag/micro/section_reranker.py` | 12 | Section Reranker — Improve precision of section ranking before MMR/synthesis. |
| `ai-backend/ai-engine/code_intel/rag/micro/tree_navigator.py` | 21 | Tree Navigator — Single-shot LLM-guided ToC tree traversal. |
| `ai-backend/ai-engine/code_intel/rag/observability/__init__.py` | 491 | Observability subsystem for the RAG pipeline. |
| `ai-backend/ai-engine/code_intel/rag/observability/tracing.py` | 8 | Tracing primitives for the RAG pipeline. |
| `ai-backend/ai-engine/code_intel/rag/pipeline.py` | 74 | RAG Pipeline — Main orchestrator connecting all 4 steps. |

## asset

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/code_intel/rag/py.typed` | 0 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/code_intel/rag/store/__init__.py` | 433 | Store sub-package for the RAG subsystem. |
| `ai-backend/ai-engine/code_intel/rag/store/document_store.py` | 10 | Document Store — Persistent storage for documents and metadata. |
| `ai-backend/ai-engine/code_intel/rag/store/section_store.py` | 11 | Section Store — Persistent storage for document sections. |
| `ai-backend/ai-engine/code_intel/rag/store/summary_index.py` | 12 | Summary Index — Fast vector index for document summaries. |
| `ai-backend/ai-engine/code_intel/rag/store/toc_store.py` | 5 | ToC Store — Persistent storage for Table of Contents trees. |
| `ai-backend/ai-engine/code_intel/rag/synthesis/__init__.py` | 575 | Synthesis Package (Step 4) |
| `ai-backend/ai-engine/code_intel/rag/synthesis/answer_synthesizer.py` | 14 | Answer Synthesizer — Generate final cited answer using a heavy model. |
| `ai-backend/ai-engine/code_intel/rag/synthesis/citation_tracker.py` | 9 | Citation Tracker — Track provenance from answer to source sections. |
| `ai-backend/ai-engine/code_intel/rag/synthesis/confidence_scorer.py` | 8 | Confidence Scorer — Score overall answer quality and confidence. |
| `ai-backend/ai-engine/code_intel/rag/synthesis/context_builder.py` | 9 | Context Builder — Assemble context from extracted sections for synthesis. |
| `ai-backend/ai-engine/code_intel/rag/tests/__init__.py` | 35 | Tests for the RAG subsystem. |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/code_intel/rag/tests/conftest.py` | 2 | Pytest configuration for RAG test suite. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_answer_synthesizer.py` | 3 | Tests for answer synthesizer. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_api.py` | 1 | Tests for RAG API endpoints. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_async_ingest.py` | 2 | Tests for async ingestion job tracking. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_citation_tracker.py` | 3 | Tests for citation tracker. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_confidence_scorer.py` | 3 | Tests for confidence scorer. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_config.py` | 2 | Tests for RAG configuration. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_content_hasher.py` | 1 | Tests for content hasher. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_context_builder.py` | 2 | Tests for context builder. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_document_loader.py` | 3 | Tests for document loader. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_document_ranker.py` | 4 | Tests for document ranker. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_document_store.py` | 2 | Tests for document store. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_incremental_ingest.py` | 3 | Tests for incremental ingestion via the content_hash skip path. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_keyword_filter.py` | 2 | Tests for keyword filter (BM25). |
| `ai-backend/ai-engine/code_intel/rag/tests/test_observability.py` | 2 | Tests for the RAG observability tracer. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_page_resolver.py` | 2 | Tests for page resolver. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_pipeline.py` | 2 | Tests for RAG pipeline. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_query_analyzer.py` | 3 | Tests for query analyzer. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_relevance_scorer.py` | 3 | Tests for relevance scorer. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_section_extractor.py` | 2 | Tests for section extractor. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_section_reranker.py` | 5 | Tests for SectionReranker (rule-based backend). |
| `ai-backend/ai-engine/code_intel/rag/tests/test_section_splitter.py` | 3 | Tests for section splitter and summary generator. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_section_store.py` | 3 | Tests for section store. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_summary_index.py` | 2 | Tests for summary index. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_summary_searcher.py` | 2 | Tests for summary searcher. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_toc_extractor.py` | 3 | Tests for ToC extractor. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_toc_store.py` | 2 | Tests for ToC store. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_tree_navigator.py` | 3 | Tests for tree navigator. |
| `ai-backend/ai-engine/code_intel/rag/tests/test_types.py` | 7 | Tests for RAG type definitions. |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/code_intel/rag/types.py` | 26 | Core type definitions for the RAG subsystem. |
| `ai-backend/ai-engine/code_intel/retrieval/__init__.py` | 2 | Query-time Context Assembly Module |
| `ai-backend/ai-engine/code_intel/retrieval/budget_enforcer.py` | 12 | Budget Enforcer - Enforce hard token limits. |
| `ai-backend/ai-engine/code_intel/retrieval/context_assembler.py` | 13 | Context Assembler - Assemble final context for the LLM. |
| `ai-backend/ai-engine/code_intel/retrieval/controller.py` | 16 | Deterministic Retrieval Controller - Non-LLM context decision maker. |
| `ai-backend/ai-engine/code_intel/retrieval/fusion.py` | 5 | Reciprocal Rank Fusion (RRF) + Maximal Marginal Relevance (MMR). |
| `ai-backend/ai-engine/code_intel/retrieval/graph_expander.py` | 16 | Graph Expander - Expand candidates via dependency graph. |
| `ai-backend/ai-engine/code_intel/retrieval/grounding_verifier.py` | 1 | Structured Grounding Verifier |
| `ai-backend/ai-engine/code_intel/retrieval/pipeline.py` | 54 | Retrieval Pipeline - Orchestrate the complete context assembly flow. |
| `ai-backend/ai-engine/code_intel/retrieval/query_processor.py` | 11 | Query Processor - Parse and prepare user queries for retrieval. |
| `ai-backend/ai-engine/code_intel/retrieval/query_rewriter.py` | 12 | Query rewriter — boosts RAG recall with two complementary techniques. |
| `ai-backend/ai-engine/code_intel/retrieval/ranker.py` | 17 | Context Ranker - Rank and prioritize retrieval candidates. |
| `ai-backend/ai-engine/code_intel/retrieval/reranker.py` | 18 | Lightweight Reranker - Reduce false positives in retrieval results. |
| `ai-backend/ai-engine/code_intel/retrieval/retriever.py` | 21 | Context Retriever - Vector search and initial candidate selection. |
| `ai-backend/ai-engine/code_intel/retrieval/spec_index.py` | 6 | Spec Index - Lightweight spec layer from docs/tests. |
| `ai-backend/ai-engine/code_intel/retrieval/tests/__init__.py` | 0 | py file: __init__.py |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/code_intel/retrieval/tests/test_fusion.py` | 3 | Smoke tests for retrieval/fusion.py — RRF + MMR helpers. |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/code_intel/routing/change_impact.py` | 2 | Change Impact Model - Learn co-change neighborhoods from git history. |
| `ai-backend/ai-engine/code_intel/routing/intent_classifier.py` | 2 | defines `IntentClassifier` |
| `ai-backend/ai-engine/code_intel/routing/project_dna.py` | 1 | Project DNA - Lightweight learned routing signal from repo structure. |
| `ai-backend/ai-engine/code_intel/routing/router.py` | 6 | defines `QueryRouter` |
| `ai-backend/ai-engine/code_intel/routing/types.py` | 866 | defines `QueryIntent` |
| `ai-backend/ai-engine/code_intel/summaries/__init__.py` | 763 | Hierarchical Summaries Module - Compression Layer |
| `ai-backend/ai-engine/code_intel/summaries/facts_store.py` | 5 | Facts Store - Lightweight structured memory extracted from code. |
| `ai-backend/ai-engine/code_intel/summaries/file_summarizer.py` | 9 | File Summarizer - Generate concise summaries for individual files. |
| `ai-backend/ai-engine/code_intel/summaries/module_summarizer.py` | 2 | defines `ModuleSummarizer` |
| `ai-backend/ai-engine/code_intel/summaries/repo_summarizer.py` | 12 | Repository Summarizer - Generate high-level repository overview. |
| `ai-backend/ai-engine/code_intel/summaries/summary_store.py` | 23 | Summary Store - Persistence layer for file and repo summaries. |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/code_intel/tests/test_fingerprint.py` | 1 | defines `test_fingerprint_whitespace_only` |
| `ai-backend/ai-engine/code_intel/tests/test_page_index.py` | 0 | py file: test_page_index.py |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/code_intel/tools/__init__.py` | 1 | Tool-driven Exploration Module |
| `ai-backend/ai-engine/code_intel/tools/evaluation.py` | 15 | Evaluation Harness for Code Intelligence. |
| `ai-backend/ai-engine/code_intel/tools/separation.py` | 19 | Tool Separation - Clear distinction between read and edit tools. |
| `ai-backend/ai-engine/code_intel/tools/tool_executor.py` | 11 | Tool Executor - Execute tool calls from the LLM. |
| `ai-backend/ai-engine/code_intel/tools/tool_registry.py` | 9 | Tool Registry - Tool definitions for LLM function calling. |
| `ai-backend/ai-engine/code_intel/tools/tools.py` | 22 | Exploration Tools - Core tool implementations. |
| `ai-backend/ai-engine/diff_patch_helpers.py` | 27 | Diff-patch prompt builder + edit-list validator (extracted from main.py). |
| `ai-backend/ai-engine/gpu_hmr/__init__.py` | 2 | GPU HMR contract helpers for identity, hashing, and projections. |
| `ai-backend/ai-engine/gpu_hmr/api.py` | 5 | FastAPI routes for GPU HMR split-broker resources. |
| `ai-backend/ai-engine/gpu_hmr/broker.py` | 41 | In-process GPU HMR split-broker resource ledger. |
| `ai-backend/ai-engine/gpu_hmr/canonical.py` | 7 | Canonical JSON hashing for GPU HMR identity material. |
| `ai-backend/ai-engine/gpu_hmr/contracts.py` | 9 | GPU HMR split-broker identity and manifest contracts. |
| `ai-backend/ai-engine/gpu_hmr/metadata.py` | 19 | Compile-aware target metadata adapter for GPU HMR. |
| `ai-backend/ai-engine/gpu_hmr/projection.py` | 6 | Target-scoped GPU HMR projection builder. |
| `ai-backend/ai-engine/gpu_hmr/reason_codes.json` | 55 | JSON data (reason_codes.json) |
| `ai-backend/ai-engine/gpu_hmr/reason_codes.py` | 2 | Versioned GPU HMR reason-code registry. |
| `ai-backend/ai-engine/intelligence/__init__.py` | 1 | Intelligence Aggregator - Unified Code Intelligence Pipeline |
| `ai-backend/ai-engine/intelligence/aggregator.py` | 14 | Intelligence Aggregator - The Hub for Code Intelligence |
| `ai-backend/ai-engine/intelligence/compiler_parsers.py` | 15 | Compiler Output Parsers - Convert stderr/logs to line-specific diagnostics |
| `ai-backend/ai-engine/intelligence/compiler_provider.py` | 6 | Compiler Provider - Layer B Semantic Analysis |
| `ai-backend/ai-engine/intelligence/file_watcher.py` | 8 | File Watcher - Server-Side File Change Detection |
| `ai-backend/ai-engine/intelligence/providers.py` | 15 | DiagnosticProvider Interface and Types |
| `ai-backend/ai-engine/job_queue.py` | 26 | Priority Job Queue for AI Engine |

## asset

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/llm/.gitignore` | 25 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/llm/prompts.py` | 196 | You are an expert developer, with much experience in the industry. When presented with a prompt, apply this methodology: |
| `ai-backend/ai-engine/llm/providers/__init__.py` | 104 | imports .factory |
| `ai-backend/ai-engine/llm/providers/anthropic_provider.py` | 3 | Anthropic provider — used by the Wave 2 multi-provider cross-validation. |
| `ai-backend/ai-engine/llm/providers/base.py` | 2 | defines `_utc_now_iso` |
| `ai-backend/ai-engine/llm/providers/chatgpt.py` | 7 | Lazy import to avoid circular dependencies. |
| `ai-backend/ai-engine/llm/providers/factory.py` | 1 | Provider factory. |
| `ai-backend/ai-engine/llm/providers/gemini.py` | 26 | Count tokens using tiktoken when available, fallback to word split. |
| `ai-backend/ai-engine/llm/providers/openai_provider.py` | 4 | OpenAI provider — used by the Wave 2 multi-provider cross-validation. |
| `ai-backend/ai-engine/llm/structural_prompts.py` | 5 | HEAL prompt for fast HMR compilation-error repair. |
| `ai-backend/ai-engine/main.py` | 179 | PROTOTYPING AI ENGINE WITH PYTHON, LATER SWITCH TO RUST |
| `ai-backend/ai-engine/mcp-counter-1776526851287/.code_intel/chunking_version.txt` | 1 | txt file: chunking_version.txt |
| `ai-backend/ai-engine/mcp-counter-1776526851287/.code_intel/index_generation.txt` | 13 | txt file: index_generation.txt |
| `ai-backend/ai-engine/mcp-counter-1776526851287/.code_intel/summaries/summary_metadata.json` | 137 | JSON data (summary_metadata.json) |
| `ai-backend/ai-engine/mcp-counter-1776526851287/.synthi/rag/doc_content/21f0b7c77353ec5ed7edf669.txt` | 1 | txt file: 21f0b7c77353ec5ed7edf669.txt |
| `ai-backend/ai-engine/mcp-counter-1776526851287/.synthi/rag/doc_content/46eede2908558aba2b3b999e.txt` | 37 | mcp-counter-1776526851287\.code_intel |
| `ai-backend/ai-engine/mcp-counter-1776526851287/.synthi/rag/doc_content/f3001cf84d285b230cc9ca3b.txt` | 13 | txt file: f3001cf84d285b230cc9ca3b.txt |
| `ai-backend/ai-engine/mcp-counter-1776526851287/.synthi/rag/documents.json` | 1 | JSON data (documents.json) |
| `ai-backend/ai-engine/mcp-counter-1776526851287/.synthi/rag/keyword_index.json` | 3 | JSON data (keyword_index.json) |
| `ai-backend/ai-engine/mcp-counter-1776526851287/.synthi/rag/summaries.json` | 1 | JSON data (summaries.json) |

## asset

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/mcp-counter-1776526851287/.synthi/rag/summary_vectors.npz` | 36 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/mcp-counter-1776526851287/.synthi/rag/toc_trees.json` | 1 | JSON data (toc_trees.json) |
| `ai-backend/ai-engine/metrics.py` | 29 | Comprehensive Metrics Collection for AI Engine |
| `ai-backend/ai-engine/program_manifest_gen.py` | 2 | Generate a vectant.programs.json manifest from workspace context (Gemini). |
| `ai-backend/ai-engine/program_review.py` | 3 | Community-app submission risk review (Phase 2, advisory). |
| `ai-backend/ai-engine/provenance.py` | 15 | AI Change Provenance Tracking |
| `ai-backend/ai-engine/requirements.txt` | 128 | google-generativeai==0.8.4 |
| `ai-backend/ai-engine/run_server.py` | 1 | Runtime entrypoint for the AI engine service. |
| `ai-backend/ai-engine/shadow/__init__.py` | 763 | Synthi Genome — shadow verification subsystem. |
| `ai-backend/ai-engine/shadow/agent_execution.py` | 6 | Hardened Docker launcher for live-workspace coding agents. |
| `ai-backend/ai-engine/shadow/api.py` | 23 | Shadow verification HTTP endpoints. Master plan §5. |
| `ai-backend/ai-engine/shadow/arbiter.py` | 22 | Cross-universe Arbiter. Master plan §6.4 + §11. |
| `ai-backend/ai-engine/shadow/branch_fossil.py` | 1 | Create bounded durable fossils from normalized branch telemetry. |
| `ai-backend/ai-engine/shadow/branch_trace.py` | 4 | BranchTrace normalization for existing shadow universe results. |
| `ai-backend/ai-engine/shadow/choice_scene.py` | 4 | ChoiceScene capture and deterministic counterfactual strength. |
| `ai-backend/ai-engine/shadow/claude_code_runner.py` | 1013 | Claude Code runner adapter. |
| `ai-backend/ai-engine/shadow/closure_crossover.py` | 11 | Closure-aware fragment crossover. Master plan §18 + §22 (Wave 5). |
| `ai-backend/ai-engine/shadow/codesite_agent_workspace.py` | 4 | Isolated, auditable worktrees for CodeSite-managed agent runs. |
| `ai-backend/ai-engine/shadow/codesite_control_plane.py` | 6 | Minimal fail-closed authority checks for CodeSite-managed agent runs. |
| `ai-backend/ai-engine/shadow/codesite_finalizer.py` | 5 | Trusted, fail-closed landing of a CodeSite agent worktree. |
| `ai-backend/ai-engine/shadow/codex_runner.py` | 1 | Codex runner adapter. |
| `ai-backend/ai-engine/shadow/convergence.py` | 3 | Convergence detection. Master plan §12. |
| `ai-backend/ai-engine/shadow/cost_ledger.py` | 5 | Per-workspace spend ledger for shadow verify jobs. Master plan §17. |
| `ai-backend/ai-engine/shadow/counterfactual_store.py` | 3 | In-memory store for counterfactual telemetry v1. |
| `ai-backend/ai-engine/shadow/counterfactual_types.py` | 10 | Counterfactual telemetry contracts for shadow execution. |
| `ai-backend/ai-engine/shadow/critic.py` | 9 | Adversarial Critic. Master plan §6.2. |
| `ai-backend/ai-engine/shadow/critic_critic.py` | 7 | Pedantry filter on top of the Critic. Master plan §6.3. |
| `ai-backend/ai-engine/shadow/crossover.py` | 9 | Change-level crossover. Master plan §3 + §18 + §22 (Wave 3). |
| `ai-backend/ai-engine/shadow/detector_results.py` | 5 | Normalize existing shadow diagnostics into detector telemetry. |
| `ai-backend/ai-engine/shadow/events.py` | 5 | SSE event types streamed on /shadow/{jobId}/stream. |
| `ai-backend/ai-engine/shadow/execution_niche_map.py` | 2 | Execution Niche Map aggregation from active policy deltas. |
| `ai-backend/ai-engine/shadow/generator.py` | 8 | LLM patch Generator. Master plan §6.1. |
| `ai-backend/ai-engine/shadow/hermes_runner.py` | 1 | Hermes Agent runner adapter with an explicit non-interactive write contract. |
| `ai-backend/ai-engine/shadow/live_workspace_lock.py` | 1 | Process-safe serialization for live workspace agent mutations. |
| `ai-backend/ai-engine/shadow/multiverse.py` | 25 | Orchestrator. Master plan §3 + §4. |
| `ai-backend/ai-engine/shadow/policy_delta.py` | 2 | PolicyDelta helpers and in-memory workspace store. |
| `ai-backend/ai-engine/shadow/post_selection_mutation.py` | 3 | Deterministic, non-retentive summary of edits made after branch apply. |
| `ai-backend/ai-engine/shadow/preference.py` | 12 | Few-shot preference learning. Master plan §13 (Wave 4). |
| `ai-backend/ai-engine/shadow/project_signals.py` | 8 | Project signal detection for Critic-Critic calibration. Master plan §6.3. |
| `ai-backend/ai-engine/shadow/proof_arbiter.py` | 2 | Proof Arbiter: hard-gate correctness before selection fit or novelty. |
| `ai-backend/ai-engine/shadow/regression_log.py` | 1 | Snapshots accepted patches' tests so future runs catch regressions. |
| `ai-backend/ai-engine/shadow/regret_arbiter.py` | 4 | Regret Arbiter: deterministic lessons after real selection. |
| `ai-backend/ai-engine/shadow/regret_memory_markdown.py` | 6 | Hidden markdown persistence for compact Regret Memory. |
| `ai-backend/ai-engine/shadow/runner/__init__.py` | 454 | Per-language runners. Master plan §9. |
| `ai-backend/ai-engine/shadow/runner/base.py` | 5 | Runner protocol. Master plan §9. |
| `ai-backend/ai-engine/shadow/runner/go.py` | 3 | Go toolchain. Master plan §9 row 4 (Wave 3). |
| `ai-backend/ai-engine/shadow/runner/html.py` | 3 | HTML / CSS toolchain. Master plan §9 row 6 (Wave 3). |
| `ai-backend/ai-engine/shadow/runner/node.py` | 13 | Node.js / TypeScript toolchain. Master plan §9. |
| `ai-backend/ai-engine/shadow/runner/python.py` | 5 | Python toolchain: ruff + mypy + pytest. Master plan §9. |
| `ai-backend/ai-engine/shadow/runner/rust.py` | 3 | Rust toolchain. Master plan §9 row 5 (Wave 3). |
| `ai-backend/ai-engine/shadow/runner/syntax.py` | 2 | Tree-sitter parse-only fallback. Master plan §9. |
| `ai-backend/ai-engine/shadow/runner_base.py` | 15 | Runner adapter contract for counterfactual branch telemetry. |
| `ai-backend/ai-engine/shadow/scoring.py` | 2 | Composite scoring per master plan §10. |
| `ai-backend/ai-engine/shadow/selection_arbiter.py` | 1 | Selection Arbiter: rank only branches that survived proof gates. |
| `ai-backend/ai-engine/shadow/snapshot.py` | 7 | Snapshot + 3-way merge + AI-rebase fallback (master plan §8). |
| `ai-backend/ai-engine/shadow/telemetry_api.py` | 34 | Public counterfactual control-plane API backed by durable workspace telemetry. |
| `ai-backend/ai-engine/shadow/telemetry_repository.py` | 17 | Durable, bounded counterfactual telemetry for one workspace. |
| `ai-backend/ai-engine/shadow/universe.py` | 16 | One universe = (Generator + Critic + Runner) producing one patch and |
| `ai-backend/ai-engine/shadow/universe_planner.py` | 2 | Universe planning with counterfactual policy injection. |
| `ai-backend/ai-engine/shadow/workspace_write_policy.py` | 3 | Live-workspace mutation policy and evidence capture. |
| `ai-backend/ai-engine/shadow/worktree.py` | 5 | Pre-warmed git worktree pool + dep-install serialization. |
| `ai-backend/ai-engine/shadow_continuous/__init__.py` | 823 | Continuous shadow. Master plan §14 (Wave 4). |
| `ai-backend/ai-engine/shadow_continuous/api.py` | 2 | FastAPI router for continuous shadow. Master plan §14. |
| `ai-backend/ai-engine/shadow_continuous/preference_store.py` | 2 | Workspace-level continuous-shadow settings + spend tracking. |
| `ai-backend/ai-engine/shadow_continuous/regression_runner.py` | 4 | Pass→fail regression runner for continuous shadow. Master plan §14. |
| `ai-backend/ai-engine/shadow_continuous/watcher.py` | 4 | Workspace-level debouncer + scheduler for continuous shadow. |
| `ai-backend/ai-engine/split_verifier.py` | 37 | AI Split Structural Verifier |
| `ai-backend/ai-engine/streaming.py` | 18 | Real Token Streaming with Provider Support |
| `ai-backend/ai-engine/test/.code_intel/chunking_version.txt` | 1 | txt file: chunking_version.txt |
| `ai-backend/ai-engine/test/.code_intel/index_generation.txt` | 13 | txt file: index_generation.txt |
| `ai-backend/ai-engine/test/.code_intel/summaries/summary_metadata.json` | 137 | JSON data (summary_metadata.json) |
| `ai-backend/ai-engine/test/.code_intel_current_gen.txt` | 16 | txt file: .code_intel_current_gen.txt |
| `ai-backend/ai-engine/test/.synthi/rag/keyword_index.json` | 63 | JSON data (keyword_index.json) |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/test/test_agentic_healing.py` | 30 | Unit tests for the agentic self-healing subsystem. |
| `ai-backend/ai-engine/test/test_ai_deps.py` | 6 | Tests for the dependency graph (ai_deps.py). |
| `ai-backend/ai-engine/test/test_ai_fix_utils.py` | 5 | Tests for ai_fix_utils.py — deduplication, grouping, sorting. |
| `ai-backend/ai-engine/test/test_ai_policy.py` | 6 | Tests for ai_policy.py — AISuppressionPolicy store. |
| `ai-backend/ai-engine/test/test_ai_prompt_cache.py` | 2 | Tests for ai_prompt_cache.py — LRU cache, TTL, eviction, stats. |
| `ai-backend/ai-engine/test/test_ai_prompts.py` | 4 | Tests for ai_prompts.py — prompt construction. |
| `ai-backend/ai-engine/test/test_ai_streaming.py` | 5 | Tests for ai_streaming.py — SSE event generation. |
| `ai-backend/ai-engine/test/test_ai_telemetry.py` | 3 | Tests for ai_telemetry.py — timing, counters, errors. |
| `ai-backend/ai-engine/test/test_batch_engine.py` | 4 | Unit tests for the batch healing engine. |
| `ai-backend/ai-engine/test/test_cache.py` | 3 | Unit tests for the healing result cache. |
| `ai-backend/ai-engine/test/test_engine.py` | 10 | Unit tests for the SelfHealingEngine and HealingClassifier. |
| `ai-backend/ai-engine/test/test_failure_distiller.py` | 42 | defines `run` |
| `ai-backend/ai-engine/test/test_failure_distiller_adapters.py` | 4 | defines `test_browser_adapter_requires_replayable_trace_contract` |
| `ai-backend/ai-engine/test/test_failure_distiller_api.py` | 5 | Inject the hermetic local executor only for HTTP route fixtures. |
| `ai-backend/ai-engine/test/test_failure_distiller_benchmark.py` | 702 | defines `test_versioned_failure_distiller_benchmark_meets_release_gates` |
| `ai-backend/ai-engine/test/test_failure_distiller_isolation.py` | 10 | defines `docker_ready` |
| `ai-backend/ai-engine/test/test_hmr_lightning.py` | 17 | HMR Lightning Ultraplan — Python-side tests. |
| `ai-backend/ai-engine/test/test_integration_healing.py` | 4 | Integration tests for the self-healing pipeline. |
| `ai-backend/ai-engine/test/test_manifest_reference.py` | 1 | Feature B: the ai-engine base prompt teaches the model about vectant.programs.json. |
| `ai-backend/ai-engine/test/test_program_manifest_gen.py` | 2 | Tests for vectant.programs.json manifest generation (Gemini). |
| `ai-backend/ai-engine/test/test_program_review.py` | 3 | Tests for community-app risk assessment (Phase 2, advisory). |
| `ai-backend/ai-engine/test/test_rule_registry.py` | 2 | Unit tests for the self-healing rule registry and universal rules. |
| `ai-backend/ai-engine/test/test_universal_rules.py` | 6 | Unit tests for individual universal healing rules. |
| `ai-backend/ai-engine/test/test_verifier.py` | 1019 | Regression tests for AIOutputVerifier. |
| `ai-backend/ai-engine/test_gemini_direct.py` | 9 | Direct Gemini REST API test — bypasses google-generativeai SDK entirely. |
| `ai-backend/ai-engine/test_include_link_validator.py` | 18 | Unit tests for the generic include→link validator (ULTRAPLAN Phase 4.5). |
| `ai-backend/ai-engine/test_phase2_live.py` | 18 | Phase 2 live integration test — hits the running ai-engine. |
| `ai-backend/ai-engine/test_phase2_unit.py` | 16 | Phase 2 unit tests — no network, no services, just Python. |
| `ai-backend/ai-engine/test_phase4_live.py` | 22 | Phase 4 live integration test — hits the running ai-engine and validates |
| `ai-backend/ai-engine/test_phase5_diff_patch_prompt.py` | 15 | Phase 5 (ULTRAPLAN) — Tier 2 4-module diff_patch tests. |
| `ai-backend/ai-engine/test_phase6_manifest_heal.py` | 17 | Phase 6 (ULTRAPLAN) — manifest heal prompt + response parser tests. |
| `ai-backend/ai-engine/test_universal_split_dryrun.py` | 37 | Phase 1 dry-run: universal split prompt + 5 test inputs covering the four |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/tests/corpus/01_sdl2_button.cpp` | 975 | Phase 7 corpus — SDL2 happy path |
| `ai-backend/ai-engine/tests/corpus/02_glfw_triangle.cpp` | 959 | Phase 7 corpus — GLFW + raw OpenGL (second library, agnostic check) |
| `ai-backend/ai-engine/tests/corpus/03_custom_engine_with_hint.cpp` | 716 | Phase 7 corpus — custom engine with explicit // LINK: hint |
| `ai-backend/ai-engine/tests/corpus/04_macro_main_wxwidgets.cpp` | 548 | Phase 7 corpus — wxWidgets IMPLEMENT_APP macro hides main() |
| `ai-backend/ai-engine/tests/corpus/05_fmod_hostile.cpp` | 1 | Phase 7 corpus — FMOD + SDL2 (hot-reload hostile) |
| `ai-backend/ai-engine/tests/corpus/06_sfml_sprite.cpp` | 876 | Phase 7 corpus — SFML (class-based C++ API) |
| `ai-backend/ai-engine/tests/corpus/07_raylib_circle.cpp` | 634 | Phase 7 corpus — raylib (self-contained library, minimal deps) |
| `ai-backend/ai-engine/tests/corpus/08_imgui_sdl.cpp` | 2 | Phase 7 corpus — ImGui + SDL2 + OpenGL (stacked libraries) |
| `ai-backend/ai-engine/tests/corpus/09_sokol_pixel.cpp` | 1 | Phase 7 corpus — sokol (minimal, header-only graphics) |
| `ai-backend/ai-engine/tests/corpus/10_console_app.cpp` | 749 | Phase 7 corpus — no graphics, console-only app |
| `ai-backend/ai-engine/tests/corpus/11_qt_with_moc.cpp` | 1 | Phase 7 corpus — Qt with Q_OBJECT (multi-step build — rejects) |
| `ai-backend/ai-engine/tests/corpus/README.md` | 4 | Universal Split Corpus — ULTRAPLAN Phase 7 |
| `ai-backend/ai-engine/tests/corpus/expected.json` | 3 | JSON data (expected.json) |

## test

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/tests/test_abi_stamper.py` | 1 | __constant__ float alpha[1]; |
| `ai-backend/ai-engine/tests/test_agent_execution.py` | 3 | defines `test_agent_container_has_only_a_bounded_workspace_and_no_privilege` |
| `ai-backend/ai-engine/tests/test_agent_runner_image.py` | 545 | defines `test_agent_image_copies_readonly_credentials_to_ephemeral_storage` |
| `ai-backend/ai-engine/tests/test_branch_trace_normalization.py` | 1 | defines `FakeUniverseResult` |
| `ai-backend/ai-engine/tests/test_choice_scene_strength.py` | 3 | defines `_trace` |
| `ai-backend/ai-engine/tests/test_claude_code_runner_trace_shape.py` | 1 | defines `test_claude_code_runner_trace_shape` |
| `ai-backend/ai-engine/tests/test_codesite_agent_workspace.py` | 4 | defines `_git` |
| `ai-backend/ai-engine/tests/test_codesite_control_plane.py` | 3 | defines `_binding` |
| `ai-backend/ai-engine/tests/test_codesite_finalizer.py` | 3 | defines `git` |
| `ai-backend/ai-engine/tests/test_codex_runner_trace_shape.py` | 1 | defines `test_codex_runner_trace_shape` |
| `ai-backend/ai-engine/tests/test_counterfactual_runtime_integration.py` | 6 | defines `FakeUniverseResult` |
| `ai-backend/ai-engine/tests/test_counterfactual_store.py` | 3 | defines `_trace` |
| `ai-backend/ai-engine/tests/test_counterfactual_types.py` | 1 | defines `test_branch_trace_serializes_enum_values` |
| `ai-backend/ai-engine/tests/test_detector_result_schema.py` | 1 | defines `test_detector_result_schema_marks_failed_tests_as_hard_gate` |
| `ai-backend/ai-engine/tests/test_failed_detector_blocks_proof_win.py` | 1 | defines `_trace` |
| `ai-backend/ai-engine/tests/test_gemini_provider.py` | 5 | Unit tests for Gemini provider model fallback selection. |
| `ai-backend/ai-engine/tests/test_gpu_build_manifest.py` | 25 | Unit tests for the GPU sub-block in BuildManifest. |
| `ai-backend/ai-engine/tests/test_gpu_detect.py` | 6 | Unit tests for agents/gpu_detect.py. |
| `ai-backend/ai-engine/tests/test_gpu_device_mapping.py` | 14 | namespace gpu::kernels { |
| `ai-backend/ai-engine/tests/test_gpu_device_mapping_scope.py` | 1 | defines `test_device_mapping_scope_expands_local_device_includes` |
| `ai-backend/ai-engine/tests/test_gpu_device_markers.py` | 1 | // PROJECT_DEVICE_API void ignored(); |
| `ai-backend/ai-engine/tests/test_gpu_error_triage.py` | 813 | defines `test_hard_compile_error_routes_to_compile_prompt` |
| `ai-backend/ai-engine/tests/test_gpu_healer.py` | 1 | defines `test_build_heal_prompt_selects_runtime_prompt_and_restart_flag` |
| `ai-backend/ai-engine/tests/test_gpu_hmr_broker_api.py` | 13 | defines `_client` |
| `ai-backend/ai-engine/tests/test_gpu_hmr_canonical.py` | 2 | defines `test_canonical_json_sorts_object_keys_without_reordering_ordered_arrays` |
| `ai-backend/ai-engine/tests/test_gpu_hmr_contracts.py` | 5 | defines `copy_model` |
| `ai-backend/ai-engine/tests/test_gpu_hmr_metadata.py` | 4 | defines `_cmake_files` |
| `ai-backend/ai-engine/tests/test_gpu_hmr_projection.py` | 4 | defines `_files` |
| `ai-backend/ai-engine/tests/test_gpu_hmr_reason_codes.py` | 5 | defines `test_reason_code_registry_loads_required_metadata` |
| `ai-backend/ai-engine/tests/test_gpu_launch_indirection.py` | 2 | defines `test_launch_indirection_report_accepts_public_wrapper` |
| `ai-backend/ai-engine/tests/test_gpu_mod_delta.py` | 25 | defines `complete_output_oracle_proposal` |
| `ai-backend/ai-engine/tests/test_gpu_source_context.py` | 35 | defines `test_source_context_records_included_and_dropped_reasons` |
| `ai-backend/ai-engine/tests/test_gpu_split_repair.py` | 106 | defines `test_heal_sanitizer_removes_missing_project_toolkit_include_and_calls` |
| `ai-backend/ai-engine/tests/test_hermes_runner_trace_shape.py` | 910 | defines `test_hermes_runner_uses_noninteractive_safe_contract` |
| `ai-backend/ai-engine/tests/test_hunk_applier.py` | 3 | Unit tests for the hunk applier. |
| `ai-backend/ai-engine/tests/test_incremental_hunks_e2e.py` | 6 | End-to-end integration test for hunk-based incremental analysis. |
| `ai-backend/ai-engine/tests/test_incremental_hunks_http.py` | 5 | HTTP-layer regression tests for hunk-based incremental analysis. |
| `ai-backend/ai-engine/tests/test_kernel_splitter.py` | 44 | Unit tests for agents/kernel_splitter.py — parser + prompt build. |
| `ai-backend/ai-engine/tests/test_launch_graph_extractor.py` | 4 | void step() { |
| `ai-backend/ai-engine/tests/test_live_workspace_lock.py` | 622 | defines `test_live_workspace_lock_rejects_a_second_concurrent_writer` |
| `ai-backend/ai-engine/tests/test_materialize_changes.py` | 4 | Tests for WorkspaceAnalyzer._materialize_changes. |
| `ai-backend/ai-engine/tests/test_openapi_schema.py` | 385 | defines `test_ai_engine_generates_openapi_schema_with_runtime_healing_request` |
| `ai-backend/ai-engine/tests/test_policy_delta_changes_universe_plan.py` | 993 | defines `test_policy_delta_changes_universe_plan` |
| `ai-backend/ai-engine/tests/test_policy_delta_decay.py` | 1 | defines `test_policy_delta_expires_out_of_active_policy` |
| `ai-backend/ai-engine/tests/test_policy_delta_schema.py` | 802 | defines `test_policy_delta_schema_serializes_status_and_kind` |
| `ai-backend/ai-engine/tests/test_post_selection_mutation.py` | 1 | defines `test_post_selection_mutation_never_retains_source_and_scores_removed_abstraction` |
| `ai-backend/ai-engine/tests/test_provider_model_provenance.py` | 1 | defines `test_provider_model_provenance_records_required_unknown_status_fields` |
| `ai-backend/ai-engine/tests/test_regret_arbiter_override_lesson.py` | 3 | defines `_trace` |
| `ai-backend/ai-engine/tests/test_regret_memory_markdown.py` | 2 | defines `test_appends_hidden_markdown_and_reloads_policy_delta` |
| `ai-backend/ai-engine/tests/test_run_server.py` | 2 | defines `isolated_entrypoint_env` |
| `ai-backend/ai-engine/tests/test_runner_contract.py` | 5 | defines `test_runner_contract_normalizes_artifact_without_inlining_logs` |
| `ai-backend/ai-engine/tests/test_telemetry_api.py` | 24 | defines `test_counterfactual_control_plane_persists_a_choice_and_changes_forecast` |
| `ai-backend/ai-engine/tests/test_universal_split.py` | 14 | ULTRAPLAN Phase 7 — universal split corpus test runner. |
| `ai-backend/ai-engine/tests/test_verifier_gpu.py` | 135 | Unit tests for verifier_gpu — the no-shim contract enforcer. |
| `ai-backend/ai-engine/tests/test_workspace_write_policy.py` | 2 | defines `test_protected_snapshot_detects_secret_and_control_plane_changes` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/ai-engine/vectant_repro.py` | 4 | Operator CLI for Failure Distiller capsules. |
| `ai-backend/ai-engine/verifier.py` | 32 | AI Output Verifier |
| `ai-backend/ai-engine/verifier_gpu.py` | 136 | Spec: docs/GPU_HMR_ULTRAPLAN.md §11.4. The host healer is allowed to |
| `ai-backend/ai-engine/vu4f06rp/.code_intel_current_gen.txt` | 20 | txt file: .code_intel_current_gen.txt |

## asset

| File | Bytes | Note |
|---|---|---|
| `ai-backend/ai-engine/vu4f06rp/.gitignore` | 100 | binary or generated artifact |
| `ai-backend/gateway/.dockerignore` | 31 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `ai-backend/gateway/Dockerfile` | 1 | Synthi IDE — AI Gateway (Node.js WebSocket proxy) |
| `ai-backend/gateway/package-lock.json` | 4 | JSON data (package-lock.json) |
| `ai-backend/gateway/package.json` | 495 | WebSocket gateway bridging the Synthi Next.js front end and Python AI engine. |
| `ai-backend/gateway/server.js` | 106 | ── PERF: Cluster mode ───────────────────────────────────────────────────── |
