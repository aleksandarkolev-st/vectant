# Agent Dojo Implementation Status

**Status:** source-of-truth maturity baseline  
**Date:** 2026-06-11  
**Scope:** current Agent Dojo implementation in `mcp/synthi-mcp`

This document prevents current scaffolded Vivarium Cortex artifacts from being mistaken for mature runtime subsystems. The machine-readable source lives in:

```text
mcp/synthi-mcp/src/dojo/status/implementation_status.ts
```

## Status Classes

| Status | Meaning |
|---|---|
| `executable` | The current code executes a real local behavior or enforces a current runtime path. |
| `deterministic_projection` | The current code builds useful deterministic artifacts from workflow contracts, traces, or stored skill data, but does not execute the mature runtime implied by the product term. |
| `report_only` | The current code returns a summary, dossier, plan, or view model. It is not an enforcement or execution subsystem. |
| `planned` | The capability is described in the plan but does not have a current implementation entry. |

## Current Honest Baseline

Agent Dojo currently implements a generic proof-gated competency core loop:

- workflow demonstration to `SkillSeed`
- workflow contract to `DojoSkill`
- deterministic scenarios and checkride reports
- license and proof capsule issuance/validation
- proof-gated backing private workflow tool execution
- repo artifact export
- compact UI status surface

It does not yet implement the full mature Vivarium Cortex universe:

- no executable Skill Cortex graph interpreter
- no disposable synthetic workplace with materialized fixtures
- no oracle-backed checkride over observed runtime evidence
- no authoritative append-only evidence ledger
- no KMS/HSM-backed proof service
- no tenant-aware production control plane
- no source/API substrate promotion runtime
- no enterprise graph editor or governance dashboard
- no deployed non-loopback MCP conformance proof

## Current Tool Classification

| Tool | Status |
|---|---|
| `synthi_dojo_list_competencies` | `executable` |
| `synthi_dojo_get_skill` | `deterministic_projection` |
| `synthi_dojo_get_skill_cortex` | `deterministic_projection` |
| `synthi_dojo_get_workspace_organoid` | `deterministic_projection` |
| `synthi_dojo_get_wind_tunnel_report` | `deterministic_projection` |
| `synthi_dojo_get_counterfactual_twin` | `deterministic_projection` |
| `synthi_dojo_get_evil_twin_report` | `deterministic_projection` |
| `synthi_dojo_get_training_report` | `report_only` |
| `synthi_dojo_get_skill_passport` | `report_only` |
| `synthi_dojo_get_skill_genome` | `report_only` |
| `synthi_dojo_get_antibodies` | `deterministic_projection` |
| `synthi_dojo_get_agent_ready_ui_contract` | `deterministic_projection` |
| `synthi_dojo_get_cost_policy` | `report_only` |
| `synthi_dojo_get_universe_dossier` | `report_only` |
| `synthi_dojo_get_lifecycle` | `report_only` |
| `synthi_dojo_get_governance_report` | `report_only` |
| `synthi_dojo_get_metrics` | `report_only` |
| `synthi_dojo_get_source_affordance_pr_plan` | `deterministic_projection` |
| `synthi_dojo_get_registry` | `report_only` |
| `synthi_dojo_get_skill_assurance_case` | `report_only` |
| `synthi_dojo_get_entrustment_level` | `deterministic_projection` |
| `synthi_dojo_get_license` | `executable` |
| `synthi_dojo_get_guardrails` | `deterministic_projection` |
| `synthi_dojo_get_case_law` | `deterministic_projection` |
| `synthi_dojo_explain_block` | `report_only` |
| `synthi_dojo_explain_failure` | `report_only` |
| `synthi_dojo_debug_counterfactual` | `deterministic_projection` |
| `synthi_dojo_run_time_machine_debugger` | `deterministic_projection` |
| `synthi_dojo_run_ghost_mode` | `report_only` |
| `synthi_dojo_request_permission_upgrade` | `report_only` |
| `synthi_dojo_generate_vivarium_scenarios` | `deterministic_projection` |
| `synthi_dojo_run_vivarium_scenario` | `deterministic_projection` |
| `synthi_dojo_run_wind_tunnel` | `deterministic_projection` |
| `synthi_dojo_run_checkride` | `deterministic_projection` |
| `synthi_dojo_publish_skill` | `executable` |
| `synthi_dojo_recertify_skill` | `deterministic_projection` |
| `synthi_dojo_get_license_health` | `executable` |
| `synthi_dojo_revoke_license` | `executable` |
| `synthi_dojo_record_case_law` | `executable` |
| `synthi_dojo_export_artifacts` | `executable` |
| `synthi_dojo_issue_proof_capsule` | `executable` |
| `synthi_dojo_validate_proof_capsule` | `executable` |
| `synthi_dojo_revoke_proof_capsule` | `executable` |
| `synthi_dojo_run_with_proof_capsule` | `executable` |

## Current Report Classification

| Report Or Artifact | Status |
|---|---|
| `skill_seed` | `deterministic_projection` |
| `skill_cortex` | `deterministic_projection` |
| `workspace_organoid` | `deterministic_projection` |
| `vivarium_scenarios` | `deterministic_projection` |
| `vivarium_run` | `deterministic_projection` |
| `wind_tunnel` | `deterministic_projection` |
| `checkride` | `deterministic_projection` |
| `case_law` | `deterministic_projection` |
| `guardrails` | `deterministic_projection` |
| `permission_license` | `executable` |
| `proof_capsule` | `executable` |
| `evidence_ledger` | `report_only` |
| `source_affordance_pr_plan` | `report_only` |
| `mcp_manifest` | `executable` |
| `universe_dossier` | `report_only` |

## Claim Boundary

Safe current claim:

```text
Agent Dojo implements a repo-local proof-gated competency core loop with deterministic
Vivarium Cortex artifacts, proof capsules, scoped licenses, repo exports, and MCP tool exposure.
```

Unsafe current claim:

```text
Agent Dojo implements a mature synthetic workplace runtime, evidence-backed checkride,
production evidence ledger, source/API graduation runtime, and enterprise governance system.
```
